import { getDb } from "./db.js";

/**
 * 检索一条用户消息相关的记忆碎片。设计参考 MemoryConstellations
 * (MIT, Clara Shafiq & Draco Malfoy)：多源融合 + 年龄衰减 + 热度抑制 + 权限标签。
 *
 * 用法：
 *   const memories = await retrieve(userMessage);
 *   if (memories.length) markRetrieved(memories.map(m => m.id));
 *
 * 加向量搜索的口子：实现一个 SearchSource 塞到 SOURCES 数组里即可，retrieve() 不用改。
 */

export type Permission = "可引用" | "需谨慎" | "仅联想";

export interface RetrievedFragment {
  id: number;
  text: string;
  entity: string | null;
  entityKind: string | null;
  ageDays: number;
  score: number;
  source: "fts" | "entity" | "vector";
  permission: Permission;
}

interface Candidate {
  id: number;
  text: string;
  entityId: number | null;
  entityName: string | null;
  entityKind: string | null;
  createdAt: string;
  readCount: number;
  baseScore: number;   // 0..1 相对，各源自己归一
  source: "fts" | "entity" | "vector";
}

export interface SearchSource {
  readonly name: "fts" | "entity" | "vector";
  search(query: string, limit: number): Candidate[] | Promise<Candidate[]>;
}

// 参数（改这一小块就能调）
const TOP_K = 8;
const PER_SOURCE_LIMIT = 16;   // 每源多取一些，融合后再截
const MIN_SCORE = 0.02;        // 静默地板：低于这个宁可空手
const AGE_HALFLIFE_DAYS = 30;  // 每 30 天热度减半

// —— FTS 源 —— 走 trigram 全文索引
class FtsSource implements SearchSource {
  readonly name = "fts" as const;
  search(query: string, limit: number): Candidate[] {
    const match = buildTrigramMatch(query);
    if (!match) return [];
    const db = getDb();
    let rows: Array<{
      id: number; text: string; entity_id: number | null; created_at: string; read_count: number;
      entity_name: string | null; entity_kind: string | null;
    }>;
    try {
      rows = db.prepare(
        `SELECT f.id, f.text, f.entity_id, f.created_at, f.read_count,
                e.name AS entity_name, e.kind AS entity_kind
         FROM fragments_fts
         JOIN fragments f ON f.id = fragments_fts.rowid
         LEFT JOIN entities e ON e.id = f.entity_id
         WHERE fragments_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      ).all(match, limit) as typeof rows;
    } catch {
      // MATCH 语法拼错或空结果，都返回 0 条
      return [];
    }
    // 位置分：第 i 条得 1/(1+i)，简单且和 bm25 单调
    return rows.map((r, i) => ({
      id: r.id,
      text: r.text,
      entityId: r.entity_id,
      entityName: r.entity_name,
      entityKind: r.entity_kind,
      createdAt: r.created_at,
      readCount: r.read_count,
      baseScore: 1 / (1 + i),
      source: "fts" as const,
    }));
  }
}

// —— 实体源 —— 用户消息里出现实体名（"妈妈"、"成都"）就把该实体的时间线拉出来
class EntitySource implements SearchSource {
  readonly name = "entity" as const;
  search(query: string, limit: number): Candidate[] {
    const db = getDb();
    const entities = db.prepare(
      "SELECT id, name, kind FROM entities ORDER BY updated_at DESC LIMIT 200",
    ).all() as Array<{ id: number; name: string; kind: string }>;
    // 实体名太短（1 字）容易误伤，跳过
    const hits = entities.filter((e) => e.name.length >= 2 && query.includes(e.name));
    if (!hits.length) return [];
    const perEntity = Math.max(3, Math.floor(limit / hits.length));
    const out: Candidate[] = [];
    for (const h of hits) {
      const rows = db.prepare(
        `SELECT id, text, entity_id, created_at, read_count
         FROM fragments WHERE entity_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      ).all(h.id, perEntity) as Array<{ id: number; text: string; entity_id: number; created_at: string; read_count: number }>;
      rows.forEach((r, i) => {
        out.push({
          id: r.id,
          text: r.text,
          entityId: r.entity_id,
          entityName: h.name,
          entityKind: h.kind,
          createdAt: r.created_at,
          readCount: r.read_count,
          // 实体直接命中给高分，同一实体内越新越高
          baseScore: 0.75 * (1 / (1 + i)) + 0.25,
          source: "entity" as const,
        });
      });
    }
    return out.slice(0, limit);
  }
}

// —— 向量源（占位）—— 未来加：new VectorSource(embedFn) 塞进 SOURCES
// 接口和 FTS/实体一致，retrieve() 不用改
// class VectorSource implements SearchSource { ... }

const SOURCES: SearchSource[] = [new FtsSource(), new EntitySource()];

export async function retrieve(query: string): Promise<RetrievedFragment[]> {
  const q = (query || "").trim();
  if (!q) return [];

  // 并发所有源
  const results = await Promise.all(SOURCES.map((s) => s.search(q, PER_SOURCE_LIMIT)));
  const all = results.flat();
  if (!all.length) return [];

  // 同一 id 可能被多源命中，取最高 baseScore；来源留分数最高的那个
  const byId = new Map<number, Candidate>();
  for (const c of all) {
    const prev = byId.get(c.id);
    if (!prev || c.baseScore > prev.baseScore) byId.set(c.id, c);
  }

  const now = Date.now();
  const scored: RetrievedFragment[] = [];
  for (const c of byId.values()) {
    const ageMs = Math.max(0, now - Date.parse(c.createdAt));
    const ageDays = Math.floor(ageMs / 86_400_000);
    // 半衰期衰减
    const ageDecay = Math.pow(0.5, ageDays / AGE_HALFLIFE_DAYS);
    // 热度抑制：被翻牌越多，得分越低
    const novelty = 1 / (1 + Math.log10(1 + c.readCount));
    const finalScore = c.baseScore * ageDecay * novelty;
    if (finalScore < MIN_SCORE) continue;
    scored.push({
      id: c.id,
      text: c.text,
      entity: c.entityName,
      entityKind: c.entityKind,
      ageDays,
      score: finalScore,
      source: c.source,
      permission: permissionOf(ageDays, finalScore),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, TOP_K);
}

/** 每次注入调这个：把选出的 id 记 read_count +=1 */
export function markRetrieved(ids: number[]): void {
  if (!ids.length) return;
  const db = getDb();
  const stmt = db.prepare("UPDATE fragments SET read_count = read_count + 1 WHERE id = ?");
  const tx = db.transaction((xs: number[]) => {
    for (const id of xs) stmt.run(id);
  });
  tx(ids);
}

/**
 * 权限标签：告诉麦穗这条能不能直接说出来。
 * - 可引用：新（<=30 天）且得分高 → 直说没问题
 * - 需谨慎：中等年龄（<=90 天）或中等分 → 要用"我记得好像"这类模糊语
 * - 仅联想：老的或分低 → 不能作为事实说出，只能内心参考
 */
function permissionOf(ageDays: number, score: number): Permission {
  if (ageDays <= 30 && score >= 0.15) return "可引用";
  if (ageDays <= 90 && score >= 0.05) return "需谨慎";
  return "仅联想";
}

/**
 * 把用户消息切成 3-gram 集合，OR 拼成 FTS5 MATCH 表达式。
 * 中文 trigram 索引下这是"任意 3 字连续片段命中即算"的召回。
 */
function buildTrigramMatch(query: string): string {
  // 去掉标点空白和 FTS5 保留字（" ' ( ) * : - + . 等会被 FTS 解析）
  const clean = query.replace(/[\s\p{P}"'()*:\-+.]/gu, "").slice(0, 200);
  if (!clean) return "";
  if (clean.length <= 3) return `"${clean}"`;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= clean.length; i++) grams.add(clean.slice(i, i + 3));
  // 只留最多 30 个 trigram（避免超长 MATCH 拖累性能）
  const capped = [...grams].slice(0, 30);
  return capped.map((g) => `"${g}"`).join(" OR ");
}
