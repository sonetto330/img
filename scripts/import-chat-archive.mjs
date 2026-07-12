// 一次性工具：把 Claude chat 端导出的 conversations.json 灌进 data/archive/sessions，
// 供翻历史工具搜索。只留 谁/说了什么/什么时候，工具调用、附件、思考块都不搬。
// 用法：node scripts/import-chat-archive.mjs <conversations.json 路径>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = process.argv[2];
if (!src) {
  console.error("用法：node scripts/import-chat-archive.mjs <conversations.json 路径>");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "data", "archive", "sessions");
fs.mkdirSync(outDir, { recursive: true });

const data = JSON.parse(fs.readFileSync(src, "utf8"));
let convs = 0, msgs = 0, skippedConvs = 0, bytes = 0;

for (const c of data) {
  const messages = (c.chat_messages ?? [])
    .filter((m) => typeof m.text === "string" && m.text.trim())
    .map((m) => ({
      role: m.sender === "human" ? "user" : "assistant",
      text: m.text,
      at: m.created_at,
    }));
  if (!messages.length) { skippedConvs++; continue; }

  const record = {
    id: c.uuid,
    title: `chat端·${(c.name || "").trim() || (c.created_at || "").slice(0, 10) || "无标题"}`,
    mode: "archive",
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    messages,
  };
  const json = JSON.stringify(record);
  fs.writeFileSync(path.join(outDir, `${c.uuid}.json`), json);
  convs++;
  msgs += messages.length;
  bytes += json.length;
}

console.log(`导入 ${convs} 个会话、${msgs} 条消息，共 ${(bytes / 1024 / 1024).toFixed(1)}MB`);
if (skippedConvs) console.log(`跳过 ${skippedConvs} 个空会话`);
console.log(`落盘目录：${outDir}`);
