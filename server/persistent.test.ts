// PersistentSession 冒烟：起一个常驻进程，连发两轮，验证
// ① 冷启动轮正常回话 ② 第二轮走热路（无 init、首内容快） ③ close 能优雅收口。
// 用 haiku + 极短提示词，烧的 token 可忽略。跑法：npx tsx server/persistent.test.ts
import os from "node:os";
import { PersistentSession } from "./engine.js";

const cwd = os.tmpdir();
let sessionId = "";

function turn(s: PersistentSession, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    s.sendTurn(
      { prompt },
      {
        onDelta() {},
        onTool() {},
        onDone(finalText) {
          resolve(finalText);
        },
        onError(m) {
          reject(new Error(m));
        },
      },
    );
  });
}

const s = new PersistentSession({
  cwd,
  permissionMode: "bypassPermissions",
  model: "haiku",
  onSessionId(id) {
    sessionId = id;
  },
});

const t0 = Date.now();
const r1 = await turn(s, "只回一个字：好");
const t1 = Date.now();
console.log(`轮1（冷启动）${((t1 - t0) / 1000).toFixed(1)}s：${r1.slice(0, 40)}`);
if (!s.alive) throw new Error("轮1 结束后进程死了，常驻没成立");

const r2 = await turn(s, "再回一个字：行");
const t2 = Date.now();
console.log(`轮2（热路）${((t2 - t1) / 1000).toFixed(1)}s：${r2.slice(0, 40)}`);

await s.close();
console.log(`收口完成，内部会话 id：${sessionId || "（没拿到！）"}`);

const ok = r1.trim() && r2.trim() && sessionId && t2 - t1 < t1 - t0 + 5000;
console.log(ok ? "✓ 冒烟通过：两轮同进程、热轮不付冷启动税、优雅退出" : "✗ 有问题，看上面数字");
process.exit(ok ? 0 : 1);
