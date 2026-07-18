import assert from "node:assert/strict";
import { attachmentPayload, isFirstOutputTimedOut, isTurnStalled, waitForExitOrForceClose } from "./lifecycle.js";

const idle = attachmentPayload("s1");
assert.deepEqual(idle, { type: "status", sessionId: "s1", state: "idle" });
console.log("✓ attach 无活跃轮次时明确返回 idle");

const snapshot = attachmentPayload("s2", {
  status: "running_tool",
  toolName: "Read",
  speaker: "gpt",
  partialText: "半截",
  partialThinking: "",
  startedAt: "2026-07-16T00:00:00.000Z",
  lastProgressAt: "2026-07-16T00:00:05.000Z",
});
assert.equal(snapshot.type, "turn_snapshot");
assert.equal(snapshot.sessionId, "s2");
assert.equal(snapshot.status, "running_tool");
assert.equal(snapshot.partialThinking, undefined);
console.log("✓ attach 有活跃轮次时返回完整快照");

assert.equal(isTurnStalled("2026-07-16T00:00:00.000Z", Date.parse("2026-07-16T00:03:00.000Z"), 180_000), true);
assert.equal(isTurnStalled("2026-07-16T00:00:01.000Z", Date.parse("2026-07-16T00:03:00.000Z"), 180_000), false);
console.log("✓ 三分钟无进展判定边界正确");

assert.equal(
  isFirstOutputTimedOut("2026-07-16T00:00:00.000Z", false, Date.parse("2026-07-16T00:00:44.999Z"), 45_000),
  false,
);
assert.equal(
  isFirstOutputTimedOut("2026-07-16T00:00:00.000Z", false, Date.parse("2026-07-16T00:00:45.000Z"), 45_000),
  true,
);
assert.equal(
  isFirstOutputTimedOut("2026-07-16T00:00:00.000Z", true, Date.parse("2026-07-16T00:10:00.000Z"), 45_000),
  false,
);
assert.equal(isFirstOutputTimedOut(undefined, false, Date.now(), 45_000), false);
console.log("✓ 首个输出 45 秒止损边界正确，已有进展或引擎未启动时不误杀");

let normalExit: (() => void) | undefined;
let normalForceCount = 0;
const normal = waitForExitOrForceClose(
  (done) => { normalExit = done; },
  () => { normalForceCount += 1; },
  50,
  10,
);
normalExit?.();
await normal;
assert.equal(normalForceCount, 0);
console.log("✓ 优雅退出时不会误触发强制关闭");

let forcedCount = 0;
await waitForExitOrForceClose(
  () => {},
  () => { forcedCount += 1; },
  10,
  10,
);
assert.equal(forcedCount, 1);
console.log("✓ 优雅退出超时后会强制关闭并保证清理流程返回");

console.log("\n全过");
