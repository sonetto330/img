import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { stderrLogger } from "./settings.js";

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
  permissionMode: Options["permissionMode"];
  /** 人设内容（CLAUDE.md 全文），每一轮都直接注入系统提示，保证生效 */
  persona?: string;
  /** 当前会话模式的附加提示词，接在人设之后；不填就没这一层 */
  modePrompt?: string;
  /** 从记忆库检索出来的相关碎片块，拼进用户消息开头；不填就没这一层 */
  memoryBlock?: string;
  /** 当前模式挂载的 SDK MCP 工具 */
  mcpServers?: Options["mcpServers"];
  /** 允许模型调用的工具白名单（不传就用 SDK 默认全放开） */
  allowedTools?: string[];
  /** 模型别名或 id，比如 "haiku"；不填走默认 */
  model?: string;
  /** 单轮里最多几步；拍一拍这类"不动工具"的场景传 1 */
  maxTurns?: number;
  /** 是否开思考；开了模型自己决定想多少（adaptive） */
  thinking?: boolean;
  /** 当前时间的人话字符串，拼进用户消息开头，让他知道现在几点 */
  now?: string;
  /**
   * 传给 CLI 子进程的完整环境变量（settings.channelEnv 算出来的）。
   * 不传就继承 process.env（订阅通道）；传了就是外部 API 通道。
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

/** 系统提示 append 只放不随轮次变的稳定层：人设 → 模式提示词 */
function buildAppend(persona?: string, modePrompt?: string): string | undefined {
  const appendParts: string[] = [];
  if (persona) {
    appendParts.push(`以下是你的身份设定，任何时候都遵守：\n\n${persona}`);
  }
  if (modePrompt) {
    appendParts.push(`当前对话模式的补充要求：\n\n${modePrompt}`);
  }
  return appendParts.length ? "\n" + appendParts.join("\n\n") : undefined;
}

/**
 * 一轮的流式状态机：吃 SDK 消息流，攒正文/工具/思考，result 到了结账。
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

  /** 吃一条 SDK 消息；返回 true 表示这轮到头了（收到 result） */
  handle(msg: SDKMessage): boolean {
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
        const u = msg.usage;
        const totalIn = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
        const hitPct = totalIn ? Math.round((u.cache_read_input_tokens / totalIn) * 100) : 0;
        // usage 是本轮内部所有 API 调用的累加：模型每动一次工具就重读一遍
        // 全部上下文，步数越多累计越大。单次上下文 ≈ 累计 ÷ 步数，别按累计数
        // 判断窗口大小。
        if (!totalIn && msg.total_cost_usd > 0) {
          // 斜杠命令轮（/compact 等）：SDK 的 result.usage 不含内部压缩调用的
          // tokens，全 0 是统计盲区不是没花——total_cost_usd 是记了的，以它为准。
          console.log(
            `[usage] 斜杠命令轮：tokens 未计入 SDK 统计（全价重读整段历史再写摘要，只有钱数是真的）` +
              `｜折官方价 $${msg.total_cost_usd.toFixed(4)}｜全程 ${((Date.now() - this.t0) / 1000).toFixed(1)}s`
          );
        } else {
          console.log(
            `[usage] 本轮 ${msg.num_turns} 步累计输入 ${totalIn}（缓存命中 ${u.cache_read_input_tokens}=${hitPct}% · 写入 ${u.cache_creation_input_tokens} · 全价 ${u.input_tokens}）` +
              `｜输出 ${u.output_tokens}｜折官方价 $${msg.total_cost_usd.toFixed(4)}｜全程 ${((Date.now() - this.t0) / 1000).toFixed(1)}s`
          );
        }
        this.cb.onUsage?.({
          steps: msg.num_turns,
          inputTotal: totalIn,
          cacheRead: u.cache_read_input_tokens,
          cacheCreation: u.cache_creation_input_tokens,
          uncached: u.input_tokens,
          outputTokens: u.output_tokens,
          costUsd: msg.total_cost_usd,
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

export function runTurn(opts: TurnOptions, cb: TurnCallbacks): TurnHandle {
  const prompt = wrapReminder(opts.prompt, opts.now, opts.memoryBlock);
  const append = buildAppend(opts.persona, opts.modePrompt);

  const q = query({
    prompt,
    options: {
      cwd: opts.cwd,
      resume: opts.resume,
      permissionMode: opts.permissionMode,
      includePartialMessages: true,
      model: opts.model,
      maxTurns: opts.maxTurns,
      // display 必须给：不给的话思考内容不外发，前端什么都收不到（实测）
      thinking: opts.thinking ? { type: "adaptive", display: "summarized" } : undefined,
      mcpServers: opts.mcpServers,
      allowedTools: opts.allowedTools,
      env: opts.env,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append,
      },
      // 引擎报错时把详细原因打到服务端控制台，方便排查
      stderr: stderrLogger("engine"),
    },
  });

  const state = new TurnState(cb);

  (async () => {
    try {
      for await (const msg of q) {
        if (msg.type === "system" && msg.subtype === "init") {
          state.markInit();
          cb.onClaudeSession(msg.session_id);
          continue;
        }
        state.handle(msg);
      }
    } catch (err) {
      cb.onError(err instanceof Error ? err.message : String(err));
    }
  })();

  return {
    interrupt: () => q.interrupt(),
  };
}

/** 常驻会话的固定配置：进程起来后这些就定死了，轮间只能换模型（setModel） */
export interface PersistentSessionOptions {
  cwd: string;
  permissionMode: Options["permissionMode"];
  persona?: string;
  modePrompt?: string;
  mcpServers?: Options["mcpServers"];
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
  /** 这轮想用的模型；跟上轮一样就不动，变了就先 setModel 再发 */
  model?: string;
}

/**
 * 常驻会话：CLI 进程一直活着，新消息往输入流里推，历史在进程内存里不重读。
 * 冷启动税从"每条消息一次"变成"每次进程启动一次"。
 *
 * 输入侧：消息队列包装成 AsyncIterable 喂给 query()（SDK 的流式输入模式）；
 * 输出侧：一个泵持续读消息流，靠 result 消息切分轮次，回调结构和 runTurn 一致。
 */
export class PersistentSession {
  private q: Query;
  private inbox: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false; // 输入流已收口（close 被调过）
  private exited = false; // 进程真的走完了（输出泵结束）
  private exitWaiters: (() => void)[] = [];
  private turn: TurnState | null = null;
  private currentModel?: string;
  /** 最新的内部会话 id；进程死后拿它 resume */
  claudeSessionId?: string;

  constructor(private opts: PersistentSessionOptions) {
    this.currentModel = opts.model;
    this.claudeSessionId = opts.resume;
    this.q = query({
      prompt: this.inputStream(),
      options: {
        cwd: opts.cwd,
        resume: opts.resume,
        permissionMode: opts.permissionMode,
        includePartialMessages: true,
        model: opts.model,
        thinking: opts.thinking ? { type: "adaptive", display: "summarized" } : undefined,
        mcpServers: opts.mcpServers,
        allowedTools: opts.allowedTools,
        env: opts.env,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: buildAppend(opts.persona, opts.modePrompt),
        },
        stderr: stderrLogger("engine"),
      },
    });
    void this.pump();
  }

  /** 有轮在飞就别再推（同一进程一次只吃一轮） */
  get busy(): boolean {
    return this.turn !== null;
  }

  /** 还活着（没收口、没退出）才能接新轮 */
  get alive(): boolean {
    return !this.ended && !this.exited;
  }

  private async *inputStream(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.inbox.length) yield this.inbox.shift()!;
      if (this.ended) return; // 生成器 return → CLI 收到 stdin EOF → 优雅退出
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private push(msg: SDKUserMessage): void {
    this.inbox.push(msg);
    this.wake?.();
    this.wake = null;
  }

  /** 输出泵：进程活多久转多久，按 result 切轮 */
  private async pump(): Promise<void> {
    let crash: string | undefined;
    try {
      for await (const msg of this.q) {
        // 任何带 session_id 的消息都盯着：init 会给，/compact 换 id 也从这里跟上
        const sid = (msg as { session_id?: string }).session_id;
        if (sid && sid !== this.claudeSessionId) {
          this.claudeSessionId = sid;
          this.opts.onSessionId(sid);
        }
        if (msg.type === "system" && msg.subtype === "init") {
          this.turn?.markInit();
          continue;
        }
        if (this.turn?.handle(msg)) {
          this.turn = null;
        }
      }
    } catch (err) {
      crash = err instanceof Error ? err.message : String(err);
    } finally {
      this.exited = true;
      this.ended = true;
      const t = this.turn;
      this.turn = null;
      t?.fail(crash ?? "常驻进程退出了，这轮没跑完");
      for (const w of this.exitWaiters.splice(0)) w();
      this.opts.onExit?.();
    }
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
      // 轮间换模型：流式输入模式专属能力，进程不用重启
      if (turn.model && turn.model !== this.currentModel) {
        await this.q.setModel(turn.model);
        this.currentModel = turn.model;
        console.log(`[pool] 轮间换模型 → ${turn.model}`);
      }
      this.push({
        type: "user",
        message: { role: "user", content: wrapReminder(turn.prompt, turn.now, turn.memoryBlock) },
        parent_tool_use_id: null,
      });
    })().catch((err) => {
      if (this.turn === state) this.turn = null;
      state.fail(err instanceof Error ? err.message : String(err));
    });
    return { interrupt: () => this.q.interrupt() };
  }

  /**
   * 收口：结束输入流让 CLI 优雅退出。resolve 时进程已经走完、jsonl 落盘，
   * 之后对同一内部会话做 resume（compact/拍一拍/冷启动）才安全。
   * 有轮在飞就先打断；CLI 卡死也有 8 秒兜底，不让调用方吊死。
   */
  close(): Promise<void> {
    if (this.exited) return Promise.resolve();
    this.ended = true;
    this.wake?.();
    this.wake = null;
    if (this.turn) this.q.interrupt().catch(() => {});
    return new Promise((resolve) => {
      this.exitWaiters.push(resolve);
      setTimeout(resolve, 8000).unref?.();
    });
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
