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
  /** 这条回复前的思考过程；没开思考就没有 */
  thinking?: { text: string; ms: number };
  attachments?: Attachment[];
  at: string;
}

export interface SessionRecord {
  id: string;
  title: string;
  /** 会话所属模式；旧数据无此字段按 chat 处理，会话建成后不改 */
  mode: string;
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

  create(mode: string = "chat"): SessionRecord {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: randomUUID(),
      title: "新会话",
      mode,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.save(record);
    return record;
  }

  get(id: string): SessionRecord | null {
    try {
      const record = JSON.parse(fs.readFileSync(this.file(id), "utf8")) as SessionRecord;
      // 旧数据可能没 mode，按 chat 处理，别在别处每次判空
      if (!record.mode) record.mode = "chat";
      return record;
    } catch {
      return null;
    }
  }

  save(record: SessionRecord): void {
    record.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.file(record.id), JSON.stringify(record, null, 2));
  }

  delete(id: string): boolean {
    try {
      fs.unlinkSync(this.file(id));
      return true;
    } catch {
      return false;
    }
  }

  rename(id: string, title: string): SessionRecord | null {
    const record = this.get(id);
    if (!record) return null;
    record.title = title.slice(0, 60) || record.title;
    this.save(record);
    return record;
  }

  list(): Array<Pick<SessionRecord, "id" | "title" | "mode" | "updatedAt"> & { messageCount: number; toolMessageCount: number }> {
    const out: Array<Pick<SessionRecord, "id" | "title" | "mode" | "updatedAt"> & { messageCount: number; toolMessageCount: number }> = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      const record = this.get(name.slice(0, -5));
      if (!record) continue;
      // 技术会话判定用：assistant 消息里有 tools 的条数
      let toolMessageCount = 0;
      for (const m of record.messages) {
        if (m.role === "assistant" && Array.isArray(m.tools) && m.tools.length > 0) toolMessageCount++;
      }
      out.push({
        id: record.id,
        title: record.title,
        mode: record.mode,
        updatedAt: record.updatedAt,
        messageCount: record.messages.length,
        toolMessageCount,
      });
    }
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return out;
  }
}
