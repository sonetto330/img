/**
 * group.ts 纯逻辑测试：npx tsx server/group.test.ts
 * 只测 unseenGptLines（麦穗下轮 prompt 前置 GPT 发言的取数逻辑），不起子进程。
 */
import { unseenGptLines } from "./group.js";
import type { SessionRecord, StoredMessage } from "./sessions.js";

let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? ` —— ${detail}` : ""}`);
  if (!ok) failed++;
}

function rec(messages: StoredMessage[]): SessionRecord {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    title: "测试",
    mode: "group",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    messages,
  };
}
const at = "2026-07-15T00:00:00.000Z";
const user = (text: string): StoredMessage => ({ role: "user", text, at });
const mai = (text: string): StoredMessage => ({ role: "assistant", text, at });
const gpt = (text: string): StoredMessage => ({ role: "assistant", speaker: "gpt", text, at });

// 常规轮：…麦穗、GPT、泽新消息 → 取到那条 GPT
{
  const r = rec([user("哈喽"), mai("来了"), gpt("我也来了"), user("你俩聊")]);
  check("队尾前一条是 GPT 时取到", unseenGptLines(r) === "[GPT 说：我也来了]");
}

// GPT 上轮沉默：…麦穗、泽新消息 → 空
{
  const r = rec([user("哈喽"), mai("来了"), user("继续")]);
  check("没有 GPT 发言时为空", unseenGptLines(r) === "");
}

// 只往回收连续的 GPT 段：更早的 GPT 消息（麦穗已经见过）不重复带
{
  const r = rec([user("a"), mai("b"), gpt("旧的"), user("c"), mai("d"), user("e")]);
  check("隔了轮次的旧 GPT 消息不带", unseenGptLines(r) === "");
}

// 连续多条 GPT（理论上串行编排下不出现，但取数要按时间顺序稳）
{
  const r = rec([user("a"), mai("b"), gpt("一"), gpt("二"), user("c")]);
  check("连续多条按顺序全带", unseenGptLines(r) === "[GPT 说：一]\n[GPT 说：二]");
}

// 空会话/首条消息
{
  check("首条消息时为空", unseenGptLines(rec([user("第一句")])) === "");
  check("空会话为空", unseenGptLines(rec([])) === "");
}

console.log(failed ? `\n${failed} 项没过` : "\n全过");
process.exit(failed ? 1 : 0);
