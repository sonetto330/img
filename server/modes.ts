import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const PROMPTS_DIR = path.join(root, "prompts");

/**
 * 模式定义：会话所处的对话模式。后续期数会给每个模式加专属工具（mcpServers、
 * allowedExtraTools），这一版先只放身份和提示词文件名。
 */
export interface ModeDef {
  id: string;
  /** 前端显示名 */
  label: string;
  /** prompts/ 目录下的附加提示词文件名；空表示该模式无附加提示词 */
  promptFile?: string;
}

/**
 * 已注册的模式。新增模式在这里加一条即可，别忘了同步前端页签。
 * 跑团（trpg）、旅行（travel）等在后续期数补上，本期只有 chat。
 */
const MODES: Record<string, ModeDef> = {
  chat: { id: "chat", label: "聊天" },
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
