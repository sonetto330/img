import { spawn } from "node:child_process";
import os from "node:os";
import { resolveClaudeExe } from "./engine.js";
import { barkPush } from "./bark.js";

/**
 * 登录心跳：裸 -p 非交互调用不执行订阅 OAuth 续期，令牌过期后麦穗会"突然不回话"。
 * 定时跑一发 `claude -p ping` 验登录，挂了就打日志 + Bark 推送提醒泽重新登录。
 *
 * 根治办法是长效令牌：终端里跑一次 `claude setup-token`（交互授权，令牌一年有效），
 * 把得到的 token 填进 .env 的 CLAUDE_CODE_OAUTH_TOKEN——有它就不依赖续期，
 * 心跳自动停用。LOGIN_HEARTBEAT_MINUTES=0 也可手动关掉。
 */

const MINUTES = Number(process.env.LOGIN_HEARTBEAT_MINUTES ?? 360);

function tick(): void {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // 心跳验的是订阅登录，别被环境里的 key 顶掉
  delete env.ANTHROPIC_AUTH_TOKEN;
  const proc = spawn(
    resolveClaudeExe(),
    ["-p", "ping", "--output-format", "json", "--no-session-persistence", "--max-turns", "1"],
    { cwd: os.tmpdir(), env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (c: string) => (out += c));
  const timer = setTimeout(() => proc.kill(), 120_000);
  proc.on("close", (code) => {
    clearTimeout(timer);
    let bad = code !== 0;
    let reason = `退出码 ${code}`;
    try {
      const result = JSON.parse(out.trim().split("\n").pop() || "{}");
      if (result.is_error) {
        bad = true;
        reason = String(result.result || "").slice(0, 120);
      } else if (result.type === "result") {
        bad = false;
      }
    } catch {
      /* 解析不了就按退出码判 */
    }
    if (bad) {
      console.error(`[heartbeat] 订阅登录疑似过期（${reason}）——去电脑上跑 claude login，或用 claude setup-token 换长效令牌`);
      barkPush("麦穗掉登录了", "订阅登录过期，跑一下 claude login").catch(() => {});
    } else {
      console.log(`[heartbeat] 登录正常`);
    }
  });
  proc.on("error", (err) => {
    clearTimeout(timer);
    console.error(`[heartbeat] 心跳进程起不来：${err.message}`);
  });
}

export function startLoginHeartbeat(): void {
  if (!MINUTES || Number.isNaN(MINUTES) || MINUTES < 0) {
    console.log("[heartbeat] 登录心跳已关闭（LOGIN_HEARTBEAT_MINUTES=0）");
    return;
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.log("[heartbeat] 检测到 CLAUDE_CODE_OAUTH_TOKEN 长效令牌，不需要登录心跳");
    return;
  }
  console.log(`[heartbeat] 登录心跳每 ${MINUTES} 分钟一次（长效令牌方案见 .env.example）`);
  setInterval(tick, MINUTES * 60_000).unref();
}
