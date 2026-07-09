import { fetch, ProxyAgent, FormData, type Dispatcher } from "undici";

const KEY = process.env.ELEVENLABS_KEY || "";

// 和 tts.ts 一样：显式走代理，没配就不设
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const dispatcher: Dispatcher | undefined = PROXY ? new ProxyAgent(PROXY) : undefined;

export function sttEnabled(): boolean {
  return KEY.length > 0;
}

/**
 * 语音转文字：ElevenLabs Scribe。
 * 收前端 MediaRecorder 录出来的整段音频（iPhone 是 audio/mp4，其他多为 webm）。
 */
export async function transcribe(audio: Buffer, mime: string): Promise<string> {
  if (!sttEnabled()) throw new Error("STT 没配置：ELEVENLABS_KEY");

  const form = new FormData();
  form.append("model_id", "scribe_v1");
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime || "audio/mp4" }), "speech.m4a");

  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    dispatcher,
    headers: { "xi-api-key": KEY },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ElevenLabs STT ${res.status}：${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as { text?: string };
  return (data.text || "").trim();
}
