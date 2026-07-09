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

interface Settings {
  channel: Channel;
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

export function setChannel(channel: Channel): Settings {
  const s = { ...getSettings(), channel };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
  cached = s;
  return s;
}

/** 外部 API 是否已配置（key 只放 .env，绝不进 settings.json） */
export function externalConfigured(): boolean {
  return Boolean(process.env.EXTERNAL_API_KEY);
}

/**
 * 给 agent SDK 拉起的 CLI 子进程算环境变量。
 * 走外部 API 时注入 ANTHROPIC_API_KEY——环境变量在 CLI 认证优先级里排第一，
 * 会盖过订阅 OAuth，但只对这个子进程生效，订阅登录本身不受影响。
 * 走订阅时返回 undefined，SDK 让子进程原样继承 process.env。
 */
export function channelEnv(useApi: boolean): Record<string, string | undefined> | undefined {
  if (!useApi) return undefined;
  const key = process.env.EXTERNAL_API_KEY;
  if (!key) return undefined;
  const env: Record<string, string | undefined> = {
    ...process.env,
    ANTHROPIC_API_KEY: key,
  };
  // 中转站之类的自定义接入点，可选
  if (process.env.EXTERNAL_API_BASE_URL) {
    env.ANTHROPIC_BASE_URL = process.env.EXTERNAL_API_BASE_URL;
  }
  return env;
}

/** 当前设置下，一次普通调用该不该走外部 API（auto 的重试逻辑在调用方） */
export function useApiNow(): boolean {
  return getSettings().channel === "api" && externalConfigured();
}

/** 订阅额度耗尽的报错长这样（CLI 的英文提示），auto 模式靠它决定要不要换通道重试 */
export function looksLikeLimitError(message: string): boolean {
  return /usage limit|limit reached|rate.?limit|out of.*(credit|quota)|exceeded/i.test(message);
}
