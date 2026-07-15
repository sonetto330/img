import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const PROMPTS_DIR = path.join(root, "prompts");

/** 工具向前端推送的事件；type 是事件名，其他字段随便附加 */
export type ToolEvent = { type: string; [key: string]: unknown };

/** 模式给外部提供的工具装备：MCP 服务端 + 允许模型调用的工具白名单 */
export interface ModeTools {
  mcpServers?: Options["mcpServers"];
  allowedTools?: string[];
}

/**
 * 模式定义：会话所处的对话模式。
 * buildTools 拿到 emit 闭包，构造这个模式专属的 SDK MCP 工具；工具 handler 里
 * 调 emit 就能把结果推到当前 WebSocket 前端（比如骰子结果、地图定位）。
 */
export interface ModeDef {
  id: string;
  /** 前端显示名 */
  label: string;
  /** prompts/ 目录下的附加提示词文件名；空表示该模式无附加提示词 */
  promptFile?: string;
  /** 构造该模式的工具；不实现就没有专属工具 */
  buildTools?: (emit: (event: ToolEvent) => void) => ModeTools;
}

/**
 * 已注册的模式。新增模式在这里加一条即可，别忘了同步前端页签。
 * 跑团（trpg）、旅行（travel）等在后续期数补上。
 */
const chromeTools: ModeDef["buildTools"] = () => ({
  mcpServers: {
    chrome: {
      type: "stdio",
      command: process.execPath,
      args: [
        path.join(root, "node_modules", "chrome-devtools-mcp", "build", "src", "bin", "chrome-devtools-mcp.js"),
        "--autoConnect",
      ],
    },
  },
});

const MODES: Record<string, ModeDef> = {
  chat: {
    id: "chat",
    label: "聊天",
    // Chrome 浏览器工具：直连泽日常的 Chrome（144+ 需在 chrome://inspect/#remote-debugging
    // 开过"远程调试"开关；没开或 Chrome 没运行时该组工具连不上，聊天本身不受影响）
    buildTools: chromeTools,
  },
  // 语音通话：不走 WS 聊天流，由 /api/call/turn 单独驱动，提示词管住"说话"的分寸
  call: { id: "call", label: "通话", promptFile: "call.md" },
  // 三人群聊：泽 + 麦穗 + GPT（Codex CLI 子进程），编排在 index.ts 的 chat 流程里
  group: { id: "group", label: "群聊", promptFile: "group.md", buildTools: chromeTools },
};

/** 未知的模式一律回落到 chat，避免拼错字段让麦穗不知道自己在哪 */
export function getMode(modeId: string): ModeDef {
  return MODES[modeId] || MODES.chat;
}

/**
 * 读取模式的附加提示词。每轮都重新读，改文件不用重启服务（同人设的热更新逻辑）。
 * 文件不存在或没配 promptFile 都返回 undefined，engine 就当没这一层。
 */
export function loadModePrompt(modeId: string): string | undefined {
  const def = getMode(modeId);
  if (!def.promptFile) return undefined;
  try {
    return fs.readFileSync(path.join(PROMPTS_DIR, def.promptFile), "utf8");
  } catch {
    return undefined;
  }
}
