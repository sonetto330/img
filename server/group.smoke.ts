/**
 * 群聊 GPT 轮整链路冒烟（真的会花一轮 GPT 订阅额度）：
 *   npx tsx server/group.smoke.ts
 * 走 maybeRunGptTurn 完整路径：开场白 + 首轮 → resume 第二轮 → 验证沉默协议。
 * 用内存假 store，不碰 data/sessions。
 */
import { maybeRunGptTurn } from "./group.js";
import type { SessionRecord, SessionStore, StoredMessage } from "./sessions.js";

const at = () => new Date().toISOString();
const record: SessionRecord = {
  id: "00000000-0000-0000-0000-00000000dead",
  title: "冒烟",
  mode: "group",
  createdAt: at(),
  updatedAt: at(),
  messages: [],
};
const fakeStore = { save() {} } as unknown as SessionStore;

function runRound(label: string, newMessages: StoredMessage[]): Promise<{ done?: string; error?: string; events: string[] }> {
  record.messages.push(...newMessages);
  const events: string[] = [];
  return new Promise((resolve) => {
    const started = maybeRunGptTurn({
      record,
      store: fakeStore,
      send: (payload) => {
        const p = payload as { type: string; text?: string; message?: string };
        events.push(p.type);
        if (p.type === "done") resolve({ done: p.text ?? "", events });
        if (p.type === "error") resolve({ error: p.message, events });
      },
      notifyIfAway: () => {},
      setActive: () => {},
    });
    if (!started) resolve({ error: `${label}：这轮压根没起来（maybeRunGptTurn 返回 false）`, events });
  });
}

const r1 = await runRound("首轮", [
  { role: "user", text: "群建好了！这是冒烟测试。GPT 你复述一遍群里有哪三个成员，然后记住暗号「橘子」。", at: at() },
  { role: "assistant", text: "我是麦穗，冒烟测试第一轮，看你的了。", at: at() },
]);
console.log(`[首轮] events=${r1.events.join(",")}`);
console.log(`[首轮] ${r1.error ? "出错：" + r1.error : "GPT 说：" + r1.done}`);
console.log(`[首轮] threadId=${record.codexThreadId || "（没拿到！）"} seen=${record.codexSeenCount}/${record.messages.length}`);
if (r1.error || !record.codexThreadId) process.exit(1);

const r2 = await runRound("次轮", [
  { role: "user", text: "暗号是什么？只说暗号两个字。", at: at() },
  { role: "assistant", text: "我知道，看 GPT 记不记得。", at: at() },
]);
console.log(`[次轮] ${r2.error ? "出错：" + r2.error : "GPT 说：" + r2.done}`);
const remembered = (r2.done || "").includes("橘子");
console.log(`[次轮] 跨轮记忆（橘子）：${remembered ? "✓ 记得" : "✗ 忘了"}`);

const r3 = await runRound("沉默轮", [
  { role: "user", text: "麦穗，这句是单独跟你说的，跟 GPT 无关，它按约定该沉默。", at: at() },
  { role: "assistant", text: "好，收到。", at: at() },
]);
const silent = !r3.error && r3.done === "";
console.log(`[沉默轮] ${r3.error ? "出错：" + r3.error : silent ? "✓ GPT 沉默了（done 空文本）" : "✗ GPT 没沉默，说了：" + r3.done}`);
console.log(`[沉默轮] 存档条数=${record.messages.length}（沉默不该多出消息）`);

const ok = !r1.error && remembered && !r3.error;
console.log(ok ? "\n整链路通了" : "\n有环节不对，往上看");
process.exit(ok ? 0 : 1);
