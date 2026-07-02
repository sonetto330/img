import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { SessionStore } from "./sessions.js";
import { runTurn, type TurnHandle } from "./engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.ACCESS_TOKEN || "";
const WORKSPACE = path.resolve(process.env.WORKSPACE_DIR || path.join(root, "workspace"));
const PERMISSION_MODE = (process.env.PERMISSION_MODE || "bypassPermissions") as Options["permissionMode"];
const DATA_DIR = path.join(root, "data");

if (!TOKEN) {
  console.error("请先在 .env 里设置 ACCESS_TOKEN（访问口令），参考 .env.example");
  process.exit(1);
}
fs.mkdirSync(WORKSPACE, { recursive: true });

const store = new SessionStore(DATA_DIR);
const publicDir = path.join(root, "public");

// 人设：优先用工作目录里的 CLAUDE.md，没有就用项目根目录那份。
// 每轮都重新读，改了人设不用重启服务。
function loadPersona(): string | undefined {
  for (const p of [path.join(WORKSPACE, "CLAUDE.md"), path.join(root, "CLAUDE.md")]) {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      /* 试下一个 */
    }
  }
  return undefined;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function authed(url: URL): boolean {
  return url.searchParams.get("token") === TOKEN;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // API：会话列表 / 会话内容（需要口令）
  if (url.pathname === "/api/sessions") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    return sendJson(res, 200, store.list());
  }
  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})$/);
  if (sessionMatch) {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    const record = store.get(sessionMatch[1]);
    return record ? sendJson(res, 200, record) : sendJson(res, 404, { error: "没有这个会话" });
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
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws: WebSocket, req) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (!authed(url)) {
    ws.send(JSON.stringify({ type: "error", message: "口令不对" }));
    ws.close();
    return;
  }

  let active: TurnHandle | null = null;
  const send = (payload: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };

  ws.on("message", (raw) => {
    let msg: { type?: string; sessionId?: string; text?: string };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return send({ type: "error", message: "消息格式不对" });
    }

    if (msg.type === "interrupt") {
      active?.interrupt().catch(() => {});
      return;
    }

    if (msg.type !== "chat" || !msg.text?.trim()) return;
    if (active) return send({ type: "error", message: "上一条还在跑，等等或者先打断" });

    const record = (msg.sessionId && store.get(msg.sessionId)) || store.create();
    if (record.messages.length === 0) {
      record.title = msg.text.slice(0, 24);
    }
    record.messages.push({ role: "user", text: msg.text, at: new Date().toISOString() });
    store.save(record);
    send({ type: "session", sessionId: record.id, title: record.title });

    active = runTurn(
      {
        prompt: msg.text,
        resume: record.claudeSessionId,
        cwd: WORKSPACE,
        permissionMode: PERMISSION_MODE,
        persona: loadPersona(),
      },
      {
        onClaudeSession(claudeSessionId) {
          // Claude Code 每次 resume 会派生新的内部会话 id，得跟着更新
          record.claudeSessionId = claudeSessionId;
          store.save(record);
        },
        onDelta(text) {
          send({ type: "delta", text });
        },
        onTool(name) {
          send({ type: "tool", name });
        },
        onDone(finalText, tools) {
          active = null;
          record.messages.push({ role: "assistant", text: finalText, tools, at: new Date().toISOString() });
          store.save(record);
          send({ type: "done", text: finalText });
        },
        onError(message) {
          active = null;
          send({ type: "error", message });
        },
      },
    );
  });

  ws.on("close", () => {
    active?.interrupt().catch(() => {});
    active = null;
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`「家」开门了：http://localhost:${PORT}`);
  console.log(`手机在同一 Wi-Fi 下访问 http://<电脑IP>:${PORT}（IP 用 ipconfig 查）`);
  console.log(`工作目录：${WORKSPACE}`);
});
