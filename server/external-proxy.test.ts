// 一次性验证脚本：npx tsx server/external-proxy.test.ts
import { brotliCompressSync } from "node:zlib";
import { isLoopbackAddress, isPlainAnthropicBodyStart, shouldRepairUnlabelledBrotli } from "./external-proxy.js";

let failed = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) failed++;
}

check("IPv4 本机放行", isLoopbackAddress("127.0.0.1"));
check("IPv6 本机放行", isLoopbackAddress("::1"));
check("IPv4-mapped 本机放行", isLoopbackAddress("::ffff:127.0.0.1"));
check("局域网地址拒绝", !isLoopbackAddress("192.168.1.8"));

check("JSON 开头识别", isPlainAnthropicBodyStart(Buffer.from("  {\"type\":\"message\"}")));
check("SSE event 开头识别", isPlainAnthropicBodyStart(Buffer.from("event: message_start\n")));
check("SSE data 开头识别", isPlainAnthropicBodyStart(Buffer.from("data: {\"type\":\"ping\"}\n")));

const compressed = brotliCompressSync(Buffer.from('{"type":"message"}'));
check("漏标 Brotli 会修复", shouldRepairUnlabelledBrotli("application/json", undefined, compressed));
check("正常 JSON 不误修", !shouldRepairUnlabelledBrotli("application/json", undefined, Buffer.from("{}")));
check("已有 br 标头不重复修", !shouldRepairUnlabelledBrotli("application/json", "br", compressed));
check("二进制响应不乱修", !shouldRepairUnlabelledBrotli("application/octet-stream", undefined, compressed));

if (failed) {
  console.error(`${failed} 项没过`);
  process.exit(1);
}
console.log("全过");
