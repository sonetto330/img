import assert from "node:assert/strict";
import {
  acquireOrRenewDrain,
  computeRestartReady,
  currentDrain,
  isDraining,
  releaseDrain,
  resetDrainForTest,
} from "./supervisor-state.js";

const t0 = Date.parse("2026-07-17T10:00:00.000Z");

resetDrainForTest();
const first = acquireOrRenewDrain("req-a", 60, t0);
assert.equal(first.ok, true);
assert.equal(currentDrain(t0)?.requestId, "req-a");
const renewed = acquireOrRenewDrain("req-a", 60, t0 + 20_000);
assert.ok(renewed.ok && renewed.state.expiresAt === t0 + 20_000 + 60_000);
console.log("✓ 拿锁与续租：同单号续约刷新到期时间");

const denied = acquireOrRenewDrain("req-b", 60, t0 + 30_000);
assert.ok(!denied.ok && denied.heldBy === "req-a");
console.log("✓ 他人持有效锁时拿锁被拒并回报持有者");

assert.equal(isDraining(t0 + 20_000 + 60_000), false);
const afterExpiry = acquireOrRenewDrain("req-b", 60, t0 + 20_000 + 60_000);
assert.equal(afterExpiry.ok, true);
console.log("✓ 租约到期无人续租即自动解锁，新单号可拿锁");

resetDrainForTest();
acquireOrRenewDrain("req-c", 60, t0);
assert.equal(releaseDrain("req-x", t0 + 1_000), false);
assert.equal(releaseDrain("req-c", t0 + 1_000), true);
assert.equal(isDraining(t0 + 1_000), false);
console.log("✓ 还锁只认持锁单号");

resetDrainForTest();
const clamped = acquireOrRenewDrain("req-d", 99_999, t0);
assert.ok(clamped.ok && clamped.state.expiresAt === t0 + 300_000);
resetDrainForTest();
const defaulted = acquireOrRenewDrain("req-e", undefined, t0);
assert.ok(defaulted.ok && defaulted.state.expiresAt === t0 + 60_000);
console.log("✓ 租约时长收敛在 5~300 秒，缺省 60");

assert.equal(computeRestartReady({ draining: false, activeTurns: 0, pendingWrites: 0, wsBufferedBytes: 0 }), false);
assert.equal(computeRestartReady({ draining: true, activeTurns: 1, pendingWrites: 0, wsBufferedBytes: 0 }), false);
assert.equal(computeRestartReady({ draining: true, activeTurns: 0, pendingWrites: 1, wsBufferedBytes: 0 }), false);
assert.equal(computeRestartReady({ draining: true, activeTurns: 0, pendingWrites: 0, wsBufferedBytes: 8 }), false);
assert.equal(computeRestartReady({ draining: true, activeTurns: 0, pendingWrites: 0, wsBufferedBytes: 0 }), true);
console.log("✓ restartReady：普通空闲恒 false，锁门且空闲才 true");

console.log("supervisor-state.test 全部通过");
