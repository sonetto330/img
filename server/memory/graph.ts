import { getDb } from "./db.js";

export interface GraphEntity {
  id: number;
  name: string;
  kind: string;
  fragmentCount: number;
  updatedAt: string;
}

export interface GraphLink {
  a: number;
  b: number;
  weight: number;
}

export interface EntityDetail {
  id: number;
  name: string;
  kind: string;
  overview: string | null;
  fragments: Array<{
    id: number;
    text: string;
    createdAt: string;
    ageDays: number;
    sessionId: string | null;
  }>;
}

/** 前端星图页拉整张图：所有实体 + 桥。数据量小（单用户，实体上限几百）直接一次全给 */
export function getGraph(): { entities: GraphEntity[]; links: GraphLink[] } {
  const db = getDb();
  const entities = db.prepare(
    `SELECT e.id, e.name, e.kind, e.updated_at AS updatedAt,
            (SELECT COUNT(*) FROM fragments f WHERE f.entity_id = e.id) AS fragmentCount
     FROM entities e
     ORDER BY e.updated_at DESC`,
  ).all() as GraphEntity[];
  const links = db.prepare("SELECT a, b, weight FROM links").all() as GraphLink[];
  return { entities, links };
}

/** 侧栏详情：单个实体的所有碎片 */
export function getEntityDetail(id: number): EntityDetail | null {
  const db = getDb();
  const entity = db.prepare(
    "SELECT id, name, kind, overview FROM entities WHERE id = ?",
  ).get(id) as { id: number; name: string; kind: string; overview: string | null } | undefined;
  if (!entity) return null;
  const rows = db.prepare(
    `SELECT id, text, created_at AS createdAt, session_id AS sessionId
     FROM fragments WHERE entity_id = ?
     ORDER BY created_at DESC`,
  ).all(id) as Array<{ id: number; text: string; createdAt: string; sessionId: string | null }>;
  const now = Date.now();
  return {
    ...entity,
    fragments: rows.map((r) => ({
      ...r,
      ageDays: Math.max(0, Math.floor((now - Date.parse(r.createdAt)) / 86_400_000)),
    })),
  };
}
