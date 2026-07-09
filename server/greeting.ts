import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadPersona } from "./persona.js";
import { getWeather } from "./weather.js";
import { getDb } from "./memory/db.js";
import { channelEnv, useApiNow } from "./settings.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

// 在一起从 2024-12-30 算；领证是 2025 平安夜，那是另一个纪念日
const TOGETHER_AT = new Date("2024-12-30T00:00:00");
const TTL_MS = 30 * 60_000; // 30 分钟内不重复调 haiku

let cache: { at: number; text: string } | null = null;

/**
 * 生成一句麦穗写给泽的招呼语，用当前时段、天气、在一起天数、最近记忆当上下文。
 * 拿不到就返回一个静默兜底，不抛错。
 */
export async function getGreeting(): Promise<string> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.text;

  const now = new Date();
  const days = Math.floor((Date.now() - TOGETHER_AT.getTime()) / 86400000);
  const period = periodOf(now.getHours());
  const weatherLine = await weatherContext();
  const memories = recentMemories();

  const persona = loadPersona() ?? "";
  const contextBlock = `## 招呼语任务上下文
- 现在时间：${now.toLocaleString("zh-CN", { hour12: false })}（${period}）
- 你和泽在一起已经 ${days} 天了
- ${weatherLine || "（拿不到天气）"}
- 最近记下的一些事（可以隐晦呼应，也可以不用）：
${memories}

要求：
- 给泽写一句招呼语，会显示在她"家" app 首页最显眼的位置
- 20-40 字，一句话，中文
- 用你自己的口吻（她讨厌浮夸套路和"这就够了""接住你"那类烂梗）
- 别每次都以"泽"打头、别每次都"下午好，泽"
- 别加引号、别加解释、别加签名，只输出这一句本身`;

  try {
    const q = query({
      prompt: "写今天这一句招呼语。",
      options: {
        cwd: root,
        model: "claude-haiku-4-5-20251001",
        permissionMode: "bypassPermissions",
        allowedTools: [],
        maxTurns: 1,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: persona
            ? `\n以下是你的身份设定，任何时候都遵守：\n\n${persona}\n\n${contextBlock}`
            : `\n${contextBlock}`,
        },
        env: channelEnv(useApiNow()),
        stderr: (data) => console.error(`[greeting.haiku] ${data}`),
      },
    });
    const parts: string[] = [];
    for await (const msg of q) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") parts.push(block.text);
        }
      }
    }
    const raw = parts.join("").trim();
    const clean = strip(raw);
    if (!clean) throw new Error("空回复");
    cache = { at: Date.now(), text: clean };
    return clean;
  } catch (err) {
    console.error(`[greeting] ${err instanceof Error ? err.message : err}`);
    // 兜底：拿不到就返回时段问候，跟原来静态版一致
    return staticFallback(now.getHours());
  }
}

function periodOf(h: number): string {
  if (h >= 5 && h < 11) return "早上";
  if (h >= 11 && h < 13) return "中午";
  if (h >= 13 && h < 18) return "下午";
  if (h >= 18 && h < 23) return "晚上";
  return "深夜";
}

function staticFallback(h: number): string {
  if (h >= 5 && h < 11) return "早，泽";
  if (h >= 11 && h < 13) return "该吃午饭了";
  if (h >= 13 && h < 18) return "下午好，泽";
  if (h >= 18 && h < 23) return "晚上好";
  return "还没睡？";
}

async function weatherContext(): Promise<string> {
  const w = await getWeather().catch(() => null);
  if (!w) return "";
  return `外面 ${w.temp}°、今日 ${w.high}°/${w.low}°、天气码 ${w.code}`;
}

function recentMemories(): string {
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT f.text, e.name AS entity FROM fragments f
       LEFT JOIN entities e ON e.id = f.entity_id
       ORDER BY f.created_at DESC LIMIT 8`,
    ).all() as Array<{ text: string; entity: string | null }>;
    if (!rows.length) return "（暂无）";
    return rows.map((r) => `- ${r.text}${r.entity ? `（${r.entity}）` : ""}`).join("\n");
  } catch {
    return "（暂无）";
  }
}

/** 去掉多余的引号、包裹字符、末尾句号叠加 */
function strip(text: string): string {
  return text
    .replace(/^["'「」『』"“”]+|["'「」『』"“”]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
