import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface Attachment {
  /** 服务器上保存的文件名（uploads 目录内） */
  file: string;
  /** 原始文件名 */
  name: string;
  kind: "image" | "file";
}

export interface StoredMessage {
  role: "user" | "assistant";
  text: string;
  /** 早期记录是字符串数组，后来带 detail，两种都要能读 */
  tools?: Array<string | { name: string; detail?: string }>;
  attachments?: Attachment[];
  at: string;
}

export interface SessionRecord {
  id: string;
  title: string;
  claudeSessionId?: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredMessage[];
}

export class SessionStore {
  private dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "sessions");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private file(id: string): string {
    // id 只允许 uuid 格式，防止路径穿越
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("bad session id");
    return path.join(this.dir, `${id}.json`);
  }

  create(): SessionRecord {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: randomUUID(),
      title: "新会话",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.save(record);
    return record;
  }

  get(id: string): SessionRecord | null {
    try {
      return JSON.parse(fs.readFileSync(this.file(id), "utf8")) as SessionRecord;
    } catch {
      return null;
    }
  }

  save(record: SessionRecord): void {
    record.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.file(record.id), JSON.stringify(record, null, 2));
  }

  list(): Array<Pick<SessionRecord, "id" | "title" | "updatedAt">> {
    const out: Array<Pick<SessionRecord, "id" | "title" | "updatedAt">> = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      const record = this.get(name.slice(0, -5));
      if (record) out.push({ id: record.id, title: record.title, updatedAt: record.updatedAt });
    }
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return out;
  }
}
