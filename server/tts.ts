import { fetch, ProxyAgent, type Dispatcher } from "undici";

const KEY = process.env.ELEVENLABS_KEY || "";
const VOICE = process.env.ELEVENLABS_VOICE || "";
const MAX_CHARS = 500;

// Node 原生 fetch 不读 HTTPS_PROXY，用 undici 的 dispatcher 显式走代理；没配代理就不设 agent
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const dispatcher: Dispatcher | undefined = PROXY ? new ProxyAgent(PROXY) : undefined;

export function ttsEnabled(): boolean {
  return KEY.length > 0 && VOICE.length > 0;
}

/** 把 markdown 里的代码块/行内代码剥掉，别让 TTS 逐字念代码 */
export function stripForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export interface TtsResult {
  audio: ArrayBuffer;
  contentType: string;
}

export async function synthesize(rawText: string): Promise<TtsResult> {
  if (!ttsEnabled()) throw new Error("TTS 没配置：ELEVENLABS_KEY / ELEVENLABS_VOICE");
  const text = stripForSpeech(rawText).slice(0, MAX_CHARS);
  if (!text) throw new Error("没有可念的内容");

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(VOICE)}`;
  const res = await fetch(url, {
    method: "POST",
    dispatcher,
    headers: {
      "xi-api-key": KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ElevenLabs ${res.status}：${detail.slice(0, 200)}`);
  }
  const audio = await res.arrayBuffer();
  const contentType = res.headers.get("content-type") || "audio/mpeg";
  return { audio, contentType };
}
