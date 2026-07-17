import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { SessionStore, type Attachment, type SessionRecord } from "./sessions.js";
import { runTurn, PersistentSession, type TurnHandle, type TurnUsage } from "./engine.js";
import { attachmentPayload, isFirstOutputTimedOut, isTurnStalled } from "./lifecycle.js";
import { burnAttachments } from "./burn.js";
import { splitApiError, apiErrorNote } from "./apierror.js";
import { getMode, loadModePrompt, type ToolEvent } from "./modes.js";
import { maybeRunGptTurn, unseenGptLines } from "./group.js";
import { buildHistoryTools } from "./history.js";
import { barkPush } from "./bark.js";
import { startLoginHeartbeat } from "./heartbeat.js";
import { synthesize, ttsEnabled } from "./tts.js";
import { transcribe, sttEnabled } from "./stt.js";
import { getWeather } from "./weather.js";
import { scheduleExtractionIfNeeded } from "./memory/scribe.js";
import { retrieve, markRetrieved } from "./memory/librarian.js";
import { formatMemoryBlock } from "./memory/format.js";
import { getGraph, getEntityDetail, getCoreDetail } from "./memory/graph.js";
import { loadPersona } from "./persona.js";
import { getGreeting } from "./greeting.js";
import { translateThinking } from "./translate.js";
import { getSettings, setChannel, setExternal, publicSettings, channelEnv, externalConfigured, useApiNow, looksLikeLimitError, modelForChannel, type Channel } from "./settings.js";
import { listExternalModels, SUBSCRIPTION_MODELS } from "./models.js";
import { isLoopbackAddress, proxyExternalAnthropic } from "./external-proxy.js";
import { acquireOrRenewDrain, computeRestartReady, currentDrain, isDraining } from "./supervisor-state.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const PORT = Number(process.env.PORT || 3000);
const EXTERNAL_PROXY_PREFIX = "/_external_anthropic";
// 只影响本服务拉起的 Claude 子进程；设置里没填自定义 base URL 时 channelEnv 不会使用它。
process.env.EXTERNAL_API_PROXY_URL = `http://127.0.0.1:${PORT}${EXTERNAL_PROXY_PREFIX}`;
const TOKEN = process.env.ACCESS_TOKEN || "";
const WORKSPACE = path.resolve(process.env.WORKSPACE_DIR || path.join(root, "workspace"));
const PERMISSION_MODE = (process.env.PERMISSION_MODE || "bypassPermissions") as Options["permissionMode"];
const DATA_DIR = path.join(root, "data");
// 流式回复的落盘检查点：服务死在半路（硬杀/崩溃）时，半截回复只活在内存里会整段丢；
// 每 3 秒把流到的正文存进这里，重启时转成带半截标记的正式消息
const CHECKPOINT_DIR = path.join(DATA_DIR, "runtime", "checkpoints");
// 单次上下文（累计输入÷步数）超过这个 token 数就自动给会话瘦身（/compact）；0 = 关自动挡
const COMPACT_THRESHOLD = Number(process.env.COMPACT_THRESHOLD_TOKENS || 150000);

if (!TOKEN) {
  console.error("请先在 .env 里设置 ACCESS_TOKEN（访问口令），参考 .env.example");
  process.exit(1);
}
fs.mkdirSync(WORKSPACE, { recursive: true });

// 上传的图片/文件放在工作目录里，这样他能直接用 Read 工具看
const UPLOADS = path.join(WORKSPACE, "uploads");
fs.mkdirSync(UPLOADS, { recursive: true });
const MAX_UPLOAD = 200 * 1024 * 1024; // 200MB，泽要传字体文件这类大家伙
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const store = new SessionStore(DATA_DIR);
// chat 端老记录的只读存档（scripts/import-chat-archive.mjs 灌入），只喂给翻历史工具，不进会话列表
const archiveStore = new SessionStore(path.join(DATA_DIR, "archive"));
// 启动即恢复上代进程猝死留下的半截回复（此时还没 listen，没有并发轮次）
fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
recoverCheckpoints();
const publicDir = path.join(root, "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff2": "font/woff2",
};

function authed(url: URL): boolean {
  return url.searchParams.get("token") === TOKEN;
}

/** 当前时间的人话版，注入每轮系统提示 */
function nowString(): string {
  const d = new Date();
  const wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${wd} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const HISTORY_REPLAY_MAX_MESSAGE = 2000;
const HISTORY_REPLAY_MAX_TOTAL = 60000;

/** transcript 失效后，用仍在存档里的消息给新会话补回上下文。 */
function buildHistoryReplay(messages: SessionRecord["messages"]): string {
  const lines = messages.map((message) => {
    const speaker = message.role === "user" ? "泽" : message.speaker === "gpt" ? "GPT" : "麦穗";
    const text = message.text.length > HISTORY_REPLAY_MAX_MESSAGE
      ? `${message.text.slice(0, HISTORY_REPLAY_MAX_MESSAGE)}…（截断）`
      : message.text;
    return `${speaker}：${text}`;
  });
  let omitted = 0;
  const render = () => [
    "【历史重放】这个窗口此前的对话记录如下（服务器重建了你的记忆，照常接着聊，不用向泽解释这件事）：",
    omitted ? `（更早的 ${omitted} 条记录已省略）` : "",
    ...lines.slice(omitted),
    "【重放结束】接下来是泽刚发来的新消息：",
  ].filter(Boolean).join("\n");
  let replay = render();
  while (replay.length > HISTORY_REPLAY_MAX_TOTAL && omitted < lines.length) {
    omitted++;
    replay = render();
  }
  return replay;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// 正在瘦身的会话：压缩期间 resume 旧 id 会 fork 出没压缩的分支，新消息必须挡住
const compacting = new Set<string>();

/**
 * 常驻会话池：会话 id → 活着的 CLI 进程。聊天热路径直接往进程的输入流里推
 * 消息，历史在进程内存里不重读，冷启动税从"每条消息一次"变成"每次进程启动
 * 一次"。第一阶段只给聊天上常驻；拍一拍/通话/compact 走老的 resume 路——但
 * 它们 resume 之前必须先把同会话的常驻进程收干净，不然会 fork 出分叉历史。
 */
interface PoolEntry {
  session: PersistentSession;
  /** 进程起来时走的通道；设置变了对不上就得重开 */
  useApi: boolean;
  /** 自定义工具事件的转发出口：手机重连后指到新的 WS 连接，旧闭包照样能送到 */
  emitRef: { send: (payload: unknown) => void };
  idleTimer?: NodeJS.Timeout;
  /** 回收到点时还 busy 的记账：连续两个周期都没等到空闲，多半是轮子卡死了，强制收 */
  busyStrike?: boolean;
}
const pool = new Map<string, PoolEntry>();

type ActiveState = "waiting_model" | "running_tool";
interface ActiveTurn {
  record: SessionRecord;
  handle: TurnHandle;
  outRef: { send: (payload: unknown) => void };
  status: ActiveState;
  toolName?: string;
  speaker?: "gpt";
  startedAt: string;
  lastProgressAt: string;
  partialText: string;
  partialThinking: string;
  /** 累计思考毫秒（thinking_done 事件累加）；掐断落盘时给思考块一个真实时长 */
  thinkingMs: number;
  /** 本轮已跑过的工具；正文零字被掐断时靠它证明这轮干过活 */
  toolsSeen: Array<{ name: string; detail?: string }>;
  /** 引擎真的启动过才有转录污染风险；检索记忆阶段被打断不用作废凭证 */
  engineStarted?: boolean;
  /** 真正把本轮推给引擎的时间；首输出止损不把记忆检索时间算进去 */
  engineStartedAt?: string;
  /** 已收到过思考、文字或工具事件后，首输出止损永久退出 */
  hasModelProgress?: boolean;
  /** 流式检查点上次落盘时刻（ms）；3 秒节流，防进程猝死丢半截回复 */
  lastCheckpointAt?: number;
  heartbeatTimer: NodeJS.Timeout;
}

// 轮属于会话，不属于某条 WS。出口可以随 attach 改指，轮本身一直跑到明确结束或打断。
const activeTurns = new Map<string, ActiveTurn>();
const silentSend = () => {};
const configuredTurnStallSeconds = Number(process.env.TURN_STALL_SECONDS || 180);
const TURN_STALL_SECONDS = Number.isFinite(configuredTurnStallSeconds) && configuredTurnStallSeconds >= 30
  ? configuredTurnStallSeconds
  : 180;
const TURN_STALL_MS = TURN_STALL_SECONDS * 1000;
const configuredFirstOutputSeconds = Number(process.env.FIRST_OUTPUT_TIMEOUT_SECONDS || 45);
const FIRST_OUTPUT_TIMEOUT_SECONDS = Number.isFinite(configuredFirstOutputSeconds) && configuredFirstOutputSeconds >= 15
  ? configuredFirstOutputSeconds
  : 45;
const FIRST_OUTPUT_TIMEOUT_MS = FIRST_OUTPUT_TIMEOUT_SECONDS * 1000;

// Supervisor 一期（supervisor-design.md）：拉起时经环境变量下发的一次性身份与重启单号，
// 健康端点回显供认领与幂等核对。手动 start.bat 起的服务两者皆 null——Supervisor 只监控不认领。
const SERVICE_STARTED_AT = new Date().toISOString();
const INSTANCE_NONCE = process.env.INSTANCE_NONCE || null;
const RESTART_REQUEST_ID = process.env.RESTART_REQUEST_ID || null;

// ---- 流式检查点：防"服务死在半路，半截回复整段丢" ----
// 正常掐断走 persistIncompleteTurn 落盘没问题；但硬杀（Supervisor 换代、watchdog 拉起、
// 崩溃）时 partialText 只在内存里。流正文时每 3 秒把半截存进 checkpoint 文件，
// 轮子善终就删；新代启动时把遗留的转成带半截标记的正式消息。
const CHECKPOINT_INTERVAL_MS = 3000;

function checkpointFile(id: string): string {
  return path.join(CHECKPOINT_DIR, `${id}.json`);
}

function maybeCheckpoint(turn: ActiveTurn): void {
  const now = Date.now();
  if (turn.lastCheckpointAt && now - turn.lastCheckpointAt < CHECKPOINT_INTERVAL_MS) return;
  // 思考也是泽亲眼看着流出来的东西，跟正文同等待遇；工具轮常常正文零字、思考一大段
  if (!turn.partialText.trim() && !turn.partialThinking.trim() && turn.toolsSeen.length === 0) return;
  turn.lastCheckpointAt = now;
  const file = checkpointFile(turn.record.id);
  try {
    // tmp+rename 原子写，半写的坏文件不会被下代当真
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({
      sessionId: turn.record.id,
      speaker: turn.speaker,
      text: turn.partialText,
      thinking: turn.partialThinking,
      thinkingMs: turn.thinkingMs,
      tools: turn.toolsSeen,
      at: new Date().toISOString(),
    }));
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    // 检查点写不进去不能拖累正常聊天
  }
}

function clearCheckpoint(id: string): void {
  try { fs.unlinkSync(checkpointFile(id)); } catch {}
  try { fs.unlinkSync(`${checkpointFile(id)}.tmp`); } catch {}
}

/** 启动时跑一次：上代进程猝死留下的半截回复 → 转正式消息（带半截标记）。处理完全部清场。 */
function recoverCheckpoints(): void {
  let files: string[];
  try {
    files = fs.readdirSync(CHECKPOINT_DIR);
  } catch {
    return;
  }
  for (const f of files) {
    const full = path.join(CHECKPOINT_DIR, f);
    if (f.endsWith(".json")) {
      try {
        const cp = JSON.parse(fs.readFileSync(full, "utf8")) as {
          sessionId?: string; speaker?: string; text?: string; thinking?: string; thinkingMs?: number;
          tools?: { name: string; detail?: string }[]; at?: string;
        };
        const text = (cp.text || "").trim();
        const thinking = (cp.thinking || "").trim();
        const tools = Array.isArray(cp.tools) ? cp.tools.filter((t) => t && typeof t.name === "string") : [];
        const record = cp.sessionId ? store.get(cp.sessionId) : null;
        if (record && (text || thinking || tools.length)) {
          // 同 persistIncompleteTurn：半截进了转录就作废 resume 凭证，防下轮分叉
          if (cp.speaker === "gpt") {
            delete record.codexThreadId;
            record.codexSeenCount = 0;
          } else {
            delete record.claudeSessionId;
          }
          record.messages.push({
            id: randomUUID(),
            role: "assistant",
            speaker: cp.speaker === "gpt" ? "gpt" : undefined,
            text,
            thinking: thinking ? { text: thinking, ms: cp.thinkingMs || 0 } : undefined,
            tools: tools.length ? tools : undefined,
            interrupted: true,
            incompleteReason: "error",
            at: cp.at || new Date().toISOString(),
          });
          store.save(record);
          console.error(`[checkpoint] 恢复上代没说完的半截回复：${cp.sessionId!.slice(0, 8)}（正文 ${text.length} 字 · 思考 ${thinking.length} 字 · 工具 ${tools.length} 个）`);
        }
      } catch {
        // 坏文件救不了，照删
      }
    }
    try { fs.unlinkSync(full); } catch {}
  }
}

function sendTurnEvent(turn: ActiveTurn, payload: Record<string, unknown>): void {
  const type = payload.type;
  if (type === "delta" && typeof payload.text === "string") {
    turn.partialText += payload.text;
    turn.hasModelProgress = true;
    progressTurn(turn, "waiting_model");
    maybeCheckpoint(turn);
  } else if (type === "thinking" && typeof payload.text === "string") {
    turn.partialThinking += payload.text;
    turn.hasModelProgress = true;
    progressTurn(turn, "waiting_model");
    maybeCheckpoint(turn);
  } else if (type === "thinking_done" && typeof payload.ms === "number") {
    turn.thinkingMs += payload.ms;
  } else if (type === "tool") {
    turn.hasModelProgress = true;
    if (typeof payload.name === "string") {
      turn.toolsSeen.push({ name: payload.name, detail: typeof payload.detail === "string" ? payload.detail : undefined });
    }
    progressTurn(turn, "running_tool", typeof payload.name === "string" ? payload.name : undefined);
    maybeCheckpoint(turn);
  }
  turn.outRef.send({ ...payload, sessionId: turn.record.id });
}

function sendTurnStatus(turn: ActiveTurn, force = false): void {
  if (activeTurns.get(turn.record.id) !== turn) return;
  if (!force) return;
  turn.outRef.send({
    type: "status",
    sessionId: turn.record.id,
    state: turn.status,
    toolName: turn.toolName,
    speaker: turn.speaker,
    lastProgressAt: turn.lastProgressAt,
  });
}

function progressTurn(turn: ActiveTurn, status: ActiveState, toolName?: string): void {
  if (activeTurns.get(turn.record.id) !== turn) return;
  const changed = turn.status !== status || turn.toolName !== toolName;
  turn.status = status;
  turn.toolName = toolName;
  turn.lastProgressAt = new Date().toISOString();
  sendTurnStatus(turn, changed);
}

function startActiveTurn(record: SessionRecord, send: (payload: unknown) => void, speaker?: "gpt"): ActiveTurn {
  const now = new Date().toISOString();
  const turn: ActiveTurn = {
    record,
    handle: { interrupt: async () => {} },
    outRef: { send },
    status: "waiting_model" as const,
    speaker,
    startedAt: now,
    lastProgressAt: now,
    partialText: "",
    partialThinking: "",
    thinkingMs: 0,
    toolsSeen: [],
    heartbeatTimer: undefined as unknown as NodeJS.Timeout,
  };
  turn.heartbeatTimer = setInterval(() => {
    if (activeTurns.get(record.id) !== turn) return clearInterval(turn.heartbeatTimer);
    if (
      !turn.speaker
      && isFirstOutputTimedOut(turn.engineStartedAt, Boolean(turn.hasModelProgress), Date.now(), FIRST_OUTPUT_TIMEOUT_MS)
    ) {
      console.error(`[turn] ${record.id.slice(0, 8)} 引擎启动后 ${FIRST_OUTPUT_TIMEOUT_SECONDS} 秒没有首个输出，自动停止`);
      interruptActiveTurn(
        turn,
        `模型通道 ${FIRST_OUTPUT_TIMEOUT_SECONDS} 秒没有返回任何内容，可能正在拥堵；这一轮已自动停止，请重试`,
      );
      return;
    }
    if (isTurnStalled(turn.lastProgressAt, Date.now(), TURN_STALL_MS)) {
      console.error(`[turn] ${record.id.slice(0, 8)} 超过 ${TURN_STALL_SECONDS} 秒没有进展，自动停止`);
      interruptActiveTurn(turn, `超过 ${TURN_STALL_SECONDS} 秒没有新进展，已自动停止，请重试`);
      return;
    }
    turn.outRef.send({
      type: "heartbeat",
      sessionId: record.id,
      speaker: turn.speaker,
      lastProgressAt: turn.lastProgressAt,
    });
  }, 5000);
  turn.heartbeatTimer.unref?.();
  activeTurns.set(record.id, turn);
  sendTurnStatus(turn, true);
  return turn;
}

function resetActiveTurn(turn: ActiveTurn): void {
  if (activeTurns.get(turn.record.id) !== turn) return;
  turn.partialText = "";
  turn.partialThinking = "";
  turn.thinkingMs = 0;
  turn.toolsSeen = [];
  // 换通道重试要重流，废弃尝试的检查点跟着清，别让它死后被当遗言恢复
  clearCheckpoint(turn.record.id);
  delete turn.lastCheckpointAt;
  turn.status = "waiting_model";
  turn.engineStarted = false;
  delete turn.engineStartedAt;
  turn.hasModelProgress = false;
  delete turn.toolName;
  turn.lastProgressAt = new Date().toISOString();
  sendTurnStatus(turn, true);
}

function markEngineStarted(turn: ActiveTurn): void {
  if (activeTurns.get(turn.record.id) !== turn) return;
  const now = new Date().toISOString();
  turn.engineStarted = true;
  turn.engineStartedAt = now;
  turn.hasModelProgress = false;
  turn.lastProgressAt = now;
}

function finishActiveTurn(turn: ActiveTurn): void {
  if (activeTurns.get(turn.record.id) !== turn) return;
  clearInterval(turn.heartbeatTimer);
  activeTurns.delete(turn.record.id);
  clearCheckpoint(turn.record.id);
  turn.outRef.send({ type: "status", sessionId: turn.record.id, state: "idle", speaker: turn.speaker });
  turn.outRef.send = silentSend;
}

function invalidateInterruptedResume(turn: ActiveTurn): void {
  if (turn.speaker === "gpt") {
    delete turn.record.codexThreadId;
    turn.record.codexSeenCount = 0;
  } else {
    delete turn.record.claudeSessionId;
  }
  store.save(turn.record);
}

function persistIncompleteTurn(turn: ActiveTurn, reason: "interrupted" | "error"): boolean {
  const text = turn.partialText.trim();
  const thinking = turn.partialThinking.trim();
  // 正文零字但思考/工具跑过的轮（工具卡死、上游超时最常见的死相）也要留痕，
  // 不然泽亲眼看着流了半天的东西刷新后整轮蒸发
  if (!text && !thinking && turn.toolsSeen.length === 0) return false;
  turn.record.messages.push({
    id: randomUUID(),
    role: "assistant",
    speaker: turn.speaker,
    text,
    thinking: thinking ? { text: thinking, ms: turn.thinkingMs } : undefined,
    tools: turn.toolsSeen.length ? [...turn.toolsSeen] : undefined,
    interrupted: true,
    incompleteReason: reason,
    at: new Date().toISOString(),
  });
  invalidateInterruptedResume(turn);
  return true;
}

function interruptActiveTurn(turn: ActiveTurn, errorMessage?: string): void {
  if (activeTurns.get(turn.record.id) !== turn) return;
  const handle = turn.handle;
  const persisted = persistIncompleteTurn(turn, "interrupted");
  // 引擎没启动就被打断（还在检索记忆），转录没动过，凭证留着照常 resume
  if (!persisted && turn.engineStarted) invalidateInterruptedResume(turn);
  if (errorMessage) {
    sendTurnEvent(turn, {
      type: "error",
      speaker: turn.speaker,
      message: errorMessage,
      interrupted: persisted,
      incompleteReason: "interrupted",
    });
  } else {
    sendTurnEvent(turn, {
      type: "done",
      speaker: turn.speaker,
      text: turn.partialText.trim(),
      interrupted: persisted,
      incompleteReason: "interrupted",
    });
  }
  finishActiveTurn(turn);
  void handle.interrupt().catch(() => {}).finally(() => {
    if (!turn.speaker) void dropPooled(turn.record.id);
  });
}

// 闲置多久回收常驻进程（释放内存）；下次消息再冷启动 resume
const POOL_IDLE_MS = Math.max(1, Number(process.env.PERSIST_IDLE_MINUTES || 15)) * 60_000;

/** 每推一轮就把闲置回收的表拨回去；到点了还在干活就再等一个周期（最多宽限一次） */
function touchPool(id: string, entry: PoolEntry): void {
  entry.busyStrike = false;
  scheduleIdleReap(id, entry);
}

function scheduleIdleReap(id: string, entry: PoolEntry): void {
  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (pool.get(id) !== entry) return;
    if (entry.session.busy && !entry.busyStrike) {
      entry.busyStrike = true; // 一轮真跑超 15 分钟的情况罕见；再给一个周期，还 busy 就当卡死
      return scheduleIdleReap(id, entry);
    }
    console.log(
      entry.session.busy
        ? `[pool] 常驻进程 busy 卡了两个周期，多半死了，强制回收`
        : `[pool] 会话闲置超 ${POOL_IDLE_MS / 60000} 分钟，回收常驻进程（下次消息 resume 冷启动）`
    );
    void dropPooled(id);
  }, POOL_IDLE_MS);
  entry.idleTimer.unref?.();
}

/**
 * 收掉并移除某会话的常驻进程。resolve 时进程已退出、内部历史 jsonl 落盘，
 * 之后对这个内部会话 resume（compact/拍一拍/通话/下次冷启动）才安全。
 */
async function dropPooled(id: string): Promise<void> {
  const entry = pool.get(id);
  if (!entry) return;
  pool.delete(id);
  clearTimeout(entry.idleTimer);
  await entry.session.close();
}

/** 通道或外部 API 配置一变就全清：进程的环境变量是启动时定死的，旧进程还挂着旧通道 */
function clearPool(reason: string): void {
  const activeClaudeTurns = [...activeTurns.values()].filter((turn) => !turn.speaker);
  const pooledIds = [...pool.keys()];
  if (!pooledIds.length && !activeClaudeTurns.length) return;
  console.log(
    `[pool] ${reason}，停止 ${activeClaudeTurns.length} 个活动轮次、清空 ${pooledIds.length} 个常驻进程`
  );
  // 先摘掉活动轮并明确通知页面，再关进程。即使切通道发生在 pool.set 之前，
  // 异步 launch 回来时也会看到 activeTurns 已失效，不会复活旧通道。
  for (const turn of activeClaudeTurns) {
    interruptActiveTurn(turn, `${reason}，这一轮已停止，请重新发送`);
  }
  for (const id of pooledIds) void dropPooled(id);
}

/**
 * 阅后即焚：resume 之前把上一轮 Read 过的附件原文从内部历史里替换成占位符。
 * 放在 resume 前做（而不是回话后）就没有和子进程写文件的并发问题——同一
 * 会话的轮次是串行的。焚失败不挡聊天，最多这轮多背点原文。
 */
function burnBeforeResume(record: SessionRecord): void {
  if (!record.claudeSessionId) return;
  try {
    const r = burnAttachments(record.claudeSessionId, WORKSPACE, UPLOADS);
    if (r.burned) {
      console.log(`[burn] 「${record.title}」阅后即焚 ${r.burned} 块附件原文，历史瘦了约 ${Math.round(r.savedChars / 1024)}K 字符`);
    }
  } catch (err) {
    console.error(`[burn] ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * 给会话做一次 /compact：SDK 把历史压成摘要，聊过什么、定过什么都在，
 * 大文件原文被压掉，之后单次上下文从几十万掉到几万。
 * 斜杠命令必须独占 prompt，所以这轮不传 now/memoryBlock（engine 会把它们
 * 包成 system-reminder 拼在前面，/compact 就不再是行首、变成普通文本了）。
 */
function runCompact(record: SessionRecord): Promise<void> {
  if (!record.claudeSessionId) return Promise.reject(new Error("这个会话还没聊过，没东西可压"));
  if (compacting.has(record.id)) return Promise.reject(new Error("正在瘦身，别重复点"));
  compacting.add(record.id);
  const attempt = (useApi: boolean) =>
    new Promise<void>((resolve, reject) => {
      runTurn(
        {
          prompt: "/compact",
          resume: record.claudeSessionId,
          cwd: WORKSPACE,
          permissionMode: PERMISSION_MODE,
          persona: loadPersona(),
          modePrompt: loadModePrompt(record.mode),
          model: modelForChannel(useApi, process.env.CLAUDE_MODEL || "claude-opus-4-7"),
          thinking: false,
          env: channelEnv(useApi),
        },
        {
          onClaudeSession(id) {
            // 压缩会派生新的内部会话 id，之后 resume 的就是压完的摘要版
            record.claudeSessionId = id;
            store.save(record);
          },
          onDelta() {},
          onTool() {},
          onDone(finalText) {
            // CLI 把 API 报错当正文吐出来时压缩其实没做，不能当成功，否则下轮还背着全量历史
            const { apiError } = splitApiError(finalText);
            if (apiError) reject(new Error(apiErrorNote(apiError)));
            else resolve();
          },
          onError(message) {
            reject(new Error(message));
          },
        },
      );
    });
  const useApi = useApiNow();
  // 常驻进程活着时不能直接 resume 压缩（会 fork 出没压缩的分支，进程里还留着
  // 旧历史继续跑，两边就岔开了）——先收进程，等它退干净、jsonl 落盘再压。
  // 往常驻流里直接发 /compact 理论上也行，但会派生新内部会话 id 的行为没实测
  // 过，第一阶段用"收掉再压"这条稳路，代价只是压完后下条消息多付一次冷启动。
  return dropPooled(record.id)
    .then(() => attempt(useApi))
    .catch((err) => {
      if (!useApi && getSettings().channel === "auto" && externalConfigured()) {
        console.error(`[compact] 订阅通道失败（${err instanceof Error ? err.message.slice(0, 120) : err}），换外部 API 重试`);
        return attempt(true);
      }
      throw err;
    })
    .finally(() => compacting.delete(record.id));
}

/** 自动挡：本轮单次上下文（累计输入÷步数）超阈值就顺手瘦身，前端收到小提示，不用她管 */
function maybeAutoCompact(record: SessionRecord, usage: TurnUsage | undefined, send: (payload: unknown) => void): void {
  if (!COMPACT_THRESHOLD || !usage?.steps) return;
  const perStep = Math.round(usage.inputTotal / usage.steps);
  if (perStep < COMPACT_THRESHOLD) return;
  console.log(`[compact] 单次上下文约 ${perStep} tokens，超阈值 ${COMPACT_THRESHOLD}，自动给「${record.title}」瘦身`);
  send({ type: "compact_start", auto: true });
  runCompact(record).then(
    () => send({ type: "compact_done" }),
    (err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[compact] 自动瘦身失败：${message}`);
      send({ type: "compact_error", message });
    },
  );
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // Claude CLI 专用的本机兼容代理：外部中转偶尔漏掉 Brotli 响应头，CLI 会把压缩字节当 JSON。
  if (url.pathname === EXTERNAL_PROXY_PREFIX || url.pathname.startsWith(`${EXTERNAL_PROXY_PREFIX}/`)) {
    if (!isLoopbackAddress(req.socket.remoteAddress)) return sendJson(res, 403, { error: "只允许本机调用" });
    void proxyExternalAnthropic(req, res, `${url.pathname.slice(EXTERNAL_PROXY_PREFIX.length)}${url.search}`);
    return;
  }

  // Supervisor 专线（本机 only，supervisor-design.md 一期）：健康状态 + drain 租约
  if (url.pathname === "/api/supervisor/status") {
    if (!isLoopbackAddress(req.socket.remoteAddress)) return sendJson(res, 403, { error: "只允许本机调用" });
    const now = Date.now();
    const drainState = currentDrain(now);
    const turns = [...activeTurns.values()].map((turn) => ({
      sessionId: turn.record.id.slice(0, 8),
      speaker: turn.speaker || "claude",
      state: turn.status,
      startedAt: turn.startedAt,
      lastProgressAt: turn.lastProgressAt,
    }));
    let wsClients = 0;
    let wsBufferedBytes = 0;
    for (const client of wss.clients) {
      wsClients += 1;
      wsBufferedBytes += client.bufferedAmount;
    }
    // store.save 是同步 writeFileSync：消息推进内存的同一个栈里就已落盘，没有待写队列。
    // 字段按设计单保留，将来落盘改异步时在这里填真数。
    const pendingWrites = 0;
    return sendJson(res, 200, {
      pid: process.pid,
      instanceNonce: INSTANCE_NONCE,
      restartRequestId: RESTART_REQUEST_ID,
      startedAt: SERVICE_STARTED_AT,
      activeTurns: activeTurns.size,
      turns,
      oldestProgressAt: turns.length ? turns.map((t) => t.lastProgressAt).sort()[0] : null,
      wsClients,
      pendingWrites,
      wsBufferedBytes,
      draining: Boolean(drainState),
      drainRequestId: drainState?.requestId ?? null,
      drainExpiresAt: drainState ? new Date(drainState.expiresAt).toISOString() : null,
      restartReady: computeRestartReady({
        draining: Boolean(drainState),
        activeTurns: activeTurns.size,
        pendingWrites,
        wsBufferedBytes,
      }),
    });
  }

  if (url.pathname === "/api/supervisor/drain" && req.method === "POST") {
    if (!isLoopbackAddress(req.socket.remoteAddress)) return sendJson(res, 403, { error: "只允许本机调用" });
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: { requestId?: unknown; nonce?: unknown; leaseSeconds?: unknown };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return sendJson(res, 400, { error: "消息格式不对" });
      }
      // nonce 是认领凭证：Supervisor 只能 drain 自己拉起的这一代。手动起的服务没有 nonce，
      // 按设计单"只监控不认领"，重启请求转泽人工。
      if (!INSTANCE_NONCE) return sendJson(res, 409, { error: "本服务不是 Supervisor 拉起的，只可监控不可重启" });
      if (body.nonce !== INSTANCE_NONCE) return sendJson(res, 403, { error: "nonce 不符，别拿旧代的计划管新代" });
      if (typeof body.requestId !== "string" || !body.requestId) return sendJson(res, 400, { error: "缺 requestId" });
      const lease = typeof body.leaseSeconds === "number" ? body.leaseSeconds : undefined;
      const result = acquireOrRenewDrain(body.requestId, lease, Date.now());
      if (!result.ok) return sendJson(res, 409, { error: "锁被别的重启单持有", heldBy: result.heldBy });
      return sendJson(res, 200, {
        ok: true,
        drainRequestId: result.state.requestId,
        drainExpiresAt: new Date(result.state.expiresAt).toISOString(),
      });
    });
    return;
  }

  // 上传文件（需要口令）
  if (url.pathname === "/api/upload" && req.method === "POST") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    const original = (url.searchParams.get("name") || "文件").slice(0, 120);
    const ext = path.extname(original).toLowerCase();
    const saved = `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_UPLOAD) {
        req.destroy();
        return sendJson(res, 413, { error: "文件太大，上限 200MB" });
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      fs.writeFileSync(path.join(UPLOADS, saved), Buffer.concat(chunks));
      const kind = IMAGE_EXT.has(ext) ? "image" : "file";
      sendJson(res, 200, { file: saved, name: original, kind });
    });
    return;
  }

  // 取回上传过的文件（聊天记录里显示图片用，需要口令）
  const uploadMatch = url.pathname.match(/^\/uploads\/([\w.-]+)$/);
  if (uploadMatch) {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    const filePath = path.join(UPLOADS, path.basename(uploadMatch[1]));
    return fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
      res.end(data);
    });
  }

  // TTS：把文本转成音频流回来（需要口令）
  if (url.pathname === "/api/tts" && req.method === "POST") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    if (!ttsEnabled()) return sendJson(res, 503, { error: "TTS 没配置" });
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      let body: { text?: string };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return sendJson(res, 400, { error: "消息格式不对" });
      }
      const text = String(body.text || "").trim();
      if (!text) return sendJson(res, 400, { error: "没有可念的内容" });
      try {
        const { audio, contentType } = await synthesize(text);
        res.writeHead(200, {
          "Content-Type": contentType,
          "Cache-Control": "no-store",
        });
        res.end(Buffer.from(audio));
      } catch (err) {
        console.error(`[tts] ${err instanceof Error ? err.message : String(err)}`);
        sendJson(res, 502, { error: err instanceof Error ? err.message : "TTS 失败" });
      }
    });
    return;
  }

  // 设置：调用通道（订阅 / 外部API / 自动）+ 外部 API 配置。
  // key 存 data/settings.json（.gitignore 内），GET 绝不回传 key 本身，只回尾巴四位（需要口令）
  if (url.pathname === "/api/settings") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        let body: {
          channel?: string; externalKey?: string; externalBaseUrl?: string;
          externalAuth?: string; externalModel?: string; externalHaiku?: string;
        };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          return sendJson(res, 400, { error: "消息格式不对" });
        }
        // 先存外部 API 配置（有哪项动哪项），再切通道——这样"填 key + 选自动"能一次保存
        const hasExternalField = [body.externalKey, body.externalBaseUrl, body.externalAuth, body.externalModel, body.externalHaiku]
          .some((v) => v !== undefined);
        if (hasExternalField) {
          if (body.externalKey !== undefined && (typeof body.externalKey !== "string" || body.externalKey.length > 300)) {
            return sendJson(res, 400, { error: "key 格式不对" });
          }
          const baseUrl = body.externalBaseUrl?.trim();
          if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
            return sendJson(res, 400, { error: "中转地址要以 http:// 或 https:// 开头" });
          }
          if (body.externalAuth !== undefined && !["", "x-api-key", "bearer"].includes(body.externalAuth)) {
            return sendJson(res, 400, { error: "验证方式只有 x-api-key 和 bearer 两种" });
          }
          for (const m of [body.externalModel, body.externalHaiku]) {
            if (m !== undefined && (typeof m !== "string" || m.length > 120)) {
              return sendJson(res, 400, { error: "模型名格式不对" });
            }
          }
          setExternal({
            key: body.externalKey,
            baseUrl: body.externalBaseUrl,
            auth: body.externalAuth as "x-api-key" | "bearer" | "" | undefined,
            model: body.externalModel,
            haiku: body.externalHaiku,
          });
        }
        if (body.channel !== undefined) {
          const channel = body.channel as Channel;
          if (!["subscription", "api", "auto"].includes(channel)) {
            return sendJson(res, 400, { error: "没有这个通道" });
          }
          if (channel !== "subscription" && !externalConfigured()) {
            return sendJson(res, 400, { error: "先把外部 API key 填上保存，才能选这两项" });
          }
          setChannel(channel);
        }
        // 通道/外部配置是进程启动时注入环境变量定死的，改了就得让常驻进程全部重开，
        // 否则会出现"切了通道但没生效"的鬼故事
        if (hasExternalField || body.channel !== undefined) clearPool("调用通道配置变了");
        return sendJson(res, 200, publicSettings());
      });
      return;
    }
    return sendJson(res, 200, publicSettings());
  }

  // 模型列表：订阅是固定仨别名；外部的从官方/中转现拉（中转的模型名常跟官方不一样）
  if (url.pathname === "/api/models") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    listExternalModels(url.searchParams.get("refresh") === "1")
      .then((ext) => sendJson(res, 200, {
        subscription: SUBSCRIPTION_MODELS,
        external: ext.models,
        externalError: ext.error || "",
        externalConfigured: externalConfigured(),
      }))
      .catch((err) => sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) }));
    return;
  }

  // 语音通话：一轮 = 收音频 → 转文字 → 麦穗说话 → 合成语音（需要口令）
  if (url.pathname === "/api/call/turn" && req.method === "POST") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    if (!sttEnabled() || !ttsEnabled()) {
      return sendJson(res, 503, { error: "通话没配置好：.env 里要有 ELEVENLABS_KEY 和 ELEVENLABS_VOICE" });
    }
    const mime = url.searchParams.get("mime") || "audio/mp4";
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 25 * 1024 * 1024) {
        req.destroy();
        return sendJson(res, 413, { error: "这段语音太长了" });
      }
      chunks.push(chunk);
    });
    req.on("end", async () => {
      try {
        const audio = Buffer.concat(chunks);
        if (audio.length < 200) return sendJson(res, 400, { error: "没录到声音" });

        const userText = await transcribe(audio, mime);
        if (!userText) return sendJson(res, 200, { empty: true, hint: "没听清，再说一遍？" });
        if (isDraining(Date.now())) return sendJson(res, 409, { error: "正在重启，稍等再说" });

        // 通话有自己的会话（mode=call），记录进历史，聊天页也能翻到
        const record = (url.searchParams.get("session") && store.get(url.searchParams.get("session")!)) || store.create("call");
        if (compacting.has(record.id)) return sendJson(res, 409, { error: "这个会话正在瘦身，稍等几秒" });
        if (record.messages.length === 0) {
          const d = new Date();
          record.title = `通话 ${d.getMonth() + 1}.${d.getDate()}`;
        }
        record.messages.push({ id: randomUUID(), role: "user", text: userText, at: new Date().toISOString() });
        store.save(record);
        // 通话走老的 resume 路：同会话有常驻进程时先收干净，防止 fork 分叉
        await dropPooled(record.id);
        burnBeforeResume(record);

        // 说一轮：不动工具、不开思考，快点回话要紧；auto 通道下订阅翻车就换外部 API 再试一次
        const speak = (useApi: boolean) =>
          new Promise<string>((resolve, reject) => {
            runTurn(
              {
                prompt: userText,
                resume: record.claudeSessionId,
                cwd: WORKSPACE,
                permissionMode: PERMISSION_MODE,
                persona: loadPersona(),
                modePrompt: loadModePrompt("call"),
                model: modelForChannel(useApi, process.env.CLAUDE_MODEL || "claude-opus-4-7"),
                maxTurns: 1,
                thinking: false,
                now: nowString(),
                env: channelEnv(useApi),
              },
              {
                onClaudeSession(id) {
                  record.claudeSessionId = id;
                  store.save(record);
                },
                onDelta() {},
                onTool() {},
                onDone(finalText) {
                  // API 报错被 CLI 当正文吐出来的情况：剥掉；一句真话都不剩就算这轮失败
                  const { clean, apiError } = splitApiError(finalText);
                  if (apiError && !clean) reject(new Error(apiErrorNote(apiError)));
                  else resolve(clean);
                },
                onError(message) {
                  reject(new Error(message));
                },
              },
            );
          });

        let useApi = useApiNow();
        let replyText: string;
        try {
          replyText = await speak(useApi);
        } catch (err) {
          if (!useApi && getSettings().channel === "auto" && externalConfigured()) {
            console.error(`[call] 订阅通道失败（${err instanceof Error ? err.message.slice(0, 120) : err}），换外部 API 重试`);
            useApi = true;
            replyText = await speak(true);
          } else {
            throw err;
          }
        }
        if (!replyText.trim()) throw new Error("这轮没说出话来");

        record.messages.push({ id: randomUUID(), role: "assistant", text: replyText, at: new Date().toISOString() });
        store.save(record);

        const { audio: reply, contentType } = await synthesize(replyText);
        sendJson(res, 200, {
          sessionId: record.id,
          userText,
          replyText,
          audio: Buffer.from(reply).toString("base64"),
          mime: contentType,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[call] ${message}`);
        sendJson(res, 502, { error: message });
      }
    });
    return;
  }

  // 收藏室：纪念册条目（需要口令）
  if (url.pathname === "/api/keepsakes") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    try {
      const items = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "keepsakes.json"), "utf8"));
      return sendJson(res, 200, items);
    } catch {
      return sendJson(res, 200, []);
    }
  }

  // 翻译思考内容（需要口令）
  if (url.pathname === "/api/translate" && req.method === "POST") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      let body: { text?: string };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return sendJson(res, 400, { error: "消息格式不对" });
      }
      const text = String(body.text || "").trim();
      if (!text) return sendJson(res, 400, { error: "没有可翻的内容" });
      try {
        sendJson(res, 200, { text: await translateThinking(text) });
      } catch (err) {
        console.error(`[translate] ${err instanceof Error ? err.message : String(err)}`);
        sendJson(res, 502, { error: "翻译失败，稍后再试" });
      }
    });
    return;
  }

  // 记忆图：整张星图数据
  if (url.pathname === "/api/memory/graph") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    return sendJson(res, 200, getGraph());
  }
  const memoryEntityMatch = url.pathname.match(/^\/api\/memory\/entity\/(\d+)$/);
  if (memoryEntityMatch) {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    const detail = getEntityDetail(Number(memoryEntityMatch[1]));
    return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: "找不到该实体" });
  }
  const memoryCoreMatch = url.pathname.match(/^\/api\/memory\/core\/(ze|maisui)$/);
  if (memoryCoreMatch) {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    return sendJson(res, 200, getCoreDetail(memoryCoreMatch[1] as "ze" | "maisui"));
  }

  // 首页招呼语：麦穗写给泽的一句话，30 分钟缓存
  if (url.pathname === "/api/greeting") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    return getGreeting().then(
      (text) => sendJson(res, 200, { text }),
      () => sendJson(res, 200, { text: "" }),
    );
  }

  // 首页天气：走服务端代理，Open-Meteo 免 key，缓存 15 分钟
  if (url.pathname === "/api/weather") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    return getWeather().then(
      (w) => (w ? sendJson(res, 200, w) : sendJson(res, 502, { error: "天气拿不到" })),
      () => sendJson(res, 502, { error: "天气拿不到" }),
    );
  }

  // API：会话列表 / 会话内容（需要口令）
  if (url.pathname === "/api/sessions") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    return sendJson(res, 200, store.list());
  }
  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})$/);
  if (sessionMatch) {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    if (req.method === "DELETE") {
      return store.delete(sessionMatch[1])
        ? sendJson(res, 200, { ok: true })
        : sendJson(res, 404, { error: "没有这个会话" });
    }
    const record = store.get(sessionMatch[1]);
    return record ? sendJson(res, 200, record) : sendJson(res, 404, { error: "没有这个会话" });
  }
  const messageDeleteMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/messages$/);
  if (messageDeleteMatch && req.method === "DELETE") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    const record = store.get(messageDeleteMatch[1]);
    if (!record) return sendJson(res, 404, { error: "没有这个会话" });
    if (activeTurns.has(record.id) || pool.get(record.id)?.session.busy) {
      return sendJson(res, 409, { error: "正在说话，这轮说完再删" });
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      let body: { id?: string };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return sendJson(res, 400, { error: "消息格式不对" });
      }
      const messageId = String(body.id || "").trim();
      if (!messageId) return sendJson(res, 400, { error: "消息格式不对" });
      // 收 body 的间隙也可能刚好起了一轮，落刀前再看一次。
      if (activeTurns.has(record.id) || pool.get(record.id)?.session.busy) {
        return sendJson(res, 409, { error: "正在说话，这轮说完再删" });
      }
      await dropPooled(record.id);
      const deleted = store.deleteMessage(record.id, messageId);
      return deleted
        ? sendJson(res, 200, { ok: true })
        : sendJson(res, 409, { error: "消息对不上，刷新后再试" });
    });
    return;
  }
  const truncateMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/truncate$/);
  if (truncateMatch && req.method === "POST") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    const record = store.get(truncateMatch[1]);
    if (!record) return sendJson(res, 404, { error: "没有这个会话" });
    if (activeTurns.has(record.id) || pool.get(record.id)?.session.busy) {
      return sendJson(res, 409, { error: "正在说话，这轮说完再操作" });
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      let body: { fromId?: unknown };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return sendJson(res, 400, { error: "消息格式不对" });
      }
      const fromId = typeof body?.fromId === "string" ? body.fromId.trim() : "";
      if (!fromId) return sendJson(res, 400, { error: "消息格式不对" });
      // 收 body 的间隙也可能刚好起了一轮，落刀前再看一次。
      if (activeTurns.has(record.id) || pool.get(record.id)?.session.busy) {
        return sendJson(res, 409, { error: "正在说话，这轮说完再操作" });
      }
      await dropPooled(record.id);
      const truncated = store.truncateFrom(record.id, fromId);
      return truncated
        ? sendJson(res, 200, { ok: true, removed: truncated.removed })
        : sendJson(res, 409, { error: "消息对不上，刷新后再试" });
    });
    return;
  }
  const renameMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/rename$/);
  if (renameMatch && req.method === "POST") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: { title?: string };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return sendJson(res, 400, { error: "消息格式不对" });
      }
      const title = String(body.title || "").trim();
      if (!title) return sendJson(res, 400, { error: "标题不能为空" });
      const record = store.rename(renameMatch[1], title);
      return record
        ? sendJson(res, 200, { id: record.id, title: record.title })
        : sendJson(res, 404, { error: "没有这个会话" });
    });
    return;
  }
  // 会话瘦身（手动挡）：对这个会话发一次 /compact。压大会话要一阵，压完才回话
  const compactMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/compact$/);
  if (compactMatch && req.method === "POST") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    const record = store.get(compactMatch[1]);
    if (!record) return sendJson(res, 404, { error: "没有这个会话" });
    if (!record.claudeSessionId) return sendJson(res, 400, { error: "这个会话还没聊过，没东西可压" });
    if (compacting.has(record.id)) return sendJson(res, 409, { error: "正在瘦身，别重复点" });
    runCompact(record).then(
      () => sendJson(res, 200, { ok: true }),
      (err) => sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) }),
    );
    return;
  }

  // 挪文件夹：folder 传空串 = 移出文件夹
  const folderMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/folder$/);
  if (folderMatch && req.method === "POST") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: { folder?: string };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return sendJson(res, 400, { error: "消息格式不对" });
      }
      const record = store.setFolder(folderMatch[1], String(body.folder ?? ""));
      return record
        ? sendJson(res, 200, { id: record.id, folder: record.folder ?? "" })
        : sendJson(res, 404, { error: "没有这个会话" });
    });
    return;
  }

  // 静态文件
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const filePath = path.join(publicDir, rel);
  if (!filePath.startsWith(publicDir + path.sep) && filePath !== path.join(publicDir, "index.html")) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      // 界面文件禁止缓存，更新后刷新一次就是最新的，不用清缓存
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: "/ws" });

// 手机是否有人正盯着？连接掉了才推 Bark，别打扰她
function anyoneWatching(): boolean {
  for (const c of wss.clients) if (c.readyState === c.OPEN) return true;
  return false;
}

wss.on("connection", (ws: WebSocket, req) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (!authed(url)) {
    ws.send(JSON.stringify({ type: "error", message: "口令不对" }));
    ws.close();
    return;
  }

  let lastSessionId: string | null = null;
  const send = (payload: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };

  // 前端传来的模型：别名、外部列表里的、手填的完整型号都认，只挡明显不像模型名的垃圾
  const looksLikeModelId = (m: string) => /^[\w][\w.:/-]{0,119}$/.test(m) && m !== "__custom";

  ws.on("message", (raw) => {
    let msg: { type?: string; sessionId?: string; text?: string; mode?: string; attachments?: Attachment[]; model?: string };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return send({ type: "error", message: "消息格式不对" });
    }

    if (msg.type === "attach") {
      // 一条连接同一刻只展示一个会话；切走后旧轮继续跑，只是不再往这个页面送。
      for (const turn of activeTurns.values()) if (turn.outRef.send === send) turn.outRef.send = silentSend;
      for (const entry of pool.values()) if (entry.emitRef.send === send) entry.emitRef.send = silentSend;
      const id = typeof msg.sessionId === "string" ? msg.sessionId : "";
      if (!id) return;
      lastSessionId = id;
      const entry = pool.get(id);
      if (entry) entry.emitRef.send = send;
      const turn = activeTurns.get(id);
      if (!turn) {
        send(attachmentPayload(id));
        return;
      }
      // 改出口和取快照都在同一个同步栈里；其后才可能处理下一段 delta，不重不漏。
      turn.outRef.send = send;
      send(attachmentPayload(id, turn));
      return;
    }

    if (msg.type === "interrupt") {
      const id = typeof msg.sessionId === "string" && msg.sessionId ? msg.sessionId : lastSessionId;
      const turn = id ? activeTurns.get(id) : undefined;
      if (turn) interruptActiveTurn(turn);
      return;
    }

    if (msg.type === "pat") {
      // 拍一拍如果没在已有会话里就新建一个，走默认 chat 模式
      const record = (msg.sessionId && store.get(msg.sessionId)) || store.create();
      if (activeTurns.has(record.id)) return send({ type: "error", message: "上一条还在跑，等等或者先打断" });
      if (isDraining(Date.now())) return send({ type: "error", message: "正在重启，稍等重发" });
      if (compacting.has(record.id)) return send({ type: "error", message: "这个会话正在瘦身，等几秒再拍" });
      // 拍一拍不改标题；存历史用固定文本，前端识别后显示成居中小字
      record.messages.push({ id: randomUUID(), role: "user", text: "（拍了拍你）", at: new Date().toISOString() });
      store.save(record);
      send({ type: "session", sessionId: record.id, title: record.title, mode: record.mode });
      lastSessionId = record.id;
      const turn = startActiveTurn(record, send);

      // 拍一拍不动工具，就不装 mcpServers；模式提示词还是照常挂
      // auto 通道下订阅翻车（还没吐内容时）就换外部 API 重拍一次，跟主聊天同款逻辑
      const launchPat = (useApi: boolean, isRetry: boolean) => {
        if (activeTurns.get(record.id) !== turn) return;
        let gotOutput = false;
        turn.handle = runTurn(
          {
            prompt: "（泽拍了拍你，用一两句话回应，别干活）",
            resume: record.claudeSessionId,
            cwd: WORKSPACE,
            permissionMode: PERMISSION_MODE,
            persona: loadPersona(),
            modePrompt: loadModePrompt(record.mode),
            model: modelForChannel(useApi, process.env.CLAUDE_MODEL || "claude-opus-4-7"),
            maxTurns: 1,
            now: nowString(),
            env: channelEnv(useApi),
          },
          {
            onClaudeSession(claudeSessionId) {
              if (activeTurns.get(record.id) !== turn) return;
              record.claudeSessionId = claudeSessionId;
              store.save(record);
            },
            onDelta(text) {
              if (activeTurns.get(record.id) !== turn) return;
              gotOutput = true;
              sendTurnEvent(turn, { type: "delta", text });
            },
            onTool(tool) {
              if (activeTurns.get(record.id) !== turn) return;
              gotOutput = true;
              sendTurnEvent(turn, { type: "tool", name: tool.name, detail: tool.detail });
            },
            onDone(finalText, tools) {
              if (activeTurns.get(record.id) !== turn) return;
              if (
                !isRetry && !useApi && getSettings().channel === "auto" && externalConfigured() &&
                tools.length === 0 && finalText.length < 160 && looksLikeLimitError(finalText)
              ) {
                console.error(`[pat] 订阅额度用尽（${finalText.slice(0, 80)}），换外部 API 重试`);
                sendTurnEvent(turn, { type: "channel_fallback" });
                resetActiveTurn(turn);
                launchPat(true, true);
                return;
              }
              const { clean, apiError } = splitApiError(finalText);
              if (apiError) {
                console.error(`[pat] CLI 把 API 报错当正文吐了：${apiError.slice(0, 160)}`);
                sendTurnEvent(turn, { type: "error", message: apiErrorNote(apiError) });
              }
              if (clean) {
                record.messages.push({ id: randomUUID(), role: "assistant", text: clean, tools, at: new Date().toISOString() });
                store.save(record);
              }
              sendTurnEvent(turn, { type: "done", text: clean });
              finishActiveTurn(turn);
              if (!anyoneWatching()) barkPush(apiError ? "麦穗（出错）" : "麦穗", clean || apiError || "这轮没说出话").catch(() => {});
            },
            onError(message) {
              if (activeTurns.get(record.id) !== turn) return;
              if (!isRetry && !useApi && getSettings().channel === "auto" && externalConfigured() && !gotOutput) {
                console.error(`[pat] 订阅通道失败（${message.slice(0, 120)}），换外部 API 重试`);
                sendTurnEvent(turn, { type: "channel_fallback" });
                resetActiveTurn(turn);
                launchPat(true, true);
                return;
              }
              // 半截落库时 persistIncompleteTurn 自己会作废凭证；没吐过字的报错（网络抖、
              // CLI 没起来）转录没动，凭证必须留着，别把一次抖动变成全量重放
              const interrupted = persistIncompleteTurn(turn, "error");
              sendTurnEvent(turn, { type: "error", message, interrupted, incompleteReason: "error" });
              finishActiveTurn(turn);
              if (!anyoneWatching()) barkPush("麦穗（出错）", message).catch(() => {});
            },
          },
        );
        markEngineStarted(turn);
      };
      // 拍一拍走老的 resume 路：同会话有常驻进程时先收干净再拍，防止 fork 分叉
      void dropPooled(record.id).then(() => {
        if (activeTurns.get(record.id) !== turn) return;
        burnBeforeResume(record);
        launchPat(useApiNow(), false);
      });
      return;
    }

    // 附件校验：只认 uploads 目录里真实存在的文件
    const attachments: Attachment[] = (msg.attachments || [])
      .filter((a) => a && typeof a.file === "string")
      .map((a): Attachment => ({
        file: path.basename(a.file),
        name: String(a.name || a.file).slice(0, 120),
        kind: a.kind === "image" ? "image" : "file",
      }))
      .filter((a) => fs.existsSync(path.join(UPLOADS, a.file)));

    const text = msg.text?.trim() || "";
    if (msg.type !== "chat" || (!text && attachments.length === 0)) return;
    const requested = (msg.model || "").trim();
    const model = requested && looksLikeModelId(requested)
      ? requested
      : process.env.CLAUDE_MODEL || "claude-opus-4-7";

    // 已有会话不改 mode；只有新建时才认 msg.mode，未指定就默认 chat
    const record = (msg.sessionId && store.get(msg.sessionId)) || store.create(msg.mode || "chat");
    if (activeTurns.has(record.id)) return send({ type: "error", message: "上一条还在跑，等等或者先打断" });
    // draining 只拦泽发起的新轮；群聊级联的 GPT 轮不拦，让正跑的一批对话完整落地再重启
    if (isDraining(Date.now())) return send({ type: "error", message: "正在重启，稍等重发" });
    if (compacting.has(record.id)) return send({ type: "error", message: "这个会话正在瘦身，等几秒再发" });
    if (record.messages.length === 0) {
      record.title = (text || attachments[0]?.name || "新会话").slice(0, 24);
    }
    // 必须在追加本轮用户消息前判断；重放只含此前历史，当前消息放在重放结束标记之后。
    const replayMessages = !record.claudeSessionId && record.messages.length > 0
      ? record.messages.slice()
      : null;
    record.messages.push({ id: randomUUID(), role: "user", text, attachments, at: new Date().toISOString() });
    store.save(record);
    send({ type: "session", sessionId: record.id, title: record.title, mode: record.mode });
    lastSessionId = record.id;

    // 附件以文件路径的形式告诉他，图片他会用 Read 工具看
    const attLines = attachments
      .map((a) => `[泽发来${a.kind === "image" ? "一张图片" : "一个文件"}「${a.name}」，路径：${path.join(UPLOADS, a.file)}${a.kind === "image" ? "，用 Read 工具查看" : ""}]`)
      .join("\n");
    const base = attLines ? `${attLines}\n\n${text || "（没写字，看内容吧）"}` : text;
    // 群聊：上一轮 GPT 的发言前置进来，麦穗才看得到（GPT 的话不单独烧他一轮）
    const replayBlock = replayMessages ? buildHistoryReplay(replayMessages) : "";
    const gptLines = replayBlock ? "" : unseenGptLines(record);
    const prompt = replayBlock ? `${replayBlock}\n${base}` : gptLines ? `${gptLines}\n\n${base}` : base;

    // 检索记忆期间也先登记为 waiting_model；明确打断会摘掉它，异步回来后不能再启动引擎。
    const turn = startActiveTurn(record, send);
    (async () => {
      let memoryBlock: string | undefined;
      let memoryIds: number[] = [];
      try {
        const memories = text ? await retrieve(text) : [];
        if (memories.length) {
          memoryBlock = formatMemoryBlock(memories, record.mode);
          memoryIds = memories.map((m) => m.id);
        }
      } catch (err) {
        console.error(`[librarian] ${err instanceof Error ? err.message : err}`);
      }
      if (activeTurns.get(record.id) !== turn) return;

      // 聊天走常驻会话池：池里有活进程就直接往流里推，没有就冷启动一个。
      // auto 通道下订阅翻车（还没吐任何内容时）换外部 API 重打一发——launch 自己
      // 会发现池里进程的通道对不上，收掉重开。
      const launch = async (useApi: boolean, isRetry: boolean): Promise<void> => {
        if (activeTurns.get(record.id) !== turn) return;
        let gotOutput = false; // 已经流出过内容就不能重试了，否则前端会看到重复的半截话
        let usage: TurnUsage | undefined; // 本轮账单，onDone 时拿去判断要不要自动瘦身

        let entry = pool.get(record.id);
        if (entry && (!entry.session.alive || entry.useApi !== useApi)) {
          // 死了、或通道对不上：收干净（等 jsonl 落盘）再冷启动，别 resume 出分叉
          await dropPooled(record.id);
          if (activeTurns.get(record.id) !== turn) return;
          entry = undefined;
        }
        if (entry?.session.busy) {
          sendTurnEvent(turn, { type: "error", message: "上一条还在跑，等等或者先打断" });
          finishActiveTurn(turn);
          return;
        }
        if (!entry) {
          // 冷启动。resume 前照常焚附件原文（常驻期间历史在进程内存里，不重读文件，
          // 焚不焚无所谓——阅后即焚降级成冷启动路径的优化）
          burnBeforeResume(record);
          // 自定义工具事件走 emitRef 中转：进程比 WS 连接活得久，手机重连后把出口
          // 指到新连接，模式工具的旧闭包照样能把事件送到眼前的窗口
          const emitRef: PoolEntry["emitRef"] = { send: () => {} };
          const built = getMode(record.mode).buildTools?.((event: ToolEvent) => emitRef.send({ type: "custom", event }));
          // 跨窗口翻历史：所有聊天会话都挂上，麦穗想不起原话时自己去搜别的窗口
          const history = buildHistoryTools(store, record.id, archiveStore);
          const newEntry: PoolEntry = {
            useApi,
            emitRef,
            session: new PersistentSession({
              cwd: WORKSPACE,
              permissionMode: PERMISSION_MODE,
              persona: loadPersona(),
              modePrompt: loadModePrompt(record.mode),
              mcpServers: { ...history.mcpServers, ...built?.mcpServers },
              // 模式没限制白名单就保持全放开（undefined），别因为挂了历史工具反而把 Read/Bash 锁没了
              allowedTools: built?.allowedTools ? [...built.allowedTools, ...history.allowedTools] : undefined,
              model: modelForChannel(useApi, model),
              // 开自适应思考：闲聊模型基本不想，干活才想，想了前端就有卡片看
              thinking: process.env.THINKING !== "off",
              env: channelEnv(useApi),
              resume: record.claudeSessionId,
              onSessionId(id) {
                // init 给一次；常驻期间内部换 id（compact 之类）也从这里跟上
                record.claudeSessionId = id;
                store.save(record);
              },
              onExit() {
                if (pool.get(record.id) === newEntry) {
                  clearTimeout(newEntry.idleTimer);
                  pool.delete(record.id);
                }
              },
            }),
          };
          pool.set(record.id, newEntry);
          entry = newEntry;
        }
        // 事件出口指到"现在这条"连接；闲置回收的表拨回去
        entry.emitRef.send = turn.outRef.send;
        touchPool(record.id, entry);

        turn.handle = entry.session.sendTurn(
          // 时间、记忆块、模型都是随轮次变的，每轮传；模型变了 sendTurn 会先 setModel
          { prompt, memoryBlock, now: nowString(), model: modelForChannel(useApi, model) },
          {
            onDelta(text) {
              if (activeTurns.get(record.id) !== turn) return;
              gotOutput = true;
              sendTurnEvent(turn, { type: "delta", text });
            },
            onThinkingDelta(text) {
              if (activeTurns.get(record.id) !== turn) return;
              gotOutput = true;
              sendTurnEvent(turn, { type: "thinking", text });
            },
            onThinkingPause(ms) {
              if (activeTurns.get(record.id) !== turn) return;
              progressTurn(turn, "waiting_model");
              sendTurnEvent(turn, { type: "thinking_done", ms });
            },
            onTool(tool) {
              if (activeTurns.get(record.id) !== turn) return;
              gotOutput = true;
              sendTurnEvent(turn, { type: "tool", name: tool.name, detail: tool.detail });
            },
            onUsage(u) {
              usage = u;
            },
            onDone(finalText, tools, thinking) {
              if (activeTurns.get(record.id) !== turn) return;
              // 订阅额度耗尽时 CLI 不报错，而是把英文提示当正文吐出来。
              // 只认"短、无工具、命中限额措辞"的组合，避免正经聊到 rate limit 被误杀
              if (
                !isRetry && !useApi && getSettings().channel === "auto" && externalConfigured() &&
                tools.length === 0 && finalText.length < 160 && looksLikeLimitError(finalText)
              ) {
                console.error(`[channel] 订阅额度用尽（${finalText.slice(0, 80)}），换外部 API 重试`);
                sendTurnEvent(turn, { type: "channel_fallback" });
                resetActiveTurn(turn);
                void launch(true, true);
                return;
              }
              const { clean, apiError } = splitApiError(finalText);
              if (apiError) {
                console.error(`[channel] CLI 把 API 报错当正文吐了：${apiError.slice(0, 160)}`);
                sendTurnEvent(turn, { type: "error", message: apiErrorNote(apiError) });
              }
              if (clean) {
                const displayUsage = usage ? { tokens: usage.inputTotal, cache: usage.cacheRead } : undefined;
                record.messages.push({ id: randomUUID(), role: "assistant", text: clean, tools, thinking, usage: displayUsage, at: new Date().toISOString() });
                store.save(record);
                // 后台异步提取记忆碎片；不 await、出错不影响主聊天
                scheduleExtractionIfNeeded(record);
              }
              const attachedSend = turn.outRef.send;
              sendTurnEvent(turn, {
                type: "done",
                text: clean,
                usage: usage ? { tokens: usage.inputTotal, cache: usage.cacheRead } : undefined,
              });
              finishActiveTurn(turn);
              if (!anyoneWatching()) barkPush(apiError ? "麦穗（出错）" : "麦穗", clean || apiError || "这轮没说出话").catch(() => {});
              maybeAutoCompact(record, usage, attachedSend);
              // 群聊：麦穗说完轮到 GPT（看完整上下文后发言或沉默）；handle 挂到
              // 会话级注册表保证可打断；非 group 模式不启动第二轮。
              if (record.mode === "group") {
                const gptTurn = startActiveTurn(record, attachedSend, "gpt");
                const ran = maybeRunGptTurn({
                  record,
                  store,
                  send: (payload) => sendTurnEvent(gptTurn, payload as Record<string, unknown>),
                  notifyIfAway: (title, body) => {
                    if (!anyoneWatching()) barkPush(title, body).catch(() => {});
                  },
                  setActive: (h) => {
                    if (h) {
                      gptTurn.handle = h;
                      markEngineStarted(gptTurn);
                    } else finishActiveTurn(gptTurn);
                  },
                  isActive: () => activeTurns.get(record.id) === gptTurn,
                  // GPT 没吐字的失败照旧不动凭证：thread 留着、seenCount 不动，下轮重喂这批
                  persistIncomplete: () => persistIncompleteTurn(gptTurn, "error"),
                });
                if (!ran) finishActiveTurn(gptTurn);
              }
            },
            onError(message) {
              if (activeTurns.get(record.id) !== turn) return;
              if (!isRetry && !useApi && getSettings().channel === "auto" && externalConfigured() && !gotOutput) {
                console.error(`[channel] 订阅通道失败（${message.slice(0, 120)}），换外部 API 重试`);
                sendTurnEvent(turn, { type: "channel_fallback" });
                resetActiveTurn(turn);
                void launch(true, true);
                return;
              }
              // 半截落库时 persistIncompleteTurn 自己会作废凭证；没吐过字的报错（网络抖、
              // CLI 没起来）转录没动，凭证必须留着，别把一次抖动变成全量重放
              const interrupted = persistIncompleteTurn(turn, "error");
              sendTurnEvent(turn, { type: "error", message, interrupted, incompleteReason: "error" });
              finishActiveTurn(turn);
              if (!anyoneWatching()) barkPush("麦穗（出错）", message).catch(() => {});
            },
          },
        );
        markEngineStarted(turn);
      };
      await launch(useApiNow(), false);
      // 这轮已经推进常驻流，注入成功——把 read_count 打一记；即便本轮失败，"翻过牌"这件事也算数
      if (memoryIds.length) markRetrieved(memoryIds);
    })();
  });

  ws.on("close", () => {
    // 断线只摘展示出口。轮继续跑、照常存档；只有 interrupt 消息能打断。
    for (const turn of activeTurns.values()) if (turn.outRef.send === send) turn.outRef.send = silentSend;
    for (const entry of pool.values()) if (entry.emitRef.send === send) entry.emitRef.send = silentSend;
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`「家」开门了：http://localhost:${PORT}`);
  console.log(`手机在同一 Wi-Fi 下访问 http://<电脑IP>:${PORT}（IP 用 ipconfig 查）`);
  console.log(`工作目录：${WORKSPACE}`);
  startLoginHeartbeat();
});
