/**
 * group.ts 纯逻辑测试：npx tsx server/group.test.ts
 * 测 unseenGptLines + GPT 重建上下文的长度保护，不起子进程。
 */
import { buildBoundedGptPrompt, unseenGptLines } from "./group.js";
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

// GPT thread 被删后会从 seen=0 重建；长群聊不能把 Windows 32767 字符命令行撑爆
{
  const messages = Array.from({ length: 40 }, (_, i) =>
    i % 2 ? mai(`麦穗-${i}-` + "长".repeat(1800)) : user(`泽-${i}-` + "话".repeat(1800))
  );
  const bounded = buildBoundedGptPrompt(messages, "群聊开场白", 8000);
  check("长历史 prompt 不超过预算", bounded.prompt.length <= 8000, String(bounded.prompt.length));
  check("长历史会省略较早消息", bounded.omittedCount > 0, String(bounded.omittedCount));
  check("保留最新消息", bounded.prompt.includes("麦穗-39-"));
  check("丢掉最早消息", !bounded.prompt.includes("泽-0-"));
  check("图片/附件取数只对应实际纳入的消息", bounded.includedMessages.at(-1) === messages.at(-1));
}

// 单条极长也必须裁，且保留头尾
{
  const huge = user(`开头-${"中".repeat(6000)}-结尾`);
  const bounded = buildBoundedGptPrompt([huge], "", 3500);
  check("单条超长会裁剪", bounded.prompt.length <= 3500);
  check("单条裁剪保留开头", bounded.prompt.includes("开头"));
  check("单条裁剪保留结尾", bounded.prompt.includes("结尾"));
}

console.log(failed ? `\n${failed} 项没过` : "\n全过");
process.exit(failed ? 1 : 0);
