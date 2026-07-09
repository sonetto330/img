import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { SessionStore, StoredMessage } from "./sessions.js";

/**
 * 跨窗口翻历史的工具组：麦穗在聊天里想不起原话时，自己去搜所有会话的原文。
 * 纯本地文件扫描，个人量级（几百个会话）线性扫完全够用，不建索引。
 */

const MAX_HITS = 15;          // 搜索最多返回几条命中
const SNIPPET_RADIUS = 60;    // 命中词前后各截多少字
const MAX_MSG_CHARS = 600;    // 读上下文时单条消息最长截多少字

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function who(m: StoredMessage): string {
  return m.role === "user" ? "泽" : "麦穗";
}

/** 命中词附近截一段，两头加省略号 */
function snippet(text: string, term: string): string {
  const pos = text.toLowerCase().indexOf(term);
  const start = Math.max(0, pos - SNIPPET_RADIUS);
  const end = Math.min(text.length, pos + term.length + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}

export function buildHistoryTools(store: SessionStore, currentSessionId: string) {
  const searchTool = tool(
    "search_history",
    "跨窗口搜索你和泽的历史聊天原文。你们的每个会话窗口彼此独立，记忆碎片只有梗概——想找一句原话、她说'我之前跟你说过'而你没印象、或需要确认以前聊过的细节时，用这个搜。返回命中消息的片段和位置，想看前后文再用 read_history。",
    {
      query: z.string().describe("关键词；多个词用空格分隔，表示都要出现在同一条消息里。用具体的词（人名/地名/事件），别用整句"),
      limit: z.number().int().min(1).max(MAX_HITS).optional().describe(`最多返回几条，默认 ${MAX_HITS}`),
    },
    async (args) => {
      const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
      if (!terms.length) return { content: [{ type: "text" as const, text: "关键词是空的" }] };
      const limit = args.limit ?? MAX_HITS;

      const hits: Array<{ at: string; line: string }> = [];
      for (const meta of store.list()) {
        if (meta.id === currentSessionId) continue; // 当前窗口的内容本来就在上下文里
        const record = store.get(meta.id);
        if (!record) continue;
        for (let i = 0; i < record.messages.length; i++) {
          const m = record.messages[i];
          if (!m.text) continue;
          const lower = m.text.toLowerCase();
          if (!terms.every((t) => lower.includes(t))) continue;
          hits.push({
            at: m.at,
            line: `【${record.title}｜${fmtTime(m.at)}｜${who(m)}】${snippet(m.text, terms[0])}\n  ↳ 看前后文：read_history(sessionId: "${record.id}", index: ${i})`,
          });
        }
      }
      hits.sort((a, b) => (a.at < b.at ? 1 : -1));
      const shown = hits.slice(0, limit);
      const head = hits.length
        ? `命中 ${hits.length} 条${hits.length > limit ? `，按时间从新到旧给你前 ${limit} 条` : ""}：`
        : "一条都没搜到。换个更具体或更短的关键词试试（比如只搜人名或事件名）。";
      return { content: [{ type: "text" as const, text: [head, ...shown.map((h) => h.line)].join("\n\n") }] };
    },
  );

  const readTool = tool(
    "read_history",
    "读某个历史会话里指定位置的前后文（配合 search_history 的结果用），返回该条消息及其前后几条的完整原文。",
    {
      sessionId: z.string().describe("search_history 结果里给的会话 id"),
      index: z.number().int().min(0).describe("search_history 结果里给的消息序号"),
      span: z.number().int().min(1).max(10).optional().describe("往前后各取几条，默认 3"),
    },
    async (args) => {
      const record = store.get(args.sessionId);
      if (!record) return { content: [{ type: "text" as const, text: "没有这个会话（id 不对或已被删除）" }] };
      const span = args.span ?? 3;
      const from = Math.max(0, args.index - span);
      const to = Math.min(record.messages.length, args.index + span + 1);
      const lines = record.messages.slice(from, to).map((m, offset) => {
        const i = from + offset;
        const text = m.text.length > MAX_MSG_CHARS ? m.text.slice(0, MAX_MSG_CHARS) + "…（截断）" : m.text;
        return `${i === args.index ? "▶" : " "}[${i}] ${who(m)}（${fmtTime(m.at)}）：${text}`;
      });
      return {
        content: [{
          type: "text" as const,
          text: `会话「${record.title}」第 ${from}–${to - 1} 条（共 ${record.messages.length} 条，▶ 是命中那条）：\n\n${lines.join("\n\n")}`,
        }],
      };
    },
  );

  return {
    mcpServers: {
      history: createSdkMcpServer({ name: "history", version: "1.0.0", tools: [searchTool, readTool] }),
    },
    allowedTools: ["mcp__history__search_history", "mcp__history__read_history"],
  };
}
