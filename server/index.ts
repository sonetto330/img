import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { SessionStore, type Attachment } from "./sessions.js";
import { runTurn, type TurnHandle } from "./engine.js";
import { getMode, loadModePrompt, type ToolEvent } from "./modes.js";
import { barkPush } from "./bark.js";
import { synthesize, ttsEnabled } from "./tts.js";
import { getWeather } from "./weather.js";
import { scheduleExtractionIfNeeded } from "./memory/scribe.js";
import { retrieve, markRetrieved } from "./memory/librarian.js";
import { formatMemoryBlock } from "./memory/format.js";
import { getGraph, getEntityDetail, getCoreDetail } from "./memory/graph.js";
import { loadPersona } from "./persona.js";
import { getGreeting } from "./greeting.js";
import { translateThinking } from "./translate.js";

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

// 上传的图片/文件放在工作目录里，这样他能直接用 Read 工具看
const UPLOADS = path.join(WORKSPACE, "uploads");
fs.mkdirSync(UPLOADS, { recursive: true });
const MAX_UPLOAD = 30 * 1024 * 1024; // 30MB
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const store = new SessionStore(DATA_DIR);
const publicDir = path.join(root, "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

function authed(url: URL): boolean {
  return url.searchParams.get("token") === TOKEN;
}

/** 当前时间的人话版，注入每轮系统提示 */
function nowString(): string {
  const d = new Date();
  const wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${wd} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // 上传文件（需要口令）
  if (url.pathname === "/api/upload" && req.method === "POST") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    const original = (url.searchParams.get("name") || "文件").slice(0, 120);
    const ext = path.extname(original).toLowerCase();
    const saved = `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_UPLOAD) {
        req.destroy();
        return sendJson(res, 413, { error: "文件太大，上限 30MB" });
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      fs.writeFileSync(path.join(UPLOADS, saved), Buffer.concat(chunks));
      const kind = IMAGE_EXT.has(ext) ? "image" : "file";
      sendJson(res, 200, { file: saved, name: original, kind });
    });
    return;
  }

  // 取回上传过的文件（聊天记录里显示图片用，需要口令）
  const uploadMatch = url.pathname.match(/^\/uploads\/([\w.-]+)$/);
  if (uploadMatch) {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    const filePath = path.join(UPLOADS, path.basename(uploadMatch[1]));
    return fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
      res.end(data);
    });
  }

  // TTS：把文本转成音频流回来（需要口令）
  if (url.pathname === "/api/tts" && req.method === "POST") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    if (!ttsEnabled()) return sendJson(res, 503, { error: "TTS 没配置" });
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      let body: { text?: string };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return sendJson(res, 400, { error: "消息格式不对" });
      }
      const text = String(body.text || "").trim();
      if (!text) return sendJson(res, 400, { error: "没有可念的内容" });
      try {
        const { audio, contentType } = await synthesize(text);
        res.writeHead(200, {
          "Content-Type": contentType,
          "Cache-Control": "no-store",
        });
        res.end(Buffer.from(audio));
      } catch (err) {
        console.error(`[tts] ${err instanceof Error ? err.message : String(err)}`);
        sendJson(res, 502, { error: err instanceof Error ? err.message : "TTS 失败" });
      }
    });
    return;
  }

  // 翻译思考内容（需要口令）
  if (url.pathname === "/api/translate" && req.method === "POST") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      let body: { text?: string };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return sendJson(res, 400, { error: "消息格式不对" });
      }
      const text = String(body.text || "").trim();
      if (!text) return sendJson(res, 400, { error: "没有可翻的内容" });
      try {
        sendJson(res, 200, { text: await translateThinking(text) });
      } catch (err) {
        console.error(`[translate] ${err instanceof Error ? err.message : String(err)}`);
        sendJson(res, 502, { error: "翻译失败，稍后再试" });
      }
    });
    return;
  }

  // 记忆图：整张星图数据
  if (url.pathname === "/api/memory/graph") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    return sendJson(res, 200, getGraph());
  }
  const memoryEntityMatch = url.pathname.match(/^\/api\/memory\/entity\/(\d+)$/);
  if (memoryEntityMatch) {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    const detail = getEntityDetail(Number(memoryEntityMatch[1]));
    return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: "找不到该实体" });
  }
  const memoryCoreMatch = url.pathname.match(/^\/api\/memory\/core\/(ze|maisui)$/);
  if (memoryCoreMatch) {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    return sendJson(res, 200, getCoreDetail(memoryCoreMatch[1] as "ze" | "maisui"));
  }

  // 首页招呼语：麦穗写给泽的一句话，30 分钟缓存
  if (url.pathname === "/api/greeting") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    return getGreeting().then(
      (text) => sendJson(res, 200, { text }),
      () => sendJson(res, 200, { text: "" }),
    );
  }

  // 首页天气：走服务端代理，Open-Meteo 免 key，缓存 15 分钟
  if (url.pathname === "/api/weather") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    return getWeather().then(
      (w) => (w ? sendJson(res, 200, w) : sendJson(res, 502, { error: "天气拿不到" })),
      () => sendJson(res, 502, { error: "天气拿不到" }),
    );
  }

  // API：会话列表 / 会话内容（需要口令）
  if (url.pathname === "/api/sessions") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    return sendJson(res, 200, store.list());
  }
  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})$/);
  if (sessionMatch) {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    if (req.method === "DELETE") {
      return store.delete(sessionMatch[1])
        ? sendJson(res, 200, { ok: true })
        : sendJson(res, 404, { error: "没有这个会话" });
    }
    const record = store.get(sessionMatch[1]);
    return record ? sendJson(res, 200, record) : sendJson(res, 404, { error: "没有这个会话" });
  }
  const renameMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/rename$/);
  if (renameMatch && req.method === "POST") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: { title?: string };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return sendJson(res, 400, { error: "消息格式不对" });
      }
      const title = String(body.title || "").trim();
      if (!title) return sendJson(res, 400, { error: "标题不能为空" });
      const record = store.rename(renameMatch[1], title);
      return record
        ? sendJson(res, 200, { id: record.id, title: record.title })
        : sendJson(res, 404, { error: "没有这个会话" });
    });
    return;
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
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      // 界面文件禁止缓存，更新后刷新一次就是最新的，不用清缓存
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: "/ws" });

// 手机是否有人正盯着？连接掉了才推 Bark，别打扰她
function anyoneWatching(): boolean {
  for (const c of wss.clients) if (c.readyState === c.OPEN) return true;
  return false;
}

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

  // 前端传来的模型别名，只认这仨；不认识的当没传，走默认
  const MODEL_ALIASES = new Set(["opus", "sonnet", "haiku"]);

  ws.on("message", (raw) => {
    let msg: { type?: string; sessionId?: string; text?: string; mode?: string; attachments?: Attachment[]; model?: string };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return send({ type: "error", message: "消息格式不对" });
    }

    if (msg.type === "interrupt") {
      active?.interrupt().catch(() => {});
      return;
    }

    if (msg.type === "pat") {
      if (active) return send({ type: "error", message: "上一条还在跑，等等或者先打断" });
      // 拍一拍如果没在已有会话里就新建一个，走默认 chat 模式
      const record = (msg.sessionId && store.get(msg.sessionId)) || store.create();
      // 拍一拍不改标题；存历史用固定文本，前端识别后显示成居中小字
      record.messages.push({ role: "user", text: "（拍了拍你）", at: new Date().toISOString() });
      store.save(record);
      send({ type: "session", sessionId: record.id, title: record.title, mode: record.mode });

      // 拍一拍不动工具，就不装 mcpServers；模式提示词还是照常挂
      active = runTurn(
        {
          prompt: "（泽拍了拍你，用一两句话回应，别干活）",
          resume: record.claudeSessionId,
          cwd: WORKSPACE,
          permissionMode: PERMISSION_MODE,
          persona: loadPersona(),
          modePrompt: loadModePrompt(record.mode),
          model: process.env.CLAUDE_MODEL || "claude-opus-4-7",
          maxTurns: 1,
          now: nowString(),
        },
        {
          onClaudeSession(claudeSessionId) {
            record.claudeSessionId = claudeSessionId;
            store.save(record);
          },
          onDelta(text) {
            send({ type: "delta", text });
          },
          onTool(tool) {
            send({ type: "tool", name: tool.name, detail: tool.detail });
          },
          onDone(finalText, tools) {
            active = null;
            record.messages.push({ role: "assistant", text: finalText, tools, at: new Date().toISOString() });
            store.save(record);
            send({ type: "done", text: finalText });
            if (!anyoneWatching()) barkPush("麦穗", finalText).catch(() => {});
          },
          onError(message) {
            active = null;
            send({ type: "error", message });
            if (!anyoneWatching()) barkPush("麦穗（出错）", message).catch(() => {});
          },
        },
      );
      return;
    }

    // 附件校验：只认 uploads 目录里真实存在的文件
    const attachments: Attachment[] = (msg.attachments || [])
      .filter((a) => a && typeof a.file === "string")
      .map((a): Attachment => ({
        file: path.basename(a.file),
        name: String(a.name || a.file).slice(0, 120),
        kind: a.kind === "image" ? "image" : "file",
      }))
      .filter((a) => fs.existsSync(path.join(UPLOADS, a.file)));

    const text = msg.text?.trim() || "";
    if (msg.type !== "chat" || (!text && attachments.length === 0)) return;
    const model = MODEL_ALIASES.has(msg.model || "")
      ? msg.model!
      : process.env.CLAUDE_MODEL || "claude-opus-4-7";
    if (active) return send({ type: "error", message: "上一条还在跑，等等或者先打断" });

    // 已有会话不改 mode；只有新建时才认 msg.mode，未指定就默认 chat
    const record = (msg.sessionId && store.get(msg.sessionId)) || store.create(msg.mode || "chat");
    if (record.messages.length === 0) {
      record.title = (text || attachments[0]?.name || "新会话").slice(0, 24);
    }
    record.messages.push({ role: "user", text, attachments, at: new Date().toISOString() });
    store.save(record);
    send({ type: "session", sessionId: record.id, title: record.title, mode: record.mode });

    // 附件以文件路径的形式告诉他，图片他会用 Read 工具看
    const attLines = attachments
      .map((a) => `[泽发来${a.kind === "image" ? "一张图片" : "一个文件"}「${a.name}」，路径：${path.join(UPLOADS, a.file)}${a.kind === "image" ? "，用 Read 工具查看" : ""}]`)
      .join("\n");
    const prompt = attLines ? `${attLines}\n\n${text || "（没写字，看内容吧）"}` : text;

    // 装配当前模式的工具：emit 闭包直接把事件推给这条 WS 连接
    const emit = (event: ToolEvent) => send({ type: "custom", event });
    const built = getMode(record.mode).buildTools?.(emit);

    // 检索记忆：全模式生效。await 期间用一个占位 handle 锁住 active，防止连发消息触发并发
    const preparing: TurnHandle = { interrupt: async () => {} };
    active = preparing;
    (async () => {
      let memoryBlock: string | undefined;
      let memoryIds: number[] = [];
      try {
        const memories = text ? await retrieve(text) : [];
        if (memories.length) {
          memoryBlock = formatMemoryBlock(memories, record.mode);
          memoryIds = memories.map((m) => m.id);
        }
      } catch (err) {
        console.error(`[librarian] ${err instanceof Error ? err.message : err}`);
      }
      if (active !== preparing) return; // 中途被 close/interrupt 换掉了，别继续

      active = runTurn(
        {
          prompt,
          resume: record.claudeSessionId,
          cwd: WORKSPACE,
          permissionMode: PERMISSION_MODE,
          persona: loadPersona(),
          modePrompt: loadModePrompt(record.mode),
          memoryBlock,
          model,
          mcpServers: built?.mcpServers,
          allowedTools: built?.allowedTools,
          // 开自适应思考：闲聊模型基本不想，干活才想，想了前端就有卡片看
          thinking: process.env.THINKING !== "off",
          now: nowString(),
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
          onThinkingDelta(text) {
            send({ type: "thinking", text });
          },
          onThinkingPause(ms) {
            send({ type: "thinking_done", ms });
          },
          onTool(tool) {
            send({ type: "tool", name: tool.name, detail: tool.detail });
          },
          onDone(finalText, tools, thinking) {
            active = null;
            record.messages.push({ role: "assistant", text: finalText, tools, thinking, at: new Date().toISOString() });
            store.save(record);
            send({ type: "done", text: finalText });
            if (!anyoneWatching()) barkPush("麦穗", finalText).catch(() => {});
            // 后台异步提取记忆碎片；不 await、出错不影响主聊天
            scheduleExtractionIfNeeded(record);
          },
          onError(message) {
            active = null;
            send({ type: "error", message });
            if (!anyoneWatching()) barkPush("麦穗（出错）", message).catch(() => {});
          },
        },
      );
      // runTurn 已经启动，注入成功——把 read_count 打一记；即便本轮失败，"翻过牌"这件事也算数
      if (memoryIds.length) markRetrieved(memoryIds);
    })();
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
