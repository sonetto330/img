// 端到端验证阅后即焚：npx tsx server/e2e-burn.test.ts
// 发图 → 麦穗 Read → 第二条消息触发焚化 → 验证 jsonl 已焚且 resume 正常
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const TOKEN = process.env.ACCESS_TOKEN || "";
const IMG = "1783774273271-06a6aeb0.png"; // 今天已在 uploads 里的截图
const PROJ = path.join(os.homedir(), ".claude", "projects", "C--Users-Lenovo-home-workspace");

function turn(payload: object): Promise<{ sessionId?: string; text: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:3000/ws?token=${TOKEN}`);
    let sessionId: string | undefined;
    const timer = setTimeout(() => { ws.close(); reject(new Error("120s 超时")); }, 120_000);
    ws.on("open", () => ws.send(JSON.stringify(payload)));
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "session") sessionId = m.sessionId;
      if (m.type === "done") { clearTimeout(timer); ws.close(); resolve({ sessionId, text: m.text }); }
      if (m.type === "error") { clearTimeout(timer); ws.close(); reject(new Error(m.message)); }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

function claudeSessionId(sessionId: string): string {
  const rec = JSON.parse(fs.readFileSync(path.join("data", "sessions", `${sessionId}.json`), "utf8"));
  return rec.claudeSessionId;
}

function imageStats(claudeId: string): { count: number; maxLen: number } {
  const f = path.join(PROJ, `${claudeId}.jsonl`);
  let count = 0, maxLen = 0;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line.includes('"image"')) continue;
    try {
      const o = JSON.parse(line);
      const walk = (c: unknown): void => {
        if (!Array.isArray(c)) return;
        for (const b of c as any[]) {
          if (b?.type === "image" && b.source?.data) { count++; maxLen = Math.max(maxLen, b.source.data.length); }
          if (b?.content) walk(b.content);
        }
      };
      walk(o.message?.content);
      if (o.toolUseResult?.file?.base64) maxLen = Math.max(maxLen, o.toolUseResult.file.base64.length);
    } catch { /* 跳过 */ }
  }
  return { count, maxLen };
}

const r1 = await turn({
  type: "chat",
  model: "haiku",
  text: "（自动化测试，一句话回答就好）看一下这张图，图里的报错代码是多少？",
  attachments: [{ file: IMG, name: "测试图.png", kind: "image" }],
});
console.log("第一轮回复:", r1.text.slice(0, 80));
const cs1 = claudeSessionId(r1.sessionId!);
const s1 = imageStats(cs1);
console.log(`第一轮后 jsonl(${cs1.slice(0, 8)}): image块=${s1.count} 最大base64=${s1.maxLen}`);
if (s1.maxLen < 10_000) throw new Error("第一轮就没有大图？测试前提不成立");

const r2 = await turn({
  type: "chat",
  sessionId: r1.sessionId,
  model: "haiku",
  text: "（自动化测试，一句话回答就好）不看图，凭刚才的记忆：那张图是关于什么的？",
});
console.log("第二轮回复:", r2.text.slice(0, 80));
const cs2 = claudeSessionId(r2.sessionId!);
const s2 = imageStats(cs2);
console.log(`第二轮后 jsonl(${cs2.slice(0, 8)}): image块=${s2.count} 最大base64=${s2.maxLen}`);

const ok = s2.maxLen > 0 && s2.maxLen < 200 && r2.text.trim().length > 0;
console.log(ok ? "✓ 端到端通过：图已焚、resume 正常" : "✗ 有问题");
process.exit(ok ? 0 : 1);
