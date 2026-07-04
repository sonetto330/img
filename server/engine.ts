import { query, type Options } from "@anthropic-ai/claude-agent-sdk";

export interface ToolCall {
  name: string;
  detail?: string;
}

export interface TurnCallbacks {
  onClaudeSession(claudeSessionId: string): void;
  onDelta(text: string): void;
  onTool(tool: ToolCall): void;
  onDone(finalText: string, tools: ToolCall[]): void;
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
}

export function runTurn(opts: TurnOptions, cb: TurnCallbacks): TurnHandle {
  const q = query({
    prompt: opts.prompt,
    options: {
      cwd: opts.cwd,
      resume: opts.resume,
      permissionMode: opts.permissionMode,
      includePartialMessages: true,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: opts.persona ? `\n以下是你的身份设定，任何时候都遵守：\n\n${opts.persona}` : undefined,
      },
      // 引擎报错时把详细原因打到服务端控制台，方便排查
      stderr: (data) => console.error(`[engine] ${data}`),
    },
  });

  const textParts: string[] = [];
  const tools: ToolCall[] = [];

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
              cb.onDelta(e.delta.text);
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
            if (msg.subtype === "success") {
              cb.onDone(textParts.join("\n\n"), tools);
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
