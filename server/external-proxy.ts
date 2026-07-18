import type http from "node:http";
import { Readable, pipeline } from "node:stream";
import { createBrotliDecompress } from "node:zlib";
import { ProxyAgent, request, type Dispatcher } from "undici";
import { externalRequest } from "./settings.js";

const NETWORK_PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const dispatcher: Dispatcher | undefined = NETWORK_PROXY ? new ProxyAgent(NETWORK_PROXY) : undefined;

/** 这条代理只给本机 Claude CLI 用，不能变成局域网里的免鉴权 API 转发器。 */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** Anthropic 正常 JSON/SSE 的开头；不是这些且没压缩标头，就尝试修复中转站漏标的 Brotli。 */
export function isPlainAnthropicBodyStart(chunk: Buffer): boolean {
  const start = chunk.subarray(0, 80).toString("utf8").trimStart();
  return start.startsWith("{")
    || start.startsWith("[")
    || start.startsWith("event:")
    || start.startsWith("data:")
    || start.startsWith(":");
}

export function shouldRepairUnlabelledBrotli(
  contentType: string | string[] | undefined,
  contentEncoding: string | string[] | undefined,
  firstChunk: Buffer,
): boolean {
  const type = Array.isArray(contentType) ? contentType.join(";") : contentType || "";
  return !contentEncoding
    && /(?:application\/json|text\/event-stream)/i.test(type)
    && firstChunk.length > 0
    && !isPlainAnthropicBodyStart(firstChunk);
}

function copyRequestHeaders(req: http.IncomingMessage, authHeaders: Record<string, string>): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (
      value === undefined
      || ["host", "connection", "transfer-encoding", "content-length", "authorization", "x-api-key", "accept-encoding"].includes(name)
    ) continue;
    headers[name] = value;
  }
  // 上游应用自己已经错误地套了一层无标头 Brotli；不让 CDN 再按客户端偏好套 gzip，
  // 否则会变成“有标头 gzip + 无标头 Brotli”的双层响应。
  headers["accept-encoding"] = "identity";
  // 不信任来访请求里带的凭证，只使用设置页里当前生效的 key。
  Object.assign(headers, authHeaders);
  return headers;
}

function copyResponseHeaders(
  headers: Record<string, string | string[] | undefined>,
  repaired: boolean,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (["connection", "keep-alive", "transfer-encoding", "content-length"].includes(lower)) continue;
    if (repaired && lower === "content-encoding") continue;
    out[name] = value;
  }
  if (repaired) out["x-maitian-brotli-repaired"] = "1";
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * 中转站的 5xx 多半是这一次轮到了号池里的坏号，换个请求常常就好。
 * 只在还没给客户端回过任何字节的阶段重试（整体 5xx 或连接失败）；
 * 开始转发后的断流救不了。最后一次的结果哪怕仍是 5xx 也原样交回，CLI 层自己决定下一步。
 */
export async function requestUpstreamWithRetry<T extends { statusCode: number; body: { dump(): Promise<void> } }>(
  doRequest: () => Promise<T>,
  opts: {
    attempts?: number;
    delayMs?: (attempt: number) => number;
    onRetry?: (reason: string, attempt: number) => void;
  } = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const delay = opts.delayMs ?? ((attempt: number) => attempt * 1000);
  for (let attempt = 1; ; attempt++) {
    let upstream: T;
    try {
      upstream = await doRequest();
    } catch (err) {
      if (attempt >= attempts) throw err;
      opts.onRetry?.(err instanceof Error ? err.message : String(err), attempt);
      await sleep(delay(attempt));
      continue;
    }
    if (upstream.statusCode >= 500 && attempt < attempts) {
      upstream.body.dump().catch(() => {});
      opts.onRetry?.(`HTTP ${upstream.statusCode}`, attempt);
      await sleep(delay(attempt));
      continue;
    }
    return upstream;
  }
}

/**
 * 转发 Claude CLI 的 Anthropic 请求。
 * 某些中转站会返回 Brotli 字节却漏掉 Content-Encoding: br；这里流式解压后再交给 CLI。
 * 上游整体 5xx / 连不上时先自己重试两次再放行结果。
 */
export async function proxyExternalAnthropic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathAfterPrefix: string,
): Promise<void> {
  const config = externalRequest();
  if (!config) {
    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { type: "configuration_error", message: "外部 API 没配置" } }));
    return;
  }

  const target = `${config.baseUrl.replace(/\/+$/, "")}${pathAfterPrefix}`;
  try {
    // 请求体收进内存才能在重试时原样重发（流只能读一次）
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await collectRequestBody(req);
    const upstream = await requestUpstreamWithRetry(
      () => request(target, {
        method: req.method as Dispatcher.HttpMethod,
        headers: copyRequestHeaders(req, config.headers),
        body,
        dispatcher,
        headersTimeout: 60_000,
        bodyTimeout: 0,
      }),
      {
        onRetry: (reason, attempt) =>
          console.warn(`[external-proxy] 上游失败（${reason}），${attempt} 秒后第 ${attempt + 1} 次尝试`),
      },
    );

    const iterator = upstream.body[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) {
      res.writeHead(upstream.statusCode, copyResponseHeaders(upstream.headers, false));
      res.end();
      return;
    }

    const firstChunk = Buffer.isBuffer(first.value) ? first.value : Buffer.from(first.value);
    const repaired = shouldRepairUnlabelledBrotli(
      upstream.headers["content-type"],
      upstream.headers["content-encoding"],
      firstChunk,
    );
    async function* withFirst(): AsyncGenerator<Buffer> {
      yield firstChunk;
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        yield Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      }
    }

    const source = Readable.from(withFirst());
    const output = repaired ? source.pipe(createBrotliDecompress()) : source;
    if (repaired) console.warn(`[external-proxy] 修复了漏标 Content-Encoding 的 Brotli 响应（HTTP ${upstream.statusCode}）`);
    res.writeHead(upstream.statusCode, copyResponseHeaders(upstream.headers, repaired));
    pipeline(output, res, (err) => {
      if (err && !res.destroyed) {
        console.error(`[external-proxy] 响应转发失败：${err.message}`);
        res.destroy(err);
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[external-proxy] 请求失败：${message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: { type: "proxy_error", message } }));
    } else {
      res.destroy();
    }
  }
}
