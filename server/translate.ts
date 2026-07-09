import { query } from "@anthropic-ai/claude-agent-sdk";
import { channelEnv, useApiNow } from "./settings.js";

/** 思考内容太长就掐头去尾，翻译按钮是给人看个大意的，不是做文献 */
const MAX_INPUT = 8000;

/** 把英文思考过程翻成中文口语。用 haiku：快、便宜，翻译够用 */
export async function translateThinking(text: string): Promise<string> {
  const input = text.length > MAX_INPUT ? text.slice(0, MAX_INPUT) + "\n…（后面太长截掉了）" : text;
  const q = query({
    prompt: `把下面这段 AI 的内心思考过程翻译成自然的中文口语。保持第一人称视角，语气随意点。只输出译文，不要任何解释或前后缀：\n\n${input}`,
    options: {
      model: "haiku",
      maxTurns: 1,
      allowedTools: [],
      thinking: { type: "disabled" },
      systemPrompt: "你是翻译。只输出译文本身。",
      env: channelEnv(useApiNow()),
    },
  });
  for await (const msg of q) {
    if (msg.type === "result") {
      if (msg.subtype === "success") return msg.result.trim();
      throw new Error(`翻译失败：${msg.subtype}`);
    }
  }
  throw new Error("翻译没有返回结果");
}
