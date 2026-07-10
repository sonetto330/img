import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
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

export interface TurnCallbacks {
  onClaudeSession(claudeSessionId: string): void;
  onDelta(text: string): void;
  /** 思考过程的流式增量；不订阅就当没有 */
  onThinkingDelta?(text: string): void;
  /** 一段思考结束（可能有多段，ms 是累计值） */
  onThinkingPause?(ms: number): void;
  onTool(tool: ToolCall): void;
  onDone(finalText: string, tools: ToolCall[], thinking?: Thinking): void;
  onError(message: string): void;
}

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

export function runTurn(opts: TurnOptions, cb: TurnCallbacks): TurnHandle {
  // 时间和记忆块拼进用户消息，不进系统提示：系统提示每轮变一个字（时间到分钟、
  // 检索碎片轮轮不同），提示词缓存就从头作废，整段历史重读，长会话起步要几十秒。
  // 放进消息里历史只往后长、前缀不动，缓存轮轮命中。
  const reminderParts: string[] = [];
  if (opts.now) {
    reminderParts.push(`现在的时间：${opts.now}。你没有别的报时渠道，说到时间以这个为准。`);
  }
  if (opts.memoryBlock) {
    reminderParts.push(opts.memoryBlock);
  }
  const prompt = reminderParts.length
    ? `<system-reminder>\n${reminderParts.join("\n\n")}\n</system-reminder>\n\n${opts.prompt}`
    : opts.prompt;

  // 系统提示 append 只放不随轮次变的稳定层：人设 → 模式提示词
  const appendParts: string[] = [];
  if (opts.persona) {
    appendParts.push(`以下是你的身份设定，任何时候都遵守：\n\n${opts.persona}`);
  }
  if (opts.modePrompt) {
    appendParts.push(`当前对话模式的补充要求：\n\n${opts.modePrompt}`);
  }
  const append = appendParts.length ? "\n" + appendParts.join("\n\n") : undefined;

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

  const textParts: string[] = [];
  const tools: ToolCall[] = [];
  // 思考过程：正文流出来之前模型在想什么。分段计时，段与段之间累加
  const thinkingParts: string[] = [];
  let thinkingMs = 0;
  let thinkingStartedAt = 0; // 0 = 当前没有进行中的思考段

  const closeThinkingSpan = () => {
    if (thinkingStartedAt) {
      thinkingMs += Date.now() - thinkingStartedAt;
      thinkingStartedAt = 0;
      cb.onThinkingPause?.(thinkingMs);
    }
  };

  (async () => {
    try {
      for await (const msg of q) {
        switch (msg.type) {
          case "system":
            if (msg.subtype === "init") cb.onClaudeSession(msg.session_id);
            break;
          case "stream_event": {
            const e = msg.event;
            if (e.type === "content_block_delta" && e.delta.type === "text_delta") {
              closeThinkingSpan();
              cb.onDelta(e.delta.text);
            } else if (e.type === "content_block_delta" && e.delta.type === "thinking_delta") {
              if (!thinkingStartedAt) thinkingStartedAt = Date.now();
              thinkingParts.push(e.delta.thinking);
              cb.onThinkingDelta?.(e.delta.thinking);
            } else if (e.type === "content_block_stop") {
              closeThinkingSpan();
            }
            break;
          }
          case "assistant":
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text.trim()) {
                textParts.push(block.text);
              } else if (block.type === "tool_use") {
                const tool = { name: block.name, detail: summarizeInput(block.name, block.input) };
                tools.push(tool);
                cb.onTool(tool);
              }
            }
            break;
          case "result":
            closeThinkingSpan();
            if (msg.subtype === "success") {
              const thinking = thinkingParts.length
                ? { text: thinkingParts.join(""), ms: thinkingMs }
                : undefined;
              cb.onDone(textParts.join("\n\n"), tools, thinking);
            } else {
              cb.onError(`引擎结束异常：${msg.subtype}`);
            }
            break;
        }
      }
    } catch (err) {
      cb.onError(err instanceof Error ? err.message : String(err));
    }
  })();

  return {
    interrupt: () => q.interrupt(),
  };
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
