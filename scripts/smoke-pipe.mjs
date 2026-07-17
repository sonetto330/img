// 裸 -p 管道升级冒烟：claude 升级后先跑这个，全绿再继续用（教程 §12 纪律）。
// 验四件事：① 登录/订阅通道正常 ② stream-json 事件能解析 ③ 隐藏 flag
// --thinking-display 还活着（thinking_delta 非空） ④ --max-turns 等 flag 没被砍。
// 跑法：node scripts/smoke-pipe.mjs   （约烧一次极短对话的订阅额度）
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function resolveClaudeExe() {
  if (process.env.CLAUDE_CLI_PATH) return process.env.CLAUDE_CLI_PATH;
  const candidates = [
    path.join(process.env.APPDATA || "", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    path.join(os.homedir(), ".local", "bin", "claude.exe"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return "claude";
}
const EXE = resolveClaudeExe();

function run(args, { stdinLine, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const proc = spawn(EXE, args, { cwd: os.tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (c) => (out += c));
    proc.stderr.on("data", (c) => (err += c));
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(e.message) });
    });
    if (stdinLine) proc.stdin.write(stdinLine + "\n");
    proc.stdin.end();
  });
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `：${detail}` : ""}`);
}

console.log(`claude: ${EXE}`);
const ver = await run(["--version"], { timeoutMs: 30_000 });
console.log(`版本: ${ver.out.trim() || ver.err.trim()}`);

// ① 假 flag 要被拒——证明参数解析还在正常工作（对照实验的基准）
const fake = await run(["-p", "hi", "--totally-fake-flag-xyz"], { timeoutMs: 30_000 });
check("假 flag 被拒（unknown option）", fake.code !== 0 && /unknown option/i.test(fake.err));

// ② 真跑一轮：stream-json + thinking_delta
const smoke = await run([
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--thinking-display", "summarized",
  "--max-turns", "1",
  "--no-session-persistence",
], { stdinLine: JSON.stringify({ type: "user", message: { role: "user", content: "数到三" } }) });

let events = 0, thinkingChars = 0, resultOk = false, resultErrText = "";
for (const line of smoke.out.split("\n")) {
  if (!line.trim()) continue;
  let ev;
  try { ev = JSON.parse(line); } catch { continue; }
  events++;
  if (ev.type === "stream_event" && ev.event?.delta?.type === "thinking_delta") {
    thinkingChars += (ev.event.delta.thinking || "").length;
  }
  if (ev.type === "result") {
    resultOk = ev.subtype === "success" && !ev.is_error;
    resultErrText = String(ev.result || "").slice(0, 120);
  }
}
check("stream-json 事件能解析", events > 3, `${events} 个事件`);
check("登录/订阅通道正常（result success）", resultOk, resultOk ? "" : resultErrText || smoke.err.slice(0, 200));
check("--thinking-display 隐藏 flag 仍有效（thinking 非空）", thinkingChars > 0, `${thinkingChars} 字`);
check("--max-turns flag 未被砍", smoke.code === 0 || !/unknown option.*max-turns/i.test(smoke.err));

const allOk = results.every((r) => r.ok);
console.log(allOk ? "\n全绿，管道可用。" : "\n有红项——别升级/别重启服务，先排查（对照 docs 和引擎注释）。");
process.exit(allOk ? 0 : 1);
