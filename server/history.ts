import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServers } from "./engine.js";
import type { SessionStore } from "./sessions.js";

/**
 * 跨窗口翻历史的工具组：麦穗在聊天里想不起原话时，自己去搜所有会话的原文。
 * 搬到裸 -p 管道后 CLI 进程内挂不了 SDK 工具，实际逻辑住在
 * scripts/history-mcp.mjs（独立 stdio MCP 小进程，直读 data/sessions 的
 * JSON 文件），这里只负责生成它的启动配置。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "scripts", "history-mcp.mjs");

export function buildHistoryTools(store: SessionStore, currentSessionId: string, archiveStore?: SessionStore) {
  const args = [SCRIPT, "--sessions-dir", store.sessionsDir, "--current", currentSessionId];
  if (archiveStore) args.push("--archive-dir", archiveStore.sessionsDir);
  const mcpServers: McpServers = {
    history: { type: "stdio", command: process.execPath, args },
  };
  return {
    mcpServers,
    allowedTools: ["mcp__history__search_history", "mcp__history__read_history"],
  };
}
