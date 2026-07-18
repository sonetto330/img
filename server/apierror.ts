/**
 * CLI 拿到 API 报错（限额 402、网关 400 这类）时不走报错通道，而是把
 * "API Error: 4xx {...}" 当正文吐出来——混在真话里存历史、显示成麦穗说的话、
 * 还会污染记忆提取。把这种行从正文里剥出来单独处理。
 * 只认行首的 "API Error: <三位数字>"，以及 CLI 自己产生的 JSON 解析失败；
 * 聊天里普通地聊到这个词组不受影响。
 */
export function splitApiError(finalText: string): { clean: string; apiError?: string } {
  if (!finalText.includes("API Error:")) return { clean: finalText };
  const errs: string[] = [];
  const keep = finalText.split("\n").filter((line) => {
    if (/^\s*API Error:\s+(?:\d{3}\b|Failed to parse JSON\b)/i.test(line)) {
      errs.push(line.trim());
      return false;
    }
    return true;
  });
  if (!errs.length) return { clean: finalText };
  return { clean: keep.join("\n").trim(), apiError: errs.join("\n") };
}

/** API 报错的人话版，给前端的错误气泡用；原文附在后面方便排查 */
export function apiErrorNote(err: string): string {
  const human = /402|usage limit/i.test(err)
    ? "API 通道额度到上限了，等它恢复再聊"
    : "API 通道报错了，再发一次试试";
  return `${human}（${err.slice(0, 200)}）`;
}
