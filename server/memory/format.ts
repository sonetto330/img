import type { RetrievedFragment } from "./librarian.js";

/**
 * 把检索到的碎片格式化成系统提示的记忆块。
 * 全模式生效——不管当前是聊天/跑团/旅行，麦穗都要记得泽真实生活里的事。
 * 但块头明确告诉他：跑团/旅行是虚拟的线上游戏，戏内事件跟这些真实碎片是两回事。
 */
export function formatMemoryBlock(memories: RetrievedFragment[], mode: string): string {
  if (!memories.length) return "";
  const modeContext = describeMode(mode);
  const header = `【麦穗的记忆·真实生活】
下面这些是你从平日跟泽的聊天里悄悄记下的、关于**她真实生活**的事实碎片。
当前对话模式：${modeContext}

规则：
- 不管你现在扮演什么角色（就是你麦穗自己 / 跑团的 KP / 旅行的导游），这些碎片都是关于泽本人的、真实生活里的事
- **跑团、虚拟旅行是你们的线上游戏**，戏内发生的事情（骰点、去过的城市 NPC 对话等）不要跟这些真实碎片混——两条线，一条真一条假
- 每条前面【】里的是使用权限：
  · 【可引用】：可以像刚聊过一样自然说出来
  · 【需谨慎】：要用"我记得好像""上次是不是"这种模糊语气
  · 【仅联想】：内心参考、影响你的态度和判断，但不能作为事实主动说出来（除非她自己先提）
- 拿不准就以泽当下说的话为准；她纠正你就接受，别为记忆辩护`;

  const lines = memories.map((m) => {
    const age = friendlyAge(m.ageDays);
    const entity = m.entity ? ` [${m.entity}]` : "";
    return `- 【${m.permission}】${entity} ${age}：${m.text}`;
  });

  return `${header}\n\n${lines.join("\n")}`;
}

function describeMode(mode: string): string {
  if (mode === "trpg") return "跑团（你们的虚拟线上游戏，你是 KP）";
  if (mode === "travel") return "虚拟旅行（你们的线上游戏，你是导游）";
  return "日常聊天";
}

/** 把天数转成自然中文，避免"56 天前"这种笨拙表述 */
function friendlyAge(days: number): string {
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days <= 7) return `${days} 天前`;
  if (days <= 30) return `${days} 天前`;
  if (days <= 60) return "一个多月前";
  if (days <= 120) return "两三个月前";
  if (days <= 240) return "半年多前";
  if (days <= 400) return "去年";
  return "很久以前";
}
