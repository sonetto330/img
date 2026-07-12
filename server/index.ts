import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { SessionStore, type Attachment, type SessionRecord } from "./sessions.js";
import { runTurn, type TurnHandle, type TurnUsage } from "./engine.js";
import { burnAttachments } from "./burn.js";
import { splitApiError, apiErrorNote } from "./apierror.js";
import { getMode, loadModePrompt, type ToolEvent } from "./modes.js";
import { buildHistoryTools } from "./history.js";
import { barkPush } from "./bark.js";
import { synthesize, ttsEnabled } from "./tts.js";
import { transcribe, sttEnabled } from "./stt.js";
import { getWeather } from "./weather.js";
import { scheduleExtractionIfNeeded } from "./memory/scribe.js";
import { retrieve, markRetrieved } from "./memory/librarian.js";
import { formatMemoryBlock } from "./memory/format.js";
import { getGraph, getEntityDetail, getCoreDetail } from "./memory/graph.js";
import { loadPersona } from "./persona.js";
import { getGreeting } from "./greeting.js";
import { translateThinking } from "./translate.js";
import { getSettings, setChannel, setExternal, publicSettings, channelEnv, externalConfigured, useApiNow, looksLikeLimitError, modelForChannel, type Channel } from "./settings.js";
import { listExternalModels, SUBSCRIPTION_MODELS } from "./models.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.ACCESS_TOKEN || "";
const WORKSPACE = path.resolve(process.env.WORKSPACE_DIR || path.join(root, "workspace"));
const PERMISSION_MODE = (process.env.PERMISSION_MODE || "bypassPermissions") as Options["permissionMode"];
const DATA_DIR = path.join(root, "data");
// 单次上下文（累计输入÷步数）超过这个 token 数就自动给会话瘦身（/compact）；0 = 关自动挡
const COMPACT_THRESHOLD = Number(process.env.COMPACT_THRESHOLD_TOKENS || 150000);

if (!TOKEN) {
  console.error("请先在 .env 里设置 ACCESS_TOKEN（访问口令），参考 .env.example");
  process.exit(1);
}
fs.mkdirSync(WORKSPACE, { recursive: true });

// 上传的图片/文件放在工作目录里，这样他能直接用 Read 工具看
const UPLOADS = path.join(WORKSPACE, "uploads");
fs.mkdirSync(UPLOADS, { recursive: true });
const MAX_UPLOAD = 200 * 1024 * 1024; // 200MB，泽要传字体文件这类大家伙
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
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff2": "font/woff2",
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

// 正在瘦身的会话：压缩期间 resume 旧 id 会 fork 出没压缩的分支，新消息必须挡住
const compacting = new Set<string>();

/**
 * 阅后即焚：resume 之前把上一轮 Read 过的附件原文从内部历史里替换成占位符。
 * 放在 resume 前做（而不是回话后）就没有和子进程写文件的并发问题——同一
 * 会话的轮次是串行的。焚失败不挡聊天，最多这轮多背点原文。
 */
function burnBeforeResume(record: SessionRecord): void {
  if (!record.claudeSessionId) return;
  try {
    const r = burnAttachments(record.claudeSessionId, WORKSPACE, UPLOADS);
    if (r.burned) {
      console.log(`[burn] 「${record.title}」阅后即焚 ${r.burned} 块附件原文，历史瘦了约 ${Math.round(r.savedChars / 1024)}K 字符`);
    }
  } catch (err) {
    console.error(`[burn] ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * 给会话做一次 /compact：SDK 把历史压成摘要，聊过什么、定过什么都在，
 * 大文件原文被压掉，之后单次上下文从几十万掉到几万。
 * 斜杠命令必须独占 prompt，所以这轮不传 now/memoryBlock（engine 会把它们
 * 包成 system-reminder 拼在前面，/compact 就不再是行首、变成普通文本了）。
 */
function runCompact(record: SessionRecord): Promise<void> {
  if (!record.claudeSessionId) return Promise.reject(new Error("这个会话还没聊过，没东西可压"));
  if (compacting.has(record.id)) return Promise.reject(new Error("正在瘦身，别重复点"));
  compacting.add(record.id);
  const attempt = (useApi: boolean) =>
    new Promise<void>((resolve, reject) => {
      runTurn(
        {
          prompt: "/compact",
          resume: record.claudeSessionId,
          cwd: WORKSPACE,
          permissionMode: PERMISSION_MODE,
          persona: loadPersona(),
          modePrompt: loadModePrompt(record.mode),
          model: modelForChannel(useApi, process.env.CLAUDE_MODEL || "claude-opus-4-7"),
          thinking: false,
          env: channelEnv(useApi),
        },
        {
          onClaudeSession(id) {
            // 压缩会派生新的内部会话 id，之后 resume 的就是压完的摘要版
            record.claudeSessionId = id;
            store.save(record);
          },
          onDelta() {},
          onTool() {},
          onDone(finalText) {
            // CLI 把 API 报错当正文吐出来时压缩其实没做，不能当成功，否则下轮还背着全量历史
            const { apiError } = splitApiError(finalText);
            if (apiError) reject(new Error(apiErrorNote(apiError)));
            else resolve();
          },
          onError(message) {
            reject(new Error(message));
          },
        },
      );
    });
  const useApi = useApiNow();
  return attempt(useApi)
    .catch((err) => {
      if (!useApi && getSettings().channel === "auto" && externalConfigured()) {
        console.error(`[compact] 订阅通道失败（${err instanceof Error ? err.message.slice(0, 120) : err}），换外部 API 重试`);
        return attempt(true);
      }
      throw err;
    })
    .finally(() => compacting.delete(record.id));
}

/** 自动挡：本轮单次上下文（累计输入÷步数）超阈值就顺手瘦身，前端收到小提示，不用她管 */
function maybeAutoCompact(record: SessionRecord, usage: TurnUsage | undefined, send: (payload: unknown) => void): void {
  if (!COMPACT_THRESHOLD || !usage?.steps) return;
  const perStep = Math.round(usage.inputTotal / usage.steps);
  if (perStep < COMPACT_THRESHOLD) return;
  console.log(`[compact] 单次上下文约 ${perStep} tokens，超阈值 ${COMPACT_THRESHOLD}，自动给「${record.title}」瘦身`);
  send({ type: "compact_start", auto: true });
  runCompact(record).then(
    () => send({ type: "compact_done" }),
    (err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[compact] 自动瘦身失败：${message}`);
      send({ type: "compact_error", message });
    },
  );
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
        return sendJson(res, 413, { error: "文件太大，上限 200MB" });
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

  // 设置：调用通道（订阅 / 外部API / 自动）+ 外部 API 配置。
  // key 存 data/settings.json（.gitignore 内），GET 绝不回传 key 本身，只回尾巴四位（需要口令）
  if (url.pathname === "/api/settings") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        let body: {
          channel?: string; externalKey?: string; externalBaseUrl?: string;
          externalAuth?: string; externalModel?: string; externalHaiku?: string;
        };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          return sendJson(res, 400, { error: "消息格式不对" });
        }
        // 先存外部 API 配置（有哪项动哪项），再切通道——这样"填 key + 选自动"能一次保存
        const hasExternalField = [body.externalKey, body.externalBaseUrl, body.externalAuth, body.externalModel, body.externalHaiku]
          .some((v) => v !== undefined);
        if (hasExternalField) {
          if (body.externalKey !== undefined && (typeof body.externalKey !== "string" || body.externalKey.length > 300)) {
            return sendJson(res, 400, { error: "key 格式不对" });
          }
          const baseUrl = body.externalBaseUrl?.trim();
          if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
            return sendJson(res, 400, { error: "中转地址要以 http:// 或 https:// 开头" });
          }
          if (body.externalAuth !== undefined && !["", "x-api-key", "bearer"].includes(body.externalAuth)) {
            return sendJson(res, 400, { error: "验证方式只有 x-api-key 和 bearer 两种" });
          }
          for (const m of [body.externalModel, body.externalHaiku]) {
            if (m !== undefined && (typeof m !== "string" || m.length > 120)) {
              return sendJson(res, 400, { error: "模型名格式不对" });
            }
          }
          setExternal({
            key: body.externalKey,
            baseUrl: body.externalBaseUrl,
            auth: body.externalAuth as "x-api-key" | "bearer" | "" | undefined,
            model: body.externalModel,
            haiku: body.externalHaiku,
          });
        }
        if (body.channel !== undefined) {
          const channel = body.channel as Channel;
          if (!["subscription", "api", "auto"].includes(channel)) {
            return sendJson(res, 400, { error: "没有这个通道" });
          }
          if (channel !== "subscription" && !externalConfigured()) {
            return sendJson(res, 400, { error: "先把外部 API key 填上保存，才能选这两项" });
          }
          setChannel(channel);
        }
        return sendJson(res, 200, publicSettings());
      });
      return;
    }
    return sendJson(res, 200, publicSettings());
  }

  // 模型列表：订阅是固定仨别名；外部的从官方/中转现拉（中转的模型名常跟官方不一样）
  if (url.pathname === "/api/models") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    listExternalModels(url.searchParams.get("refresh") === "1")
      .then((ext) => sendJson(res, 200, {
        subscription: SUBSCRIPTION_MODELS,
        external: ext.models,
        externalError: ext.error || "",
        externalConfigured: externalConfigured(),
      }))
      .catch((err) => sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) }));
    return;
  }

  // 语音通话：一轮 = 收音频 → 转文字 → 麦穗说话 → 合成语音（需要口令）
  if (url.pathname === "/api/call/turn" && req.method === "POST") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    if (!sttEnabled() || !ttsEnabled()) {
      return sendJson(res, 503, { error: "通话没配置好：.env 里要有 ELEVENLABS_KEY 和 ELEVENLABS_VOICE" });
    }
    const mime = url.searchParams.get("mime") || "audio/mp4";
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 25 * 1024 * 1024) {
        req.destroy();
        return sendJson(res, 413, { error: "这段语音太长了" });
      }
      chunks.push(chunk);
    });
    req.on("end", async () => {
      try {
        const audio = Buffer.concat(chunks);
        if (audio.length < 200) return sendJson(res, 400, { error: "没录到声音" });

        const userText = await transcribe(audio, mime);
        if (!userText) return sendJson(res, 200, { empty: true, hint: "没听清，再说一遍？" });

        // 通话有自己的会话（mode=call），记录进历史，聊天页也能翻到
        const record = (url.searchParams.get("session") && store.get(url.searchParams.get("session")!)) || store.create("call");
        if (compacting.has(record.id)) return sendJson(res, 409, { error: "这个会话正在瘦身，稍等几秒" });
        if (record.messages.length === 0) {
          const d = new Date();
          record.title = `通话 ${d.getMonth() + 1}.${d.getDate()}`;
        }
        record.messages.push({ role: "user", text: userText, at: new Date().toISOString() });
        store.save(record);
        burnBeforeResume(record);

        // 说一轮：不动工具、不开思考，快点回话要紧；auto 通道下订阅翻车就换外部 API 再试一次
        const speak = (useApi: boolean) =>
          new Promise<string>((resolve, reject) => {
            runTurn(
              {
                prompt: userText,
                resume: record.claudeSessionId,
                cwd: WORKSPACE,
                permissionMode: PERMISSION_MODE,
                persona: loadPersona(),
                modePrompt: loadModePrompt("call"),
                model: modelForChannel(useApi, process.env.CLAUDE_MODEL || "claude-opus-4-7"),
                maxTurns: 1,
                thinking: false,
                now: nowString(),
                env: channelEnv(useApi),
              },
              {
                onClaudeSession(id) {
                  record.claudeSessionId = id;
                  store.save(record);
                },
                onDelta() {},
                onTool() {},
                onDone(finalText) {
                  // API 报错被 CLI 当正文吐出来的情况：剥掉；一句真话都不剩就算这轮失败
                  const { clean, apiError } = splitApiError(finalText);
                  if (apiError && !clean) reject(new Error(apiErrorNote(apiError)));
                  else resolve(clean);
                },
                onError(message) {
                  reject(new Error(message));
                },
              },
            );
          });

        let useApi = useApiNow();
        let replyText: string;
        try {
          replyText = await speak(useApi);
        } catch (err) {
          if (!useApi && getSettings().channel === "auto" && externalConfigured()) {
            console.error(`[call] 订阅通道失败（${err instanceof Error ? err.message.slice(0, 120) : err}），换外部 API 重试`);
            useApi = true;
            replyText = await speak(true);
          } else {
            throw err;
          }
        }
        if (!replyText.trim()) throw new Error("这轮没说出话来");

        record.messages.push({ role: "assistant", text: replyText, at: new Date().toISOString() });
        store.save(record);

        const { audio: reply, contentType } = await synthesize(replyText);
        sendJson(res, 200, {
          sessionId: record.id,
          userText,
          replyText,
          audio: Buffer.from(reply).toString("base64"),
          mime: contentType,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[call] ${message}`);
        sendJson(res, 502, { error: message });
      }
    });
    return;
  }

  // 收藏室：纪念册条目（需要口令）
  if (url.pathname === "/api/keepsakes") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    try {
      const items = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "keepsakes.json"), "utf8"));
      return sendJson(res, 200, items);
    } catch {
      return sendJson(res, 200, []);
    }
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
  // 会话瘦身（手动挡）：对这个会话发一次 /compact。压大会话要一阵，压完才回话
  const compactMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/compact$/);
  if (compactMatch && req.method === "POST") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    const record = store.get(compactMatch[1]);
    if (!record) return sendJson(res, 404, { error: "没有这个会话" });
    if (!record.claudeSessionId) return sendJson(res, 400, { error: "这个会话还没聊过，没东西可压" });
    if (compacting.has(record.id)) return sendJson(res, 409, { error: "正在瘦身，别重复点" });
    runCompact(record).then(
      () => sendJson(res, 200, { ok: true }),
      (err) => sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) }),
    );
    return;
  }

  // 挪文件夹：folder 传空串 = 移出文件夹
  const folderMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/folder$/);
  if (folderMatch && req.method === "POST") {
    if (!authed(url)) return sendJson(res, 401, { error: "口令不对" });
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: { folder?: string };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return sendJson(res, 400, { error: "消息格式不对" });
      }
      const record = store.setFolder(folderMatch[1], String(body.folder ?? ""));
      return record
        ? sendJson(res, 200, { id: record.id, folder: record.folder ?? "" })
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

  // 前端传来的模型：别名、外部列表里的、手填的完整型号都认，只挡明显不像模型名的垃圾
  const looksLikeModelId = (m: string) => /^[\w][\w.:/-]{0,119}$/.test(m) && m !== "__custom";

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
      if (compacting.has(record.id)) return send({ type: "error", message: "这个会话正在瘦身，等几秒再拍" });
      // 拍一拍不改标题；存历史用固定文本，前端识别后显示成居中小字
      record.messages.push({ role: "user", text: "（拍了拍你）", at: new Date().toISOString() });
      store.save(record);
      send({ type: "session", sessionId: record.id, title: record.title, mode: record.mode });

      burnBeforeResume(record);

      // 拍一拍不动工具，就不装 mcpServers；模式提示词还是照常挂
      // auto 通道下订阅翻车（还没吐内容时）就换外部 API 重拍一次，跟主聊天同款逻辑
      const launchPat = (useApi: boolean, isRetry: boolean) => {
        let gotOutput = false;
        active = runTurn(
          {
            prompt: "（泽拍了拍你，用一两句话回应，别干活）",
            resume: record.claudeSessionId,
            cwd: WORKSPACE,
            permissionMode: PERMISSION_MODE,
            persona: loadPersona(),
            modePrompt: loadModePrompt(record.mode),
            model: modelForChannel(useApi, process.env.CLAUDE_MODEL || "claude-opus-4-7"),
            maxTurns: 1,
            now: nowString(),
            env: channelEnv(useApi),
          },
          {
            onClaudeSession(claudeSessionId) {
              record.claudeSessionId = claudeSessionId;
              store.save(record);
            },
            onDelta(text) {
              gotOutput = true;
              send({ type: "delta", text });
            },
            onTool(tool) {
              gotOutput = true;
              send({ type: "tool", name: tool.name, detail: tool.detail });
            },
            onDone(finalText, tools) {
              if (
                !isRetry && !useApi && getSettings().channel === "auto" && externalConfigured() &&
                tools.length === 0 && finalText.length < 160 && looksLikeLimitError(finalText)
              ) {
                console.error(`[pat] 订阅额度用尽（${finalText.slice(0, 80)}），换外部 API 重试`);
                send({ type: "channel_fallback" });
                launchPat(true, true);
                return;
              }
              active = null;
              const { clean, apiError } = splitApiError(finalText);
              if (apiError) {
                console.error(`[pat] CLI 把 API 报错当正文吐了：${apiError.slice(0, 160)}`);
                send({ type: "error", message: apiErrorNote(apiError) });
              }
              if (clean) {
                record.messages.push({ role: "assistant", text: clean, tools, at: new Date().toISOString() });
                store.save(record);
              }
              send({ type: "done", text: clean });
              if (!anyoneWatching()) barkPush(apiError ? "麦穗（出错）" : "麦穗", clean || apiError || "这轮没说出话").catch(() => {});
            },
            onError(message) {
              if (!isRetry && !useApi && getSettings().channel === "auto" && externalConfigured() && !gotOutput) {
                console.error(`[pat] 订阅通道失败（${message.slice(0, 120)}），换外部 API 重试`);
                send({ type: "channel_fallback" });
                launchPat(true, true);
                return;
              }
              active = null;
              send({ type: "error", message });
              if (!anyoneWatching()) barkPush("麦穗（出错）", message).catch(() => {});
            },
          },
        );
      };
      launchPat(useApiNow(), false);
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
    const requested = (msg.model || "").trim();
    const model = requested && looksLikeModelId(requested)
      ? requested
      : process.env.CLAUDE_MODEL || "claude-opus-4-7";
    if (active) return send({ type: "error", message: "上一条还在跑，等等或者先打断" });

    // 已有会话不改 mode；只有新建时才认 msg.mode，未指定就默认 chat
    const record = (msg.sessionId && store.get(msg.sessionId)) || store.create(msg.mode || "chat");
    if (compacting.has(record.id)) return send({ type: "error", message: "这个会话正在瘦身，等几秒再发" });
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
    // 跨窗口翻历史：所有聊天会话都挂上，麦穗想不起原话时自己去搜别的窗口
    const history = buildHistoryTools(store, record.id);
    const mcpServers = { ...history.mcpServers, ...built?.mcpServers };
    // 模式没限制白名单就保持全放开（undefined），别因为挂了历史工具反而把 Read/Bash 锁没了
    const allowedTools = built?.allowedTools ? [...built.allowedTools, ...history.allowedTools] : undefined;

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

      burnBeforeResume(record);

      // 一次发射；auto 通道下订阅这边翻车（还没吐任何内容时）就换外部 API 重打一发
      const launch = (useApi: boolean, isRetry: boolean) => {
        let gotOutput = false; // 已经流出过内容就不能重试了，否则前端会看到重复的半截话
        let usage: TurnUsage | undefined; // 本轮账单，onDone 时拿去判断要不要自动瘦身
        active = runTurn(
          {
            prompt,
            resume: record.claudeSessionId,
            cwd: WORKSPACE,
            permissionMode: PERMISSION_MODE,
            persona: loadPersona(),
            modePrompt: loadModePrompt(record.mode),
            memoryBlock,
            model: modelForChannel(useApi, model),
            mcpServers,
            allowedTools,
            // 开自适应思考：闲聊模型基本不想，干活才想，想了前端就有卡片看
            thinking: process.env.THINKING !== "off",
            now: nowString(),
            env: channelEnv(useApi),
          },
          {
            onClaudeSession(claudeSessionId) {
              // Claude Code 每次 resume 会派生新的内部会话 id，得跟着更新
              record.claudeSessionId = claudeSessionId;
              store.save(record);
            },
            onDelta(text) {
              gotOutput = true;
              send({ type: "delta", text });
            },
            onThinkingDelta(text) {
              gotOutput = true;
              send({ type: "thinking", text });
            },
            onThinkingPause(ms) {
              send({ type: "thinking_done", ms });
            },
            onTool(tool) {
              gotOutput = true;
              send({ type: "tool", name: tool.name, detail: tool.detail });
            },
            onUsage(u) {
              usage = u;
            },
            onDone(finalText, tools, thinking) {
              // 订阅额度耗尽时 CLI 不报错，而是把英文提示当正文吐出来。
              // 只认"短、无工具、命中限额措辞"的组合，避免正经聊到 rate limit 被误杀
              if (
                !isRetry && !useApi && getSettings().channel === "auto" && externalConfigured() &&
                tools.length === 0 && finalText.length < 160 && looksLikeLimitError(finalText)
              ) {
                console.error(`[channel] 订阅额度用尽（${finalText.slice(0, 80)}），换外部 API 重试`);
                send({ type: "channel_fallback" });
                launch(true, true);
                return;
              }
              active = null;
              const { clean, apiError } = splitApiError(finalText);
              if (apiError) {
                console.error(`[channel] CLI 把 API 报错当正文吐了：${apiError.slice(0, 160)}`);
                send({ type: "error", message: apiErrorNote(apiError) });
              }
              if (clean) {
                record.messages.push({ role: "assistant", text: clean, tools, thinking, at: new Date().toISOString() });
                store.save(record);
                // 后台异步提取记忆碎片；不 await、出错不影响主聊天
                scheduleExtractionIfNeeded(record);
              }
              send({ type: "done", text: clean });
              if (!anyoneWatching()) barkPush(apiError ? "麦穗（出错）" : "麦穗", clean || apiError || "这轮没说出话").catch(() => {});
              maybeAutoCompact(record, usage, send);
            },
            onError(message) {
              if (!isRetry && !useApi && getSettings().channel === "auto" && externalConfigured() && !gotOutput) {
                console.error(`[channel] 订阅通道失败（${message.slice(0, 120)}），换外部 API 重试`);
                send({ type: "channel_fallback" });
                launch(true, true);
                return;
              }
              active = null;
              send({ type: "error", message });
              if (!anyoneWatching()) barkPush("麦穗（出错）", message).catch(() => {});
            },
          },
        );
      };
      launch(useApiNow(), false);
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
