import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TurnHandle } from "./engine.js";
import type { SessionRecord, SessionStore, StoredMessage } from "./sessions.js";
import { codexAvailable, runCodexTurn } from "./codex.js";
import { scheduleExtractionIfNeeded } from "./memory/scribe.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

/** GPT 首轮开场白（群规则、成员介绍、沉默协议）；每次现读，改文件不用重启 */
const INTRO_FILE = path.join(root, "prompts", "group_gpt_intro.md");

/** StoredMessage.speaker 里标记 GPT 的值 */
export const GPT_SPEAKER = "gpt";
/** Windows 单进程命令行上限约 32767 字符；给固定参数、图片路径和转义留足余量。 */
export const GPT_PROMPT_MAX_CHARS = 20_000;
const GPT_MESSAGE_MAX_CHARS = 3_000;

function speakerName(m: StoredMessage): string {
  if (m.role === "user") return "泽";
  return m.speaker === GPT_SPEAKER ? "GPT" : "麦穗";
}

/** 上传目录：跟 index.ts 同一套算法，附件的 file 字段都落在这里 */
const UPLOADS_DIR = path.join(path.resolve(process.env.WORKSPACE_DIR || path.join(root, "workspace")), "uploads");
const GPT_REBUILD_MAX_IMAGES = 6;

/** 把一条历史消息排成给 GPT 看的台词行；没内容（纯空消息）返回 null */
function lineFor(m: StoredMessage): string | null {
  if (m.text === "（拍了拍你）") return "泽：（拍了拍麦穗）";
  const att = (m.attachments || [])
    .map((a) => a.kind === "image"
      ? `[发来图片「${a.name}」，已附在本条消息里，你能直接看]`
      : `[发来文件「${a.name}」——你看不到内容，只知道有这么个东西]`)
    .join("");
  const body = [att, m.text?.trim()].filter(Boolean).join(" ");
  return body ? `${speakerName(m)}：${body}` : null;
}

function clipMessageLine(line: string): string {
  if (line.length <= GPT_MESSAGE_MAX_CHARS) return line;
  // 开头通常是行动过程，结尾通常是结论；两头都留，避免一条超长施工汇报吃光整批预算。
  const tail = 700;
  return `${line.slice(0, GPT_MESSAGE_MAX_CHARS - tail - 15)}\n…（本条过长，省略中段）…\n${line.slice(-tail)}`;
}

export interface BoundedGptPrompt {
  prompt: string;
  includedMessages: StoredMessage[];
  omittedCount: number;
}

/**
 * Codex 的 prompt 目前作为命令行参数传入。首次重建 thread 或积压很多轮时，
 * 只重放最近上下文，并限制单条长度，防止 Windows 在 spawn 前因命令行过长直接失败。
 */
export function buildBoundedGptPrompt(
  messages: StoredMessage[],
  prefix = "",
  maxChars = GPT_PROMPT_MAX_CHARS,
): BoundedGptPrompt {
  const entries = messages
    .map((message) => {
      const line = lineFor(message);
      return line ? { message, line: clipMessageLine(line) } : null;
    })
    .filter((entry): entry is { message: StoredMessage; line: string } => entry !== null);

  const noteReserve = 140;
  const lineBudget = Math.max(500, maxChars - prefix.length - noteReserve);
  const selected: typeof entries = [];
  let used = 0;
  let omittedCount = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const cost = entry.line.length + (selected.length ? 2 : 0);
    if (selected.length && used + cost > lineBudget) {
      omittedCount = i + 1;
      break;
    }
    // 极小测试预算下也保证最新一条能进，但仍裁到当前剩余容量。
    if (!selected.length && cost > lineBudget) {
      entry.line = entry.line.slice(0, lineBudget);
    }
    selected.unshift(entry);
    used += Math.min(cost, lineBudget);
  }

  const note = omittedCount
    ? `[上下文重建：较早的 ${omittedCount} 条消息因 Windows 命令行长度限制未重放；下面是最近对话。]`
    : "";
  const prompt = [prefix.trim(), note, selected.map((entry) => entry.line).join("\n\n")]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, maxChars);
  return {
    prompt,
    includedMessages: selected.map((entry) => entry.message),
    omittedCount,
  };
}

/** 收集这批消息里真实存在的图片文件绝对路径（给 codex -i 用）；丢了的文件跳过别炸轮 */
function imagePathsFor(messages: StoredMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    for (const a of m.attachments || []) {
      if (a.kind !== "image") continue;
      const p = path.join(UPLOADS_DIR, a.file);
      if (fs.existsSync(p)) out.push(p);
    }
  }
  // thread 重建时历史里可能积了几十张图；只带最近一组，避免一次重传全部旧截图。
  return out.slice(-GPT_REBUILD_MAX_IMAGES);
}

/** GPT 说"这轮我不说话"的暗号；开场白里约定的是 [沉默] */
function isSilence(text: string): boolean {
  const t = text.trim();
  return t === "[沉默]" || (t.length <= 8 && t.includes("沉默"));
}

/**
 * 麦穗的下一轮 prompt 里要前置的 GPT 发言：从队尾往前收连续的 GPT 消息
 * （队尾最后一条是刚 push 的用户消息，跳过）。串行编排下通常是 0 或 1 条。
 */
export function unseenGptLines(record: SessionRecord): string {
  const lines: string[] = [];
  for (let i = record.messages.length - 2; i >= 0; i--) {
    const m = record.messages[i];
    if (m.role !== "assistant" || m.speaker !== GPT_SPEAKER) break;
    lines.unshift(`[GPT 说：${m.text}]`);
  }
  return lines.join("\n");
}

export interface GptTurnOpts {
  record: SessionRecord;
  store: SessionStore;
  send: (payload: unknown) => void;
  /** 没人盯着屏幕时把 GPT 的话推到手机（Bark） */
  notifyIfAway: (title: string, body: string) => void;
  /** 把 GPT 轮的 handle 挂到会话级注册项上（可打断）；结束时传 null 摘掉 */
  setActive: (handle: TurnHandle | null) => void;
  /** 显式打断后旧回调可能晚到，不能再写库或把新轮收掉 */
  isActive?: () => boolean;
  /** GPT 已经吐出半截又报错时，由会话级轮注册表统一落库 */
  persistIncomplete?: () => boolean;
}

/**
 * 群聊里麦穗说完后的 GPT 轮。串行编排：泽发言 → 麦穗先答 → GPT 看到
 * 完整上下文再答（或沉默）。GPT 侧上下文靠 codex thread resume 延续，
 * 每轮只喂它没看过的新消息（codexSeenCount 是已喂指针）。
 * 返回是否真的起了一轮。
 */
export function maybeRunGptTurn(opts: GptTurnOpts): boolean {
  const { record, store, send, notifyIfAway, setActive } = opts;
  const isActive = opts.isActive ?? (() => true);
  const persistIncomplete = opts.persistIncomplete ?? (() => false);
  if (record.mode !== "group") return false;
  if (!codexAvailable()) {
    send({ type: "error", speaker: GPT_SPEAKER, message: "GPT 没上线：codex 不可用（CLI 没装，或登录凭证不在）" });
    return false;
  }

  const upTo = record.messages.length;
  const freshMessages = record.messages.slice(record.codexSeenCount ?? 0, upTo);
  if (!freshMessages.some((message) => lineFor(message))) return false;

  let prefix = "";
  if (!record.codexThreadId) {
    // 首轮带开场白。缺文件就明确报错，绝不让 GPT 不明不白地进群
    let intro: string;
    try {
      intro = fs.readFileSync(INTRO_FILE, "utf8");
    } catch {
      send({ type: "error", speaker: GPT_SPEAKER, message: `GPT 开场白文件缺失（${INTRO_FILE}），这轮不叫它了` });
      return false;
    }
    prefix = `${intro.trim()}\n\n[群里的对话]`;
  }
  const batch = buildBoundedGptPrompt(freshMessages, prefix);
  const prompt = batch.prompt;
  const images = imagePathsFor(batch.includedMessages);
  if (batch.omittedCount) {
    console.warn(
      `[group] GPT 上下文过长：省略较早 ${batch.omittedCount} 条，只重放最近 ${batch.includedMessages.length} 条`
    );
  }

  send({ type: "gpt_start" });
  let finished = false; // spawn 失败时 onError 同步触发；标记住，别在下面把死 handle 挂回 active
  const handle = runCodexTurn(
    { prompt, threadId: record.codexThreadId, images },
    {
      onThreadId(threadId) {
        if (!isActive()) return;
        record.codexThreadId = threadId;
        store.save(record);
      },
      onMessage(text) {
        if (!isActive()) return;
        // codex 不给增量，整段到达；借 delta 通道让前端先把气泡立起来
        send({ type: "delta", speaker: GPT_SPEAKER, text });
      },
      onDone(finalText) {
        if (!isActive()) return;
        finished = true;
        const text = finalText.trim();
        if (!text || isSilence(text)) {
          // 沉默不存档不展示，但这轮喂过的消息算它看过了（thread 里记得）
          record.codexSeenCount = upTo;
          store.save(record);
          send({ type: "done", speaker: GPT_SPEAKER, text: "" });
          setActive(null);
          return;
        }
        record.messages.push({ role: "assistant", speaker: GPT_SPEAKER, text, at: new Date().toISOString() });
        record.codexSeenCount = upTo + 1; // 自己这条也算看过（thread 里有）
        store.save(record);
        // GPT 的发言也进记忆；不 await、出错不影响主聊天
        scheduleExtractionIfNeeded(record);
        send({ type: "done", speaker: GPT_SPEAKER, text });
        notifyIfAway("GPT", text);
        setActive(null);
      },
      onError(message) {
        if (!isActive()) return;
        // 失败不动 codexSeenCount：下轮把这批消息重喂一遍，顶多它见到重复台词
        finished = true;
        const interrupted = persistIncomplete();
        console.error(`[group] GPT 轮失败：${message}`);
        send({ type: "error", speaker: GPT_SPEAKER, message: `GPT 这轮没跑起来：${message}`, interrupted });
        setActive(null);
      },
    },
  );
  if (!finished) {
    setActive({
      interrupt: async () => {
        // codex 的 interrupt 静默收掉、不走回调——这里补上摘 active 和收口事件，
        // 不然打断后 active 永远占着，泽再也发不出消息
        await handle.interrupt();
        if (!isActive()) return;
        setActive(null);
        send({ type: "done", speaker: GPT_SPEAKER, text: "" });
        // codexSeenCount 不动：打断没喂完，下轮重喂这批
      },
    });
  }
  return true;
}
