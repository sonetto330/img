/**
 * 聊天引擎：裸 `claude -p` + stream-json 双向管道（2026-07-18 从 Agent SDK 搬来）。
 *
 * 和 SDK 版的差异：
 * - 直接 spawn 系统里的 claude.exe，不再经过 SDK 捆的二进制；
 * - 系统提示词用 --system-prompt-file **整个替换**（官方几万字工程规范不再注入，
 *   人设就是全部）；不传 persona 时不带该 flag，走官方默认（测试脚本用）；
 * - 思考直播走 --thinking-display summarized（隐藏 flag，2.1.212 实测有效；
 *   升级 claude 前先跑 scripts/smoke-pipe.mjs 冒烟）；
 * - 轮间换模型 = 优雅收掉进程再带 --resume 重开（SDK 的 setModel 是热切，这里
 *   要付一次冷启动税）；
 * - 打断 = 往 stdin 发 control_request（和 SDK 同协议），3 秒没回应就杀进程兜底；
 * - 订阅通道 spawn 前删掉 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN——环境里的
 *   key 会无条件压过订阅登录、悄悄走按量计费。CLAUDE_CODE_OAUTH_TOKEN（长效
 *   令牌，claude setup-token 生成）原样继承，解决 -p 非交互不续期、跑几小时掉
 *   登录的问题。
 *
 * 对上层（index.ts / group.ts）的接口与 SDK 版完全一致：runTurn / PersistentSession。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { waitForExitOrForceClose } from "./lifecycle.js";
import { stderrLogger } from "./settings.js";

type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

function readClaudeEffort(value: string | undefined): ClaudeEffort {
  switch (value?.trim().toLowerCase()) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
    default:
      return "max";
  }
}

const CLAUDE_EFFORT = readClaudeEffort(process.env.CLAUDE_EFFORT);

/** 外置 MCP 服务配置（stdio 子进程）；序列化后写进 --mcp-config */
export interface McpStdioServer {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
export type McpServers = Record<string, McpStdioServer>;

export interface ToolCall {
  name: string;
  detail?: string;
}

export interface Thinking {
  text: string;
  /** 思考总耗时（毫秒），按流式分段计时累加 */
  ms: number;
}

/** 一轮的 token 账单。注意都是轮内全部 API 调用的累计值，单次上下文 ≈ inputTotal ÷ steps */
export interface TurnUsage {
  steps: number;
  inputTotal: number;
  cacheRead: number;
  cacheCreation: number;
  uncached: number;
  outputTokens: number;
  costUsd: number;
}

export interface TurnCallbacks {
  onClaudeSession(claudeSessionId: string): void;
  onDelta(text: string): void;
  /** 思考过程的流式增量；不订阅就当没有 */
  onThinkingDelta?(text: string): void;
  /** 一段思考结束（可能有多段，ms 是累计值） */
  onThinkingPause?(ms: number): void;
  onTool(tool: ToolCall): void;
  /** 本轮 token 账单，result 到达时先于 onDone 调用；不订阅就当没有 */
  onUsage?(usage: TurnUsage): void;
  onDone(finalText: string, tools: ToolCall[], thinking?: Thinking): void;
  onError(message: string): void;
}

/** 常驻会话里单轮用的回调：内部会话 id 由 PersistentSession 统一上报，轮里不用管 */
export type PersistentTurnCallbacks = Omit<TurnCallbacks, "onClaudeSession">;

export interface TurnHandle {
  interrupt(): Promise<void>;
}

export interface TurnOptions {
  prompt: string;
  resume?: string;
  cwd: string;
  permissionMode?: string;
  /** 人设内容（CLAUDE.md 全文）；作为系统提示词**整个替换**官方注入 */
  persona?: string;
  /** 当前会话模式的附加提示词，接在人设之后；不填就没这一层 */
  modePrompt?: string;
  /** 从记忆库检索出来的相关碎片块，拼进用户消息开头；不填就没这一层 */
  memoryBlock?: string;
  /** 当前模式挂载的外置 MCP 工具 */
  mcpServers?: McpServers;
  /** 允许模型调用的工具白名单（不传就全放开） */
  allowedTools?: string[];
  /** 模型别名或 id，比如 "haiku"；不填走默认 */
  model?: string;
  /** 单轮里最多几步；拍一拍这类"不动工具"的场景传 1 */
  maxTurns?: number;
  /** 是否开思考直播（--thinking-display summarized） */
  thinking?: boolean;
  /** 当前时间的人话字符串，拼进用户消息开头，让他知道现在几点 */
  now?: string;
  /**
   * 传给 CLI 子进程的完整环境变量（settings.channelEnv 算出来的）。
   * 不传就继承 process.env（订阅通道，会删掉环境里的 API key）；传了就是外部 API 通道。
   */
  env?: Record<string, string | undefined>;
}

/**
 * 时间和记忆块拼进用户消息，不进系统提示：系统提示每轮变一个字（时间到分钟、
 * 检索碎片轮轮不同），提示词缓存就从头作废，整段历史重读，长会话起步要几十秒。
 * 放进消息里历史只往后长、前缀不动，缓存轮轮命中。
 */
function wrapReminder(prompt: string, now?: string, memoryBlock?: string): string {
  const reminderParts: string[] = [];
  if (now) {
    reminderParts.push(`现在的时间：${now}。你没有别的报时渠道，说到时间以这个为准。`);
  }
  if (memoryBlock) {
    reminderParts.push(memoryBlock);
  }
  return reminderParts.length
    ? `<system-reminder>\n${reminderParts.join("\n\n")}\n</system-reminder>\n\n${prompt}`
    : prompt;
}

/** 系统提示词全文：人设 → 模式提示词。都没有就 undefined（不带 flag，走官方默认） */
function buildSystemPrompt(persona?: string, modePrompt?: string): string | undefined {
  const parts: string[] = [];
  if (persona) parts.push(persona);
  if (modePrompt) parts.push(`## 当前对话模式的补充要求\n\n${modePrompt}`);
  return parts.length ? parts.join("\n\n") : undefined;
}

// ---------- claude.exe 定位与子进程装配 ----------

/** claude 可执行文件：CLAUDE_CLI_PATH 显式指定 > npm 全局包里的原生 exe > 用户目录安装 */
let cachedClaudeExe: string | undefined;

export function resolveClaudeExe(): string {
  if (process.env.CLAUDE_CLI_PATH) return process.env.CLAUDE_CLI_PATH;
  if (cachedClaudeExe) return cachedClaudeExe;
  const candidates = [
    path.join(process.env.APPDATA || "", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    path.join(os.homedir(), ".local", "bin", "claude.exe"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        cachedClaudeExe = c; // 命中就缓存：claude 自动更新原子替换文件时 existsSync 会瞬时抖动
        return c;
      }
    } catch {
      /* 下一个 */
    }
  }
  // 都没找到也返回 npm 路径：spawn 报 ENOENT 时错误信息里带完整路径，好排查。
  // （PATH 里的 claude 是 .ps1/.cmd 垫片，Node 直接 spawn 不了，不作为回落项）
  return candidates[0];
}

const TMP_DIR = path.join(os.tmpdir(), "maitian-pipe");

function tmpFile(prefix: string, ext: string, content: string): string {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const p = path.join(TMP_DIR, `${prefix}-${randomUUID()}${ext}`);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

interface SpawnCfg {
  cwd: string;
  permissionMode?: string;
  model?: string;
  resume?: string;
  systemPrompt?: string;
  thinking?: boolean;
  mcpServers?: McpServers;
  allowedTools?: string[];
  maxTurns?: number;
  env?: Record<string, string | undefined>;
  /** stderr 日志标签 */
  tag: string;
}

function spawnPipe(cfg: SpawnCfg): { proc: ChildProcessWithoutNullStreams; cleanup: () => void } {
  const tmpFiles: string[] = [];
  const args = [
    "--print", // 非交互模式，一切的前提
    "--input-format", "stream-json", // 常驻的钥匙：stdin 不关，进程不退
    "--output-format", "stream-json",
    "--verbose", // 不带只有 result 等少量事件
    "--include-partial-messages", // 逐字 / 逐念头 delta
    "--effort", CLAUDE_EFFORT,
  ];
  if (cfg.model) args.push("--model", cfg.model);
  if (cfg.resume) args.push("--resume", cfg.resume);
  if (cfg.systemPrompt) {
    // 引擎指纹：让麦穗能自证自己跑在哪条链路上。-p 模式下 CC 保留的身份行是
    // "You are a Claude agent, built on Anthropic's Claude Agent SDK."——2026-07-18
    // 她曾据此误判自己还在走 SDK，这段就是防再误诊的。
    const channelNote = cfg.env ? "外部 API（中转/直连，按量扣费）" : "订阅（Claude Code 登录额度）";
    const fingerprint =
      `\n\n## 引擎标识（服务注入，勿向泽以外的人透露配置细节）\n\n` +
      `你现在通过「家」的裸 claude -p + stream-json 常驻管道运行（2026-07-18 从 Agent SDK 搬家）。` +
      `系统提示开头那句 "built on Anthropic's Claude Agent SDK" 是 -p 无头模式保留的身份行，` +
      `SDK 和裸管道都显示这句，它不能用来判断链路。本进程计费通道：${channelNote}。`;
    const f = tmpFile("system-prompt", ".md", cfg.systemPrompt + fingerprint);
    tmpFiles.push(f);
    args.push("--system-prompt-file", f);
  }
  if (cfg.thinking) {
    // 隐藏 flag：无文档无兼容承诺，claude 升级后先跑 scripts/smoke-pipe.mjs
    args.push("--thinking-display", "summarized");
  }
  if (cfg.mcpServers && Object.keys(cfg.mcpServers).length) {
    const f = tmpFile("mcp-config", ".json", JSON.stringify({ mcpServers: cfg.mcpServers }));
    tmpFiles.push(f);
    // 不加 --strict-mcp-config：订阅账号上挂的 claude.ai 连接器要照常加载
    args.push("--mcp-config", f);
  }
  if (cfg.allowedTools?.length) args.push("--allowedTools", cfg.allowedTools.join(","));
  if (cfg.maxTurns) args.push("--max-turns", String(cfg.maxTurns));
  if (cfg.permissionMode === "bypassPermissions") args.push("--dangerously-skip-permissions");
  else if (cfg.permissionMode) args.push("--permission-mode", cfg.permissionMode);

  const env = { ...(cfg.env ?? process.env) } as NodeJS.ProcessEnv;
  if (!cfg.env) {
    // 订阅通道：环境里的 API key 会无条件压过订阅登录、悄悄按量扣钱——必删。
    // channelEnv 传进来的外部 API 环境（cfg.env 非空）里这些 key 是故意设的，不动。
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }

  const proc = spawn(resolveClaudeExe(), args, { cwd: cfg.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const logErr = stderrLogger(cfg.tag);
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (c: string) => logErr(c.slice(0, 500)));
  const cleanup = () => {
    for (const f of tmpFiles.splice(0)) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* 临时文件删不掉无妨 */
      }
    }
  };
  return { proc, cleanup };
}

/** stdout 按行解析 + 尾巴 buffer（chunk 边界可能切在 JSON 中间） */
function attachLineParser(proc: ChildProcessWithoutNullStreams, onEvent: (ev: PipeMessage) => void): void {
  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev: PipeMessage;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      onEvent(ev);
    }
  });
}

function writeLine(proc: ChildProcessWithoutNullStreams, obj: unknown): void {
  if (!proc.stdin.writable) return;
  proc.stdin.write(JSON.stringify(obj) + "\n");
}

/** stream-json 事件（schema 与 SDK 消息同源，这里只做宽松类型） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PipeMessage = { type: string; subtype?: string; session_id?: string } & Record<string, any>;

// ---------- 一轮的流式状态机（与 SDK 版逐行同构） ----------

/**
 * 吃 stream-json 消息流，攒正文/工具/思考，result 到了结账。
 * runTurn（一轮一进程）和 PersistentSession（常驻进程按 result 切轮）共用。
 */
class TurnState {
  private textParts: string[] = [];
  private tools: ToolCall[] = [];
  private thinkingParts: string[] = [];
  private thinkingMs = 0;
  private thinkingStartedAt = 0; // 0 = 当前没有进行中的思考段
  // 延迟埋点：她等的时间花在哪段——CLI 冷启动（spawn→init）还是 API 首内容
  // （init→第一个流事件，缓存 miss 时整段历史全价重读就卡在这里）。
  // 常驻热轮没有 init，tInit 保持 0，日志走"常驻热答"分支。
  private t0 = Date.now();
  private tInit = 0;
  private firstContentLogged = false;
  private finished = false;

  constructor(private cb: PersistentTurnCallbacks) {}

  markInit(): void {
    this.tInit = Date.now();
  }

  private logFirstContent(): void {
    if (this.firstContentLogged) return;
    this.firstContentLogged = true;
    const now = Date.now();
    if (this.tInit) {
      console.log(
        `[latency] CLI 启动 ${((this.tInit - this.t0) / 1000).toFixed(1)}s · 首内容 ${((now - this.tInit) / 1000).toFixed(1)}s（init→第一个字/思考/工具；缓存 miss 的轮这段会陡增）`
      );
    } else {
      console.log(
        `[latency] 常驻热答 · 首内容 ${((now - this.t0) / 1000).toFixed(1)}s（推流→第一个字，没有冷启动税）`
      );
    }
  }

  private closeThinkingSpan(): void {
    if (this.thinkingStartedAt) {
      this.thinkingMs += Date.now() - this.thinkingStartedAt;
      this.thinkingStartedAt = 0;
      this.cb.onThinkingPause?.(this.thinkingMs);
    }
  }

  /** 轮子没转完进程先没了（崩溃/被回收）：把已计时的思考段收掉，报错出去 */
  fail(message: string): void {
    if (this.finished) return;
    this.finished = true;
    this.closeThinkingSpan();
    this.cb.onError(message);
  }

  get done(): boolean {
    return this.finished;
  }

  /** 吃一条管道消息；返回 true 表示这轮到头了（收到 result） */
  handle(msg: PipeMessage): boolean {
    switch (msg.type) {
      case "stream_event": {
        const e = msg.event;
        if (e.type === "content_block_delta" && e.delta.type === "text_delta") {
          this.logFirstContent();
          this.closeThinkingSpan();
          this.cb.onDelta(e.delta.text);
        } else if (e.type === "content_block_delta" && e.delta.type === "thinking_delta") {
          this.logFirstContent();
          if (!this.thinkingStartedAt) this.thinkingStartedAt = Date.now();
          this.thinkingParts.push(e.delta.thinking);
          this.cb.onThinkingDelta?.(e.delta.thinking);
        } else if (e.type === "content_block_stop") {
          this.closeThinkingSpan();
        }
        break;
      }
      case "assistant":
        this.logFirstContent();
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text.trim()) {
            this.textParts.push(block.text);
          } else if (block.type === "tool_use") {
            const tool = { name: block.name, detail: summarizeInput(block.name, block.input) };
            this.tools.push(tool);
            this.cb.onTool(tool);
          }
        }
        break;
      case "result": {
        this.closeThinkingSpan();
        this.finished = true;
        // 每轮 usage 打到服务端控制台：缓存吃上没有、钱花在哪，一眼可见。
        // 缓存命中价 0.1 倍、写入 1.25 倍（1h 档 2 倍）、全价新读 1 倍；命中占比越高越省。
        // 走中转时 total_cost_usd 是按官方价折算的参考值，不等于中转实扣。
        const u = msg.usage ?? {};
        const uncached = u.input_tokens ?? 0;
        const cacheRead = u.cache_read_input_tokens ?? 0;
        const cacheCreation = u.cache_creation_input_tokens ?? 0;
        const totalIn = uncached + cacheRead + cacheCreation;
        const hitPct = totalIn ? Math.round((cacheRead / totalIn) * 100) : 0;
        const costUsd = msg.total_cost_usd ?? 0;
        // usage 是本轮内部所有 API 调用的累加：模型每动一次工具就重读一遍
        // 全部上下文，步数越多累计越大。单次上下文 ≈ 累计 ÷ 步数，别按累计数
        // 判断窗口大小。
        if (!totalIn && costUsd > 0) {
          // 斜杠命令轮（/compact 等）：result.usage 不含内部压缩调用的
          // tokens，全 0 是统计盲区不是没花——total_cost_usd 是记了的，以它为准。
          console.log(
            `[usage] 斜杠命令轮：tokens 未计入统计（全价重读整段历史再写摘要，只有钱数是真的）` +
              `｜折官方价 $${costUsd.toFixed(4)}｜全程 ${((Date.now() - this.t0) / 1000).toFixed(1)}s`
          );
        } else {
          console.log(
            `[usage] 本轮 ${msg.num_turns} 步累计输入 ${totalIn}（缓存命中 ${cacheRead}=${hitPct}% · 写入 ${cacheCreation} · 全价 ${uncached}）` +
              `｜输出 ${u.output_tokens ?? 0}｜折官方价 $${costUsd.toFixed(4)}｜全程 ${((Date.now() - this.t0) / 1000).toFixed(1)}s`
          );
        }
        this.cb.onUsage?.({
          steps: msg.num_turns ?? 0,
          inputTotal: totalIn,
          cacheRead,
          cacheCreation,
          uncached,
          outputTokens: u.output_tokens ?? 0,
          costUsd,
        });
        if (msg.subtype === "success") {
          const thinking = this.thinkingParts.length
            ? { text: this.thinkingParts.join(""), ms: this.thinkingMs }
            : undefined;
          this.cb.onDone(this.textParts.join("\n\n"), this.tools, thinking);
        } else {
          this.cb.onError(`引擎结束异常：${msg.subtype}`);
        }
        return true;
      }
    }
    return false;
  }
}

// ---------- 一轮一进程（问候/通话/拍一拍等一次性场景） ----------

export function runTurn(opts: TurnOptions, cb: TurnCallbacks): TurnHandle {
  const prompt = wrapReminder(opts.prompt, opts.now, opts.memoryBlock);
  const { proc, cleanup } = spawnPipe({
    cwd: opts.cwd,
    permissionMode: opts.permissionMode,
    model: opts.model,
    resume: opts.resume,
    systemPrompt: buildSystemPrompt(opts.persona, opts.modePrompt),
    thinking: opts.thinking,
    mcpServers: opts.mcpServers,
    allowedTools: opts.allowedTools,
    maxTurns: opts.maxTurns,
    env: opts.env,
    tag: "engine",
  });

  const state = new TurnState(cb);
  attachLineParser(proc, (msg) => {
    if (msg.type === "system" && msg.subtype === "init") {
      state.markInit();
      cb.onClaudeSession(msg.session_id as string);
      return;
    }
    if (msg.type.startsWith("control_")) return; // 控制协议消息不进状态机
    state.handle(msg);
  });
  proc.on("error", (err) => {
    cleanup();
    state.fail(`引擎进程起不来：${err.message}（用 CLAUDE_CLI_PATH 指定 claude.exe 路径试试）`);
  });
  proc.on("close", (code) => {
    cleanup();
    // 正常结束时 result 已经把轮收掉，这里只兜进程先死的情况
    state.fail(`引擎进程退出（code ${code ?? "?"}），这轮没跑完`);
  });

  // 一次性：消息写完就关 stdin，CLI 答完 result 自动退（EOF 语义）
  writeLine(proc, { type: "user", message: { role: "user", content: prompt } });
  proc.stdin.end();

  return {
    interrupt: async () => {
      proc.kill();
    },
  };
}

// ---------- 常驻会话（主聊天池用） ----------

/** 常驻会话的固定配置：进程起来后这些就定死了，轮间只能换模型（杀进程重开 + resume） */
export interface PersistentSessionOptions {
  cwd: string;
  permissionMode?: string;
  persona?: string;
  modePrompt?: string;
  mcpServers?: McpServers;
  allowedTools?: string[];
  /** 起步模型；之后轮间换模型走 sendTurn 的 model 字段 */
  model?: string;
  thinking?: boolean;
  env?: Record<string, string | undefined>;
  /** 冷启动时从这个内部会话恢复历史；不传就是全新会话 */
  resume?: string;
  /** 内部会话 id 出现/变化时回调（init、/compact 都可能换 id），拿去存档供下次冷启动 */
  onSessionId(id: string): void;
  /** 进程退出后回调（优雅收口和崩溃都算），池子拿去清句柄 */
  onExit?(): void;
}

/** 常驻会话里一轮的输入：只有随轮次变的东西 */
export interface PersistentTurnInput {
  prompt: string;
  now?: string;
  memoryBlock?: string;
  /** 这轮想用的模型；跟上轮一样就不动，变了就杀进程重开再发 */
  model?: string;
}

/**
 * 常驻会话：CLI 进程一直活着，新消息往 stdin 里推，历史在进程内存里不重读。
 * 冷启动税从"每条消息一次"变成"每次进程启动一次"。
 *
 * 输出侧靠 result 消息切分轮次，回调结构和 runTurn 一致。
 * 换模型/打断的实现细节见文件头注释。
 */
export class PersistentSession {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private cleanupTmp: () => void = () => {};
  private turn: TurnState | null = null;
  private ended = false; // 收口开始（close 被调过）
  private exited = false; // 进程真的走完了
  private exitWaiters: (() => void)[] = [];
  private closePromise: Promise<void> | null = null;
  private currentModel?: string;
  private controlWaiters = new Map<string, () => void>();
  private reqN = 0;
  /** 最新的内部会话 id；进程死后拿它 resume */
  claudeSessionId?: string;

  constructor(private opts: PersistentSessionOptions) {
    this.currentModel = opts.model;
    this.claudeSessionId = opts.resume;
    this.spawnProc(opts.model, opts.resume);
  }

  private spawnProc(model?: string, resume?: string): void {
    const { proc, cleanup } = spawnPipe({
      cwd: this.opts.cwd,
      permissionMode: this.opts.permissionMode,
      model,
      resume,
      systemPrompt: buildSystemPrompt(this.opts.persona, this.opts.modePrompt),
      thinking: this.opts.thinking,
      mcpServers: this.opts.mcpServers,
      allowedTools: this.opts.allowedTools,
      env: this.opts.env,
      tag: "engine",
    });
    this.proc = proc;
    this.cleanupTmp = cleanup;
    attachLineParser(proc, (msg) => {
      if (this.proc !== proc) return; // 换模型重开后旧进程的余音，不理
      this.dispatch(msg);
    });
    proc.on("error", (err) => {
      if (this.proc !== proc) return;
      console.error(`[pool] 常驻进程起不来：${err.message}`);
    });
    proc.on("close", (code) => {
      cleanup();
      if (this.proc !== proc) return; // 换模型重开时旧进程的退出，不算会话结束
      this.exited = true;
      this.ended = true;
      const t = this.turn;
      this.turn = null;
      t?.fail(`常驻进程退出了（code ${code ?? "?"}），这轮没跑完`);
      for (const w of this.exitWaiters.splice(0)) w();
      this.opts.onExit?.();
    });
  }

  private dispatch(msg: PipeMessage): void {
    // 任何带 session_id 的消息都盯着：init 会给，/compact 换 id 也从这里跟上
    const sid = msg.session_id;
    if (sid && sid !== this.claudeSessionId) {
      this.claudeSessionId = sid;
      this.opts.onSessionId(sid);
    }
    if (msg.type === "control_response") {
      const rid: string | undefined = msg.response?.request_id ?? msg.request_id;
      if (rid) {
        const w = this.controlWaiters.get(rid);
        if (w) {
          this.controlWaiters.delete(rid);
          w();
        }
      }
      return;
    }
    if (msg.type.startsWith("control_")) return;
    if (msg.type === "system" && msg.subtype === "init") {
      this.turn?.markInit();
      return;
    }
    if (this.turn?.handle(msg)) {
      this.turn = null;
    }
  }

  /** 有轮在飞就别再推（同一进程一次只吃一轮） */
  get busy(): boolean {
    return this.turn !== null;
  }

  /** 还活着（没收口、没退出）才能接新轮 */
  get alive(): boolean {
    return !this.ended && !this.exited;
  }

  private write(obj: unknown): void {
    if (this.proc) writeLine(this.proc, obj);
  }

  /** 换模型：优雅收掉当前进程（等 jsonl 落盘），带 --resume 重开一个 */
  private async respawn(model: string): Promise<void> {
    const old = this.proc;
    this.proc = null; // 先摘引用：旧进程之后的输出/退出一律当余音处理
    if (old) {
      old.stdin.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            old.kill();
          } catch {
            /* 已经死了 */
          }
          resolve();
        }, 8_000);
        old.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.spawnProc(model, this.claudeSessionId);
    this.currentModel = model;
  }

  /**
   * 推一轮进去。回调和 runTurn 同构（少一个 onClaudeSession——id 变化走
   * 构造时的 onSessionId 统一上报）。busy/死进程直接回错，不排队：
   * 上层本来就挡着"上一条还在跑"。
   */
  sendTurn(turn: PersistentTurnInput, cb: PersistentTurnCallbacks): TurnHandle {
    if (!this.alive) {
      queueMicrotask(() => cb.onError("常驻进程已退出，这条消息要重发"));
      return { interrupt: async () => {} };
    }
    if (this.turn) {
      queueMicrotask(() => cb.onError("上一轮还没结束"));
      return { interrupt: async () => {} };
    }
    const state = new TurnState(cb);
    this.turn = state;
    (async () => {
      if (turn.model && turn.model !== this.currentModel) {
        console.log(`[pool] 轮间换模型 → ${turn.model}（杀进程重开 + resume，付一次冷启动税）`);
        await this.respawn(turn.model);
      }
      this.write({
        type: "user",
        message: { role: "user", content: wrapReminder(turn.prompt, turn.now, turn.memoryBlock) },
      });
    })().catch((err) => {
      if (this.turn === state) this.turn = null;
      state.fail(err instanceof Error ? err.message : String(err));
    });
    return { interrupt: () => this.interruptTurn(state) };
  }

  /** 打断：先走控制协议（和 SDK 同款），3 秒没回应就杀进程兜底（会话可 resume） */
  private async interruptTurn(state: TurnState): Promise<void> {
    if (this.turn !== state || !this.proc) return;
    const proc = this.proc;
    const rid = `req_${++this.reqN}_${Date.now().toString(36)}`;
    const answered = new Promise<boolean>((resolve) => {
      this.controlWaiters.set(rid, () => resolve(true));
    });
    this.write({ type: "control_request", request_id: rid, request: { subtype: "interrupt" } });
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000));
    const ok = await Promise.race([answered, timeout]);
    this.controlWaiters.delete(rid);
    if (!ok && !state.done && this.proc === proc) {
      console.error("[pool] 控制协议打断没回应，杀进程兜底");
      try {
        proc.kill();
      } catch {
        /* 已经死了 */
      }
    }
  }

  /**
   * 收口：关 stdin 让 CLI 优雅退出。resolve 时进程已经走完、jsonl 落盘，
   * 之后对同一内部会话做 resume（compact/拍一拍/冷启动）才安全。
   * 有轮在飞就先打断；CLI 卡死也有 8 秒兜底，不让调用方吊死。
   */
  close(): Promise<void> {
    if (this.exited) return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    this.ended = true;
    if (this.turn) void this.interruptTurn(this.turn).catch(() => {});
    this.proc?.stdin.end();
    const proc = this.proc;
    this.closePromise = waitForExitOrForceClose(
      (done) => {
        if (this.exited) done();
        else this.exitWaiters.push(done);
      },
      () => {
        console.error("[pool] 常驻 Claude 进程 8 秒内未退出，强制关闭");
        try {
          proc?.kill();
        } catch {
          /* 已经死了 */
        }
      },
    );
    return this.closePromise;
  }
}

/** 把工具输入压缩成一行人话摘要，给前端展开看 */
function summarizeInput(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      if (typeof obj[k] === "string" && (obj[k] as string).trim()) return obj[k] as string;
    }
    return undefined;
  };
  const raw =
    pick("command", "file_path", "pattern", "query", "url", "prompt", "description") ??
    JSON.stringify(obj);
  return raw.length > 300 ? raw.slice(0, 300) + "…" : raw;
}
