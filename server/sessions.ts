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
  id?: string;
  role: "user" | "assistant";
  /** 群聊里这条 assistant 消息是谁说的（如 "gpt"）；缺省 = 麦穗 */
  speaker?: string;
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
  /** 所属文件夹名；空/缺省 = 不在任何文件夹。一层结构，不嵌套 */
  folder?: string;
  claudeSessionId?: string;
  /** 群聊模式下 GPT 侧的 codex thread id，用于跨轮 resume */
  codexThreadId?: string;
  /** 群聊：messages 里前多少条已经喂给过 GPT（它自己的 thread 记得，不重喂） */
  codexSeenCount?: number;
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
      // 旧会话第一次读到时给所有消息补齐 id。直接写文件，不借 save，避免迁移把
      // updatedAt 改成现在、让一批旧会话突然顶到列表最上面。
      let addedMessageIds = false;
      for (const message of record.messages) {
        if (message.id) continue;
        message.id = randomUUID();
        addedMessageIds = true;
      }
      if (addedMessageIds) {
        fs.writeFileSync(this.file(record.id), JSON.stringify(record, null, 2));
      }
      // 旧数据可能没 mode，按 chat 处理，别在别处每次判空
      if (!record.mode) record.mode = "chat";
      return record;
    } catch {
      return null;
    }
  }

  save(record: SessionRecord): void {
    // group.ts 也会直接追加 GPT 消息；在存盘边界兜底，保证所有新消息落库就有 id。
    for (const message of record.messages) {
      if (!message.id) message.id = randomUUID();
    }
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

  deleteMessage(id: string, messageId: string): { index: number } | null {
    const record = this.get(id);
    if (!record) return null;
    const index = record.messages.findIndex((message) => message.id === messageId);
    if (index < 0) return null;
    record.messages.splice(index, 1);
    delete record.claudeSessionId;
    delete record.codexThreadId;
    record.codexSeenCount = 0;
    this.save(record);
    return { index };
  }

  /** 挪进/挪出文件夹：folder 传空串就是移出。整理动作不该把会话顶到列表最上面，所以不动 updatedAt */
  setFolder(id: string, folder: string): SessionRecord | null {
    const record = this.get(id);
    if (!record) return null;
    const clean = folder.trim().slice(0, 30);
    if (clean) record.folder = clean;
    else delete record.folder;
    fs.writeFileSync(this.file(record.id), JSON.stringify(record, null, 2));
    return record;
  }

  list(): Array<Pick<SessionRecord, "id" | "title" | "mode" | "updatedAt" | "folder"> & { messageCount: number; toolMessageCount: number }> {
    const out: Array<Pick<SessionRecord, "id" | "title" | "mode" | "updatedAt" | "folder"> & { messageCount: number; toolMessageCount: number }> = [];
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
        folder: record.folder,
        updatedAt: record.updatedAt,
        messageCount: record.messages.length,
        toolMessageCount,
      });
    }
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return out;
  }
}
