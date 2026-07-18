// Supervisor 一期：drain 租约状态机 + restartReady 判定（supervisor-design.md v2.3）。
// 语义要点：restartReady 只在"锁着门（draining 且租约有效）且完全空闲"时为 true——
// 普通空闲永远 false，防 Supervisor 在没锁门的空闲瞬间按旧请求动刀。
// 租约到期走惰性清除：任何读取先剔除过期锁，不用定时器；Supervisor 死了无人续租，
// 下一次读取（拒轮检查/健康端点）自然解锁，最迟一个租约周期。

export interface DrainState {
  requestId: string;
  /** epoch 毫秒 */
  expiresAt: number;
}

export const DRAIN_LEASE_MIN_SECONDS = 5;
export const DRAIN_LEASE_MAX_SECONDS = 300;
export const DRAIN_LEASE_DEFAULT_SECONDS = 60;

let drain: DrainState | null = null;

/** 读当前锁；过期即清（惰性解锁）。 */
export function currentDrain(now: number): DrainState | null {
  if (drain && drain.expiresAt <= now) drain = null;
  return drain;
}

export function isDraining(now: number): boolean {
  return currentDrain(now) !== null;
}

/** 拿锁或续租：同 requestId 续约刷新到期时间；他人持有效锁则拒绝。 */
export function acquireOrRenewDrain(
  requestId: string,
  leaseSeconds: number | undefined,
  now: number,
): { ok: true; state: DrainState } | { ok: false; heldBy: string } {
  const held = currentDrain(now);
  if (held && held.requestId !== requestId) return { ok: false, heldBy: held.requestId };
  const seconds = typeof leaseSeconds === "number" && Number.isFinite(leaseSeconds) && leaseSeconds > 0
    ? Math.min(Math.max(leaseSeconds, DRAIN_LEASE_MIN_SECONDS), DRAIN_LEASE_MAX_SECONDS)
    : DRAIN_LEASE_DEFAULT_SECONDS;
  drain = { requestId, expiresAt: now + seconds * 1000 };
  return { ok: true, state: drain };
}

/** 显式还锁（Supervisor 弃刀时用）；只有持锁单号能还。 */
export function releaseDrain(requestId: string, now: number): boolean {
  const held = currentDrain(now);
  if (!held || held.requestId !== requestId) return false;
  drain = null;
  return true;
}

/** 测试专用：清空状态。 */
export function resetDrainForTest(): void {
  drain = null;
}

/** restartReady：锁着门且完全空闲，四个条件缺一不可。 */
export function computeRestartReady(input: {
  draining: boolean;
  activeTurns: number;
  pendingWrites: number;
  wsBufferedBytes: number;
}): boolean {
  return input.draining && input.activeTurns === 0 && input.pendingWrites === 0 && input.wsBufferedBytes === 0;
}
