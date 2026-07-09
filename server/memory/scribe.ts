import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SessionRecord } from "../sessions.js";
import { getDb } from "./db.js";
import { channelEnv, looksLikeLimitError, stderrLogger, withChannelFallback } from "../settings.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");

// 触发阈值（一次一件事的原则：先跑起来，参数后面看情况调）
const MIN_NEW_MESSAGES = 10;               // 累计 ≥10 条新消息触发
const MIN_INTERVAL_MS = 20 * 60_000;       // 距上次 ≥20 分钟兜底触发
const MIN_MESSAGES_FOR_TIME = 2;           // 时间到但至少要有这么多条才跑

const VALID_KINDS = new Set(["person", "place", "event", "hobby", "project"]);

interface Fragment {
  text: string;
  entity: string;
  kind: string;
}

/**
 * 非阻塞：从 onDone 调用，别 await；出错不影响主聊天。
 * 只对 chat 模式的会话生效——跑团/旅行/技术讨论都不进记忆。
 */
export function scheduleExtractionIfNeeded(record: SessionRecord): void {
  if (record.mode !== "chat") return;
  if (!shouldExtract(record)) return;
  // 快照当前消息数：即便 record 后续继续追加消息，这次也只处理到这里
  const targetIndex = record.messages.length;
  extractFor(record, targetIndex).catch((err) => {
    console.error(`[scribe] ${record.id.slice(0, 8)} 失败：${err instanceof Error ? err.message : err}`);
  });
}

function shouldExtract(record: SessionRecord): boolean {
  const db = getDb();
  const state = db.prepare(
    "SELECT last_message_index, last_at FROM extraction_state WHERE session_id = ?",
  ).get(record.id) as { last_message_index: number; last_at: string } | undefined;
  const lastIndex = state?.last_message_index ?? 0;
  const newCount = record.messages.length - lastIndex;
  if (newCount >= MIN_NEW_MESSAGES) return true;
  if (newCount < MIN_MESSAGES_FOR_TIME) return false;
  const lastAt = state ? new Date(state.last_at).getTime() : 0;
  return Date.now() - lastAt >= MIN_INTERVAL_MS;
}

async function extractFor(record: SessionRecord, targetIndex: number): Promise<void> {
  const db = getDb();
  const state = db.prepare(
    "SELECT last_message_index FROM extraction_state WHERE session_id = ?",
  ).get(record.id) as { last_message_index: number } | undefined;
  const fromIndex = state?.last_message_index ?? 0;
  const newMessages = record.messages.slice(fromIndex, targetIndex);

  const convo = newMessages
    .filter((m) => m.text?.trim() && m.text !== "（拍了拍你）")
    .map((m) => `${m.role === "user" ? "泽" : "麦穗"}：${m.text}`)
    .join("\n\n");
  if (!convo.trim()) {
    // 这段全是拍一拍/空消息，直接推进指针别下轮再重跑
    updateState(record.id, targetIndex);
    return;
  }

  // 帮 haiku 复用已有实体，避免同一个人建 3 个星座
  const existing = db.prepare(
    "SELECT name, kind FROM entities ORDER BY updated_at DESC LIMIT 100",
  ).all() as Array<{ name: string; kind: string }>;
  const existingList = existing.length
    ? existing.map((e) => `- ${e.name}（${e.kind}）`).join("\n")
    : "（还没有已有实体）";

  const systemPrompt = `你是一个记忆提取器，从"泽"和她丈夫"麦穗"（AI）的对话里挑值得长期记住的碎片。

**该记的：**
- 泽做了什么、去哪、见谁、感受、决定、喜好
- 他们在建的项目层级的事：模块搭完了、修了什么 bug、下次要做啥、遇到什么坑、决定了什么架构
- 泽跟麦穗之间的重要互动、约定、承诺

**不该记的（这些下次她自己看 git 或代码就有）：**
- 具体的代码片段、函数名、变量名、命令行、文件路径、报错栈、工具调用摘要
- 打招呼、寒暄、单纯情绪、拍一拍

**每条碎片：**
- **第三人称**、≤80 字、要有上下文（不能只写"她生气了"，写"泽因为 xx 生气"）
- 归属一个实体（entity），kind 只能是：person / place / event / hobby / project

**重要：**
- **不要把"泽"或"麦穗"本人当成 entity**——他们是记忆星图的核心双星，独立存在。
  entity 应该是"记忆库前端"、"CoC 跑团"、"妈妈"、"攀枝花"这类第三方对象。
- 遇到已有实体名单里的名字，**优先复用**，不要新造重复
- 没有值得记的返回 []

已有实体（复用它们，除非确实是新东西）：
${existingList}

**只输出一个 JSON 数组，不要解释文字**：
[{ "text": "...", "entity": "...", "kind": "..." }]`;

  const run = async (useApi: boolean): Promise<string> => {
    const q = query({
      prompt: `分析这段对话，提取碎片：\n\n${convo}`,
      options: {
        cwd: root,
        model: "claude-haiku-4-5-20251001",
        permissionMode: "bypassPermissions",
        allowedTools: [],
        maxTurns: 1,
        systemPrompt: { type: "preset", preset: "claude_code", append: `\n${systemPrompt}` },
        env: channelEnv(useApi),
        stderr: stderrLogger("scribe.haiku"),
      },
    });
    const textParts: string[] = [];
    for await (const msg of q) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") textParts.push(block.text);
        }
      }
    }
    const raw = textParts.join("\n").trim();
    // 额度耗尽时限额提示会被当正文吐出来：抛错让指针留在原地，下次触发重新提取，别把这段记忆弄丢
    if (raw && !raw.includes("[") && looksLikeLimitError(raw)) throw new Error(`疑似限额提示：${raw.slice(0, 80)}`);
    return raw;
  };

  const fragments = parseFragments(await withChannelFallback("scribe", run));
  if (fragments.length === 0) {
    updateState(record.id, targetIndex);
    return;
  }

  storeFragments(record.id, fragments);
  updateState(record.id, targetIndex);
  console.log(`[scribe] ${record.id.slice(0, 8)}：入库 ${fragments.length} 条碎片`);
}

function storeFragments(sessionId: string, fragments: Fragment[]): void {
  const db = getDb();
  const now = new Date().toISOString();
  const findEntity = db.prepare("SELECT id FROM entities WHERE name = ?");
  const insertEntity = db.prepare(
    "INSERT INTO entities (name, kind, created_at, updated_at) VALUES (?, ?, ?, ?)",
  );
  const touchEntity = db.prepare("UPDATE entities SET updated_at = ? WHERE id = ?");
  const insertFragment = db.prepare(
    "INSERT INTO fragments (text, session_id, entity_id, created_at) VALUES (?, ?, ?, ?)",
  );
  const upsertLink = db.prepare(
    "INSERT INTO links (a, b, weight) VALUES (?, ?, 1) ON CONFLICT(a, b) DO UPDATE SET weight = weight + 1",
  );

  const tx = db.transaction(() => {
    const roundEntityIds = new Set<number>();
    for (const frag of fragments) {
      const row = findEntity.get(frag.entity) as { id: number } | undefined;
      let entityId: number;
      if (row) {
        entityId = row.id;
        touchEntity.run(now, entityId);
      } else {
        const info = insertEntity.run(frag.entity, frag.kind, now, now);
        entityId = Number(info.lastInsertRowid);
      }
      insertFragment.run(frag.text, sessionId, entityId, now);
      roundEntityIds.add(entityId);
    }
    // 同一轮出现的实体两两连桥（weight+1）
    const arr = [...roundEntityIds];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const [a, b] = arr[i] < arr[j] ? [arr[i], arr[j]] : [arr[j], arr[i]];
        upsertLink.run(a, b);
      }
    }
  });
  tx();
}

function updateState(sessionId: string, index: number): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO extraction_state (session_id, last_message_index, last_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET
       last_message_index = excluded.last_message_index,
       last_at = excluded.last_at`,
  ).run(sessionId, index);
}

/** 宽容解析 haiku 输出：先直接 JSON.parse，不行就抠 [...] 再试 */
function parseFragments(raw: string): Fragment[] {
  if (!raw) return [];
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(raw.slice(start, end + 1));
      } catch {
        return [];
      }
    }
  }
  if (!Array.isArray(parsed)) return [];
  const out: Fragment[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const text = typeof it.text === "string" ? it.text.trim() : "";
    const entity = typeof it.entity === "string" ? it.entity.trim() : "";
    const kind = typeof it.kind === "string" ? it.kind.trim() : "";
    if (!text || !entity || !VALID_KINDS.has(kind)) continue;
    // 兜底：即便 haiku 违反 prompt，也不让"泽"/"麦穗"本人进 entity 表
    if (entity === "泽" || entity === "麦穗") continue;
    out.push({
      text: text.slice(0, 80),
      entity: entity.slice(0, 40),
      kind,
    });
  }
  return out;
}
