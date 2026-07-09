import { fetch, ProxyAgent, type Dispatcher } from "undici";
import { externalRequest } from "./settings.js";

// 走跟天气/TTS 一样的代理策略：Node fetch 不读 HTTPS_PROXY，靠 undici dispatcher
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const dispatcher: Dispatcher | undefined = PROXY ? new ProxyAgent(PROXY) : undefined;

export interface ModelInfo {
  id: string;
  name: string;
}

/** 订阅通道 CLI 认的就是这仨别名，写死；外部通道的列表从 /v1/models 现拉 */
export const SUBSCRIPTION_MODELS: ModelInfo[] = [
  { id: "opus", name: "Opus" },
  { id: "sonnet", name: "Sonnet" },
  { id: "haiku", name: "Haiku" },
];

const TTL_MS = 10 * 60_000;
let cache: { at: number; list: ModelInfo[] } | null = null;

/**
 * 拉外部 API（官方或中转站）的模型列表。
 * 官方和 OpenAI 风格的中转都是 GET /v1/models、返回 data[].id，一套代码通吃。
 * 拉不到时返回上次的缓存 + 错误说明，别让设置页白屏。
 */
export async function listExternalModels(force = false): Promise<{ models: ModelInfo[]; error?: string }> {
  const req = externalRequest();
  if (!req) return { models: [] };
  if (!force && cache && Date.now() - cache.at < TTL_MS) return { models: cache.list };
  try {
    const res = await fetch(`${req.baseUrl.replace(/\/+$/, "")}/v1/models?limit=200`, {
      headers: req.headers,
      dispatcher,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { models: cache?.list ?? [], error: `对面回了 HTTP ${res.status}${res.status === 401 ? "（key 或验证方式不对）" : ""}` };
    }
    const data = (await res.json()) as { data?: Array<{ id?: unknown; display_name?: unknown }> };
    const models: ModelInfo[] = (data.data ?? [])
      .filter((m): m is { id: string; display_name?: unknown } => typeof m.id === "string" && m.id.length > 0)
      .map((m) => ({ id: m.id, name: typeof m.display_name === "string" && m.display_name ? m.display_name : m.id }));
    if (!models.length) return { models: cache?.list ?? [], error: "对面返回了空列表" };
    cache = { at: Date.now(), list: models };
    return { models };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { models: cache?.list ?? [], error: /timeout|abort/i.test(msg) ? "连不上（超时），检查中转地址或代理" : msg };
  }
}
