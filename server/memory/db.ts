import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
const DB_PATH = path.join(root, "data", "memory.db");

let dbInstance: Database.Database | null = null;

/**
 * 拿一把 SQLite 连接（单例）。第一次调用时打开文件并按需建表。
 * 别在别处直接 new Database，用这个函数保证只有一份连接。
 */
export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  // WAL 让写不阻塞读，提取器在后台跑时前台聊天不受影响
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  ensureSchema(db);
  dbInstance = db;
  return db;
}

/**
 * 建表：全用 IF NOT EXISTS，重复启动不会炸。
 * 表结构参考 fable 的四期规划 03-memory-constellation：碎片 → 实体 → 情节，
 * 加实体间连接（links）和中文 trigram 全文索引。
 */
/** 加列：老库没这一列就 ALTER TABLE 补上；有就跳过（PRAGMA 查列名） */
function ensureColumn(db: Database.Database, table: string, column: string, def: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((r) => r.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    -- 单条事实碎片，第三人称短句
    CREATE TABLE IF NOT EXISTS fragments (
      id INTEGER PRIMARY KEY,
      text TEXT NOT NULL,
      session_id TEXT,
      entity_id INTEGER REFERENCES entities(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'active',  -- active | consolidated
      read_count INTEGER NOT NULL DEFAULT 0,  -- 每次被注入 +1，用来做热度抑制
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS fragments_entity_idx ON fragments(entity_id);
    CREATE INDEX IF NOT EXISTS fragments_session_idx ON fragments(session_id);

    -- 星座：人 / 地点 / 事件 / 爱好 / 项目
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      kind TEXT NOT NULL,                     -- person | place | event | hobby | project
      overview TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 情节：多条碎片合并成的叙事段（P4 才写入，这版先建表占位）
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY,
      entity_id INTEGER REFERENCES entities(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS episodes_entity_idx ON episodes(entity_id);

    -- 星座之间的桥：两个实体共同出现过多少次，用来在星图里连线
    CREATE TABLE IF NOT EXISTS links (
      a INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      b INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      weight INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (a, b),
      CHECK (a < b)  -- 强制小 id 在前，避免同一对存两条
    );

    -- 提取状态：每个会话上次跑到哪条消息、什么时候跑过
    CREATE TABLE IF NOT EXISTS extraction_state (
      session_id TEXT PRIMARY KEY,
      last_message_index INTEGER NOT NULL DEFAULT 0,
      last_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 中文必须用 trigram 分词器，默认 unicode61 不切中文词
    CREATE VIRTUAL TABLE IF NOT EXISTS fragments_fts USING fts5(
      text, content='fragments', content_rowid='id', tokenize='trigram'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
      text, content='episodes', content_rowid='id', tokenize='trigram'
    );

    -- 主表变更自动同步 FTS 索引
    CREATE TRIGGER IF NOT EXISTS fragments_ai AFTER INSERT ON fragments BEGIN
      INSERT INTO fragments_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS fragments_ad AFTER DELETE ON fragments BEGIN
      INSERT INTO fragments_fts(fragments_fts, rowid, text) VALUES('delete', old.id, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS fragments_au AFTER UPDATE ON fragments BEGIN
      INSERT INTO fragments_fts(fragments_fts, rowid, text) VALUES('delete', old.id, old.text);
      INSERT INTO fragments_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
      INSERT INTO episodes_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
      INSERT INTO episodes_fts(episodes_fts, rowid, text) VALUES('delete', old.id, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS episodes_au AFTER UPDATE ON episodes BEGIN
      INSERT INTO episodes_fts(episodes_fts, rowid, text) VALUES('delete', old.id, old.text);
      INSERT INTO episodes_fts(rowid, text) VALUES (new.id, new.text);
    END;
  `);

  // 迁移：老库如果没 read_count 列（D.1 版本创建的）补上
  ensureColumn(db, "fragments", "read_count", "INTEGER NOT NULL DEFAULT 0");
}
