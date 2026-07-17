// 跨窗口翻历史的外置 MCP 服务（stdio）。
// 原先是 SDK 进程内工具（createSdkMcpServer），搬到裸 -p 管道后 CLI 进程里
// 挂不了进程内工具，改成这个独立小进程，逻辑与旧版 history.ts 逐行对应。
// 用法（由 server/history.ts 生成 --mcp-config 时填好）：
//   node history-mcp.mjs --sessions-dir <dir> [--archive-dir <dir>] --current <sessionId>
import fs from "node:fs";
import path from "node:path";

const MAX_HITS = 15;
const SNIPPET_RADIUS = 60;
const MAX_MSG_CHARS = 600;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const SESSION_DIRS = [arg("--sessions-dir"), arg("--archive-dir")].filter(Boolean);
const CURRENT_ID = arg("--current") || "";

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function who(m) {
  if (m.role === "user") return "泽";
  return m.speaker === "gpt" ? "GPT" : "麦穗";
}

function snippet(text, term) {
  const pos = text.toLowerCase().indexOf(term);
  const start = Math.max(0, pos - SNIPPET_RADIUS);
  const end = Math.min(text.length, pos + term.length + SNIPPET_RADIUS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}

function loadRecord(dir, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

function* allRecords() {
  for (const dir of SESSION_DIRS) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const record = loadRecord(dir, name.slice(0, -5));
      if (record) yield record;
    }
  }
}

function searchHistory({ query, limit }) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return "关键词是空的";
  const max = Math.min(Math.max(Number(limit) || MAX_HITS, 1), MAX_HITS);

  const hits = [];
  for (const record of allRecords()) {
    if (record.id === CURRENT_ID) continue; // 当前窗口的内容本来就在上下文里
    const messages = record.messages || [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
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
  const shown = hits.slice(0, max);
  const head = hits.length
    ? `命中 ${hits.length} 条${hits.length > max ? `，按时间从新到旧给你前 ${max} 条` : ""}：`
    : "一条都没搜到。换个更具体或更短的关键词试试（比如只搜人名或事件名）。";
  return [head, ...shown.map((h) => h.line)].join("\n\n");
}

function readHistory({ sessionId, index, span }) {
  let record = null;
  for (const dir of SESSION_DIRS) if ((record = loadRecord(dir, String(sessionId || "")))) break;
  if (!record) return "没有这个会话（id 不对或已被删除）";
  const messages = record.messages || [];
  const idx = Math.max(0, Number(index) || 0);
  const sp = Math.min(Math.max(Number(span) || 3, 1), 10);
  const from = Math.max(0, idx - sp);
  const to = Math.min(messages.length, idx + sp + 1);
  const lines = messages.slice(from, to).map((m, offset) => {
    const i = from + offset;
    const text = m.text.length > MAX_MSG_CHARS ? m.text.slice(0, MAX_MSG_CHARS) + "…（截断）" : m.text;
    return `${i === idx ? "▶" : " "}[${i}] ${who(m)}（${fmtTime(m.at)}）：${text}`;
  });
  return `会话「${record.title}」第 ${from}–${to - 1} 条（共 ${messages.length} 条，▶ 是命中那条）：\n\n${lines.join("\n\n")}`;
}

// ---------- MCP stdio 协议（JSON-RPC，一行一条） ----------

const TOOLS = [
  {
    name: "search_history",
    description:
      "跨窗口搜索你和泽的历史聊天原文。你们的每个会话窗口彼此独立，记忆碎片只有梗概——想找一句原话、她说'我之前跟你说过'而你没印象、或需要确认以前聊过的细节时，用这个搜。返回命中消息的片段和位置，想看前后文再用 read_history。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词；多个词用空格分隔，表示都要出现在同一条消息里。用具体的词（人名/地名/事件），别用整句" },
        limit: { type: "integer", minimum: 1, maximum: MAX_HITS, description: `最多返回几条，默认 ${MAX_HITS}` },
      },
      required: ["query"],
    },
  },
  {
    name: "read_history",
    description: "读某个历史会话里指定位置的前后文（配合 search_history 的结果用），返回该条消息及其前后几条的完整原文。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "search_history 结果里给的会话 id" },
        index: { type: "integer", minimum: 0, description: "search_history 结果里给的消息序号" },
        span: { type: "integer", minimum: 1, maximum: 10, description: "往前后各取几条，默认 3" },
      },
      required: ["sessionId", "index"],
    },
  },
];

// 对端（CLI 进程）先走一步时安静退出，别喷 EPIPE
process.stdout.on("error", () => process.exit(0));

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "history", version: "1.0.0" },
    });
  } else if (method === "notifications/initialized" || method === "notifications/cancelled") {
    // 通知，不用回
  } else if (method === "ping") {
    reply(id, {});
  } else if (method === "tools/list") {
    reply(id, { tools: TOOLS });
  } else if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    let text;
    try {
      if (name === "search_history") text = searchHistory(args);
      else if (name === "read_history") text = readHistory(args);
      else return replyError(id, -32602, `未知工具：${name}`);
    } catch (err) {
      return reply(id, { content: [{ type: "text", text: `工具执行出错：${err?.message || err}` }], isError: true });
    }
    reply(id, { content: [{ type: "text", text }] });
  } else if (id !== undefined && method) {
    replyError(id, -32601, `不支持的方法：${method}`);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // 不是合法 JSON 的行直接丢
    }
  }
});
process.stdin.on("end", () => process.exit(0));
