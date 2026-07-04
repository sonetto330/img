const KEY = process.env.BARK_KEY || "";

export function barkEnabled(): boolean {
  return KEY.length > 0;
}

/** 给 Bark 推一条通知；没配 key 就静默跳过；失败只打日志不抛 */
export async function barkPush(title: string, body: string): Promise<void> {
  if (!KEY) return;
  const cleaned = body.trim();
  if (!cleaned) return;
  const t = encodeURIComponent(title.slice(0, 40));
  const b = encodeURIComponent(cleaned.slice(0, 60));
  const url = `https://api.day.app/${encodeURIComponent(KEY)}/${t}/${b}`;
  try {
    // Bark 国内直连可达，不走 HTTPS_PROXY（Node 原生 fetch 也不读代理环境变量）
    const res = await fetch(url);
    if (!res.ok) console.error(`[bark] 推送失败 status=${res.status}`);
  } catch (err) {
    console.error(`[bark] 推送失败：${err instanceof Error ? err.message : String(err)}`);
  }
}
