export type AttachedTurnState = "waiting_model" | "running_tool";

export interface AttachedTurnSnapshot {
  status: AttachedTurnState;
  toolName?: string;
  speaker?: "gpt";
  partialText: string;
  partialThinking: string;
  startedAt: string;
  lastProgressAt: string;
}

/** attach 必须总有明确答复；没有活跃轮次也要回 idle，前端才能清掉旧 busy 状态。 */
export function attachmentPayload(sessionId: string, turn?: AttachedTurnSnapshot): Record<string, unknown> {
  if (!turn) return { type: "status", sessionId, state: "idle" };
  return {
    type: "turn_snapshot",
    sessionId,
    speaker: turn.speaker,
    partialText: turn.partialText,
    partialThinking: turn.partialThinking || undefined,
    status: turn.status,
    toolName: turn.toolName,
    startedAt: turn.startedAt,
    lastProgressAt: turn.lastProgressAt,
  };
}

export function isTurnStalled(lastProgressAt: string, nowMs: number, limitMs: number): boolean {
  const last = Date.parse(lastProgressAt);
  return Number.isFinite(last) && nowMs - last >= limitMs;
}

/** 引擎已经启动但连首个思考/文字/工具事件都没有时，用更短止损，别让空白等待拖满整轮超时。 */
export function isFirstOutputTimedOut(
  engineStartedAt: string | undefined,
  hasModelProgress: boolean,
  nowMs: number,
  limitMs: number,
): boolean {
  if (!engineStartedAt || hasModelProgress) return false;
  return isTurnStalled(engineStartedAt, nowMs, limitMs);
}

/**
 * 先等进程优雅退出；超过宽限期就调用 SDK 的强制 close。
 * forceClose 本身若也没让输出泵收口，再等一个很短的 settle 窗口后放行调用方，
 * 避免服务端清理流程永久吊死。
 */
export function waitForExitOrForceClose(
  registerExit: (done: () => void) => void,
  forceClose: () => void,
  graceMs = 8_000,
  forceSettleMs = 1_000,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;
    const done = () => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (settleTimer) clearTimeout(settleTimer);
      resolve();
    };

    registerExit(done);
    if (settled) return;
    graceTimer = setTimeout(() => {
      if (settled) return;
      try {
        forceClose();
      } catch {
        // 强制关闭本身报错也不能让回收流程永久挂住。
      }
      settleTimer = setTimeout(done, Math.max(0, forceSettleMs));
    }, Math.max(0, graceMs));
  });
}
