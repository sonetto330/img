import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, "..", "data");
const FILE = path.join(DATA_DIR, "settings.json");

/**
 * 调用通道：
 * - subscription：走 CLI 订阅登录（原样继承进程环境）
 * - api：走外部 API key（.env 里的 EXTERNAL_API_KEY，按量计费）
 * - auto：订阅优先，订阅报额度类错误时自动换外部 API 重试一次
 */
export type Channel = "subscription" | "api" | "auto";
export type ExternalAuth = "x-api-key" | "bearer";

interface Settings {
  channel: Channel;
  /** 外部 API 配置：设置页填的存这里（data/ 在 .gitignore 里）；没填就用 .env 里的兜底 */
  externalKey?: string;
  externalBaseUrl?: string;
  externalAuth?: ExternalAuth;
  /** 走外部通道时对话用的模型 id（中转站的模型名常跟官方不一样）；不填就原样传 */
  externalModel?: string;
  /** 走外部通道时后台小活（问候/记忆提取/翻译）用的模型 id；不填用官方 haiku 名 */
  externalHaiku?: string;
}

const DEFAULTS: Settings = { channel: "subscription" };

let cached: Settings | null = null;

export function getSettings(): Settings {
  if (cached) return cached;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    cached = { ...DEFAULTS, ...raw };
  } catch {
    cached = { ...DEFAULTS };
  }
  return cached!;
}

function save(s: Settings): Settings {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 里面有 key，文件权限收紧到只有本用户可读（Windows 上此参数无效，无妨）
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  cached = s;
  return s;
}

export function setChannel(channel: Channel): Settings {
  return save({ ...getSettings(), channel });
}

/** 设置页改外部 API 配置：传空字符串 = 清掉设置页的值、回退到 .env 里的 */
export function setExternal(patch: {
  key?: string;
  baseUrl?: string;
  auth?: ExternalAuth | "";
  model?: string;
  haiku?: string;
}): Settings {
  const s = { ...getSettings() };
  if (patch.key !== undefined) s.externalKey = patch.key.trim() || undefined;
  if (patch.baseUrl !== undefined) s.externalBaseUrl = patch.baseUrl.trim() || undefined;
  if (patch.auth !== undefined) s.externalAuth = patch.auth || undefined;
  if (patch.model !== undefined) s.externalModel = patch.model.trim() || undefined;
  if (patch.haiku !== undefined) s.externalHaiku = patch.haiku.trim() || undefined;
  return save(s);
}

/** 生效的外部 key：设置页填的优先，其次 .env */
function effectiveKey(): string {
  return (getSettings().externalKey || process.env.EXTERNAL_API_KEY || "").trim();
}

function effectiveBaseUrl(): string {
  return (getSettings().externalBaseUrl || process.env.EXTERNAL_API_BASE_URL || "").trim();
}

function effectiveAuth(): ExternalAuth {
  const s = getSettings().externalAuth;
  if (s) return s;
  return process.env.EXTERNAL_API_AUTH === "bearer" ? "bearer" : "x-api-key";
}

/** 外部 API 是否已配置（设置页或 .env 任一处有 key 即可） */
export function externalConfigured(): boolean {
  return Boolean(effectiveKey());
}

/** 给设置页 GET 用的回显：key 本身绝不回传，只给个掐头的尾巴确认"配了哪个" */
export function publicSettings() {
  const s = getSettings();
  const key = effectiveKey();
  return {
    channel: s.channel,
    externalConfigured: Boolean(key),
    keyTail: key ? `…${key.slice(-4)}` : "",
    keySource: s.externalKey ? "settings" : key ? "env" : "",
    externalBaseUrl: effectiveBaseUrl(),
    externalAuth: effectiveAuth(),
    externalModel: s.externalModel || "",
    externalHaiku: s.externalHaiku || "",
  };
}

/** 拉模型列表/直连外部 API 时的请求要素；没配 key 返回 null */
export function externalRequest(): { baseUrl: string; headers: Record<string, string> } | null {
  const key = effectiveKey();
  if (!key) return null;
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (effectiveAuth() === "bearer") headers.Authorization = `Bearer ${key}`;
  else headers["x-api-key"] = key;
  return { baseUrl: effectiveBaseUrl() || "https://api.anthropic.com", headers };
}

/**
 * 这一轮实际该用哪个模型：
 * 订阅通道原样；外部通道下只把"订阅系的叫法"（仨别名和 CLAUDE_MODEL 默认款）
 * 换成设置页配的"外部对话模型"——用户点的外部列表模型、手填的具体型号都原样尊重
 */
export function modelForChannel(useApi: boolean, requested: string): string {
  if (!useApi) return requested;
  const subscriptionish =
    ["opus", "sonnet", "haiku"].includes(requested) ||
    requested === (process.env.CLAUDE_MODEL || "claude-opus-4-7");
  if (!subscriptionish) return requested;
  return getSettings().externalModel || requested;
}

/** 后台小活（问候语/记忆提取/翻译）这一轮用哪个模型 */
export function haikuForChannel(useApi: boolean): string {
  if (useApi) {
    const m = getSettings().externalHaiku;
    if (m) return m;
  }
  return "claude-haiku-4-5-20251001";
}

/**
 * 给 agent SDK 拉起的 CLI 子进程算环境变量。
 * 走外部 API 时注入 ANTHROPIC_API_KEY——环境变量在 CLI 认证优先级里排第一，
 * 会盖过订阅 OAuth，但只对这个子进程生效，订阅登录本身不受影响。
 * 走订阅时返回 undefined，SDK 让子进程原样继承 process.env。
 */
export function channelEnv(useApi: boolean): Record<string, string | undefined> | undefined {
  if (!useApi) return undefined;
  const key = effectiveKey();
  if (!key) return undefined;
  const env: Record<string, string | undefined> = { ...process.env };
  // 多数中转站兼容 Anthropic 的 x-api-key 头（默认）；只认 Bearer 的切 bearer
  if (effectiveAuth() === "bearer") {
    env.ANTHROPIC_AUTH_TOKEN = key;
    delete env.ANTHROPIC_API_KEY;
  } else {
    env.ANTHROPIC_API_KEY = key;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  // 中转站/自定义接入点
  const baseUrl = effectiveBaseUrl();
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
  return env;
}

/** 当前设置下，一次普通调用该不该走外部 API（auto 的重试逻辑在调用方） */
export function useApiNow(): boolean {
  return getSettings().channel === "api" && externalConfigured();
}

/**
 * CLI 子进程 stderr 的统一日志出口。
 * 外部 API 通道下 CLI 会提醒 "connectors are disabled"（API key 优先于 claude.ai 登录，
 * 账号上挂的工具加载不了）——这是预期行为不是故障，过滤掉别刷屏。
 */
export function stderrLogger(tag: string): (data: string) => void {
  return (data) => {
    if (data.includes("connectors are disabled")) return;
    console.error(`[${tag}] ${data}`);
  };
}

/** 订阅额度耗尽的报错长这样（CLI 的英文提示），auto 模式靠它决定要不要换通道重试 */
export function looksLikeLimitError(message: string): boolean {
  return /usage limit|limit reached|rate.?limit|out of.*(credit|quota)|exceeded/i.test(message);
}

/**
 * 给一次性小任务（问候语/翻译/记忆提取）用的通道自动回退：
 * 先按当前设置跑；订阅这边抛错、或产出看着像限额提示时，
 * auto 通道下换外部 API 原样重跑一次。主聊天/通话有自己的流式重试逻辑，不走这里。
 *
 * @param isLimitResult 可选：额度耗尽时 CLI 不报错而是把英文提示当正文吐出来，
 *   用它检查"成功"的产出是不是其实是限额提示
 */
export async function withChannelFallback<T>(
  tag: string,
  run: (useApi: boolean) => Promise<T>,
  isLimitResult?: (result: T) => boolean,
): Promise<T> {
  const first = useApiNow();
  const canRetry = !first && getSettings().channel === "auto" && externalConfigured();
  try {
    const result = await run(first);
    if (canRetry && isLimitResult?.(result)) {
      console.error(`[${tag}] 订阅额度用尽，换外部 API 重试`);
      return run(true);
    }
    return result;
  } catch (err) {
    if (!canRetry) throw err;
    console.error(`[${tag}] 订阅通道失败（${err instanceof Error ? err.message.slice(0, 120) : err}），换外部 API 重试`);
    return run(true);
  }
}
