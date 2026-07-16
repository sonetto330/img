import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TurnHandle } from "./engine.js";
import type { SessionRecord, SessionStore, StoredMessage } from "./sessions.js";
import { codexAvailable, runCodexTurn } from "./codex.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

/** GPT 首轮开场白（群规则、成员介绍、沉默协议）；每次现读，改文件不用重启 */
const INTRO_FILE = path.join(root, "prompts", "group_gpt_intro.md");

/** StoredMessage.speaker 里标记 GPT 的值 */
export const GPT_SPEAKER = "gpt";

function speakerName(m: StoredMessage): string {
  if (m.role === "user") return "泽";
  return m.speaker === GPT_SPEAKER ? "GPT" : "麦穗";
}

/** 上传目录：跟 index.ts 同一套算法，附件的 file 字段都落在这里 */
const UPLOADS_DIR = path.join(path.resolve(process.env.WORKSPACE_DIR || path.join(root, "workspace")), "uploads");

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
  return out;
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
  /** 把 GPT 轮的 handle 挂到连接的 active 上（可打断）；结束时传 null 摘掉 */
  setActive: (handle: TurnHandle | null) => void;
}

/**
 * 群聊里麦穗说完后的 GPT 轮。串行编排：泽发言 → 麦穗先答 → GPT 看到
 * 完整上下文再答（或沉默）。GPT 侧上下文靠 codex thread resume 延续，
 * 每轮只喂它没看过的新消息（codexSeenCount 是已喂指针）。
 * 返回是否真的起了一轮。
 */
export function maybeRunGptTurn(opts: GptTurnOpts): boolean {
  const { record, store, send, notifyIfAway, setActive } = opts;
  if (record.mode !== "group") return false;
  if (!codexAvailable()) {
    send({ type: "error", speaker: GPT_SPEAKER, message: "GPT 没上线：codex 不可用（CLI 没装，或登录凭证不在）" });
    return false;
  }

  const upTo = record.messages.length;
  const freshMessages = record.messages.slice(record.codexSeenCount ?? 0, upTo);
  const fresh = freshMessages.map(lineFor).filter((l): l is string => !!l);
  if (!fresh.length) return false;
  const images = imagePathsFor(freshMessages);

  let prompt = fresh.join("\n\n");
  if (!record.codexThreadId) {
    // 首轮带开场白。缺文件就明确报错，绝不让 GPT 不明不白地进群
    let intro: string;
    try {
      intro = fs.readFileSync(INTRO_FILE, "utf8");
    } catch {
      send({ type: "error", speaker: GPT_SPEAKER, message: `GPT 开场白文件缺失（${INTRO_FILE}），这轮不叫它了` });
      return false;
    }
    prompt = `${intro.trim()}\n\n[群里的对话]\n\n${prompt}`;
  }

  send({ type: "gpt_start" });
  let finished = false; // spawn 失败时 onError 同步触发；标记住，别在下面把死 handle 挂回 active
  const handle = runCodexTurn(
    { prompt, threadId: record.codexThreadId, images },
    {
      onThreadId(threadId) {
        record.codexThreadId = threadId;
        store.save(record);
      },
      onMessage(text) {
        // codex 不给增量，整段到达；借 delta 通道让前端先把气泡立起来
        send({ type: "delta", speaker: GPT_SPEAKER, text });
      },
      onDone(finalText) {
        finished = true;
        setActive(null);
        const text = finalText.trim();
        if (!text || isSilence(text)) {
          // 沉默不存档不展示，但这轮喂过的消息算它看过了（thread 里记得）
          record.codexSeenCount = upTo;
          store.save(record);
          send({ type: "done", speaker: GPT_SPEAKER, text: "" });
          return;
        }
        record.messages.push({ role: "assistant", speaker: GPT_SPEAKER, text, at: new Date().toISOString() });
        record.codexSeenCount = upTo + 1; // 自己这条也算看过（thread 里有）
        store.save(record);
        send({ type: "done", speaker: GPT_SPEAKER, text });
        notifyIfAway("GPT", text);
      },
      onError(message) {
        // 失败不动 codexSeenCount：下轮把这批消息重喂一遍，顶多它见到重复台词
        finished = true;
        setActive(null);
        console.error(`[group] GPT 轮失败：${message}`);
        send({ type: "error", speaker: GPT_SPEAKER, message: `GPT 这轮没跑起来：${message}` });
      },
    },
  );
  if (!finished) {
    setActive({
      interrupt: async () => {
        // codex 的 interrupt 静默收掉、不走回调——这里补上摘 active 和收口事件，
        // 不然打断后 active 永远占着，泽再也发不出消息
        await handle.interrupt();
        setActive(null);
        send({ type: "done", speaker: GPT_SPEAKER, text: "" });
        // codexSeenCount 不动：打断没喂完，下轮重喂这批
      },
    });
  }
  return true;
}
