/**
 * codex.ts 参数组装测试：npx tsx server/codex.test.ts
 * 只测纯函数部分（buildCodexArgs），不真起子进程。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodexArgs } from "./codex.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const INSTRUCTIONS_FILE = path.join(here, "..", "prompts", "codex_companion_base.md");

let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? ` —— ${detail}` : ""}`);
  if (!ok) failed++;
}

/** 从 args 里捞出所有 -c 配置对 */
function configPairs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === "-c") out.push(args[i + 1]);
  return out;
}

// ---- 首轮参数 ----
{
  const args = buildCodexArgs({ prompt: "你好", model: "gpt-5" });
  check("首轮以 exec 开头", args[0] === "exec" && args[1] !== "resume");

  const ci = args.indexOf("-C");
  check("首轮带 -C 中性工作目录", ci > 0 && /codex-home[\\/]workdir$/.test(args[ci + 1] ?? ""),
    `-C 后面是 ${args[ci + 1]}`);

  check("带 --json", args.includes("--json"));
  check("带 --ignore-user-config（不吃日常配置）", args.includes("--ignore-user-config"));
  check("带 --ignore-rules", args.includes("--ignore-rules"));
  check("带 --skip-git-repo-check", args.includes("--skip-git-repo-check"));

  const pairs = configPairs(args);
  const wanted = [
    "project_doc_max_bytes=0",
    'sandbox_mode="read-only"',
    "features.shell_tool=false",
    "features.multi_agent=false",
    "features.remote_plugin=false",
    "features.memories=false",
    "include_apps_instructions=false",
    "include_permissions_instructions=false",
    "include_collaboration_mode_instructions=false",
    "include_environment_context=false",
  ];
  for (const w of wanted) check(`极简配置：${w}`, pairs.includes(w));

  const instr = pairs.find((p) => p.startsWith("model_instructions_file="));
  check("极简配置：指令文件已指定", !!instr);
  if (instr) {
    const raw = instr.slice("model_instructions_file=".length);
    let parsed = "";
    try { parsed = JSON.parse(raw); } catch { /* 留空让下面报错 */ }
    check("TOML 转义：值可解析回原路径（Windows 反斜杠安全）", parsed === INSTRUCTIONS_FILE,
      `解析出 ${parsed}`);
    check("TOML 转义：字符串内无裸反斜杠", !/(^|[^\\])\\(?![\\"])/.test(raw.slice(1, -1)));
  }

  const mi = args.indexOf("-m");
  check("指定模型时带 -m", mi > 0 && args[mi + 1] === "gpt-5");
  check("prompt 在末尾", args[args.length - 1] === "你好");
}

// ---- 不指定模型 ----
{
  const args = buildCodexArgs({ prompt: "hi" });
  check("不指定模型时无 -m", !args.includes("-m"));
}

// ---- resume 轮 ----
{
  const tid = "019f646e-ae0d-73a0-817b-8e4151c0395e";
  const args = buildCodexArgs({ prompt: "接着聊", threadId: tid, model: "gpt-5" });
  check("resume：exec resume <tid> <prompt> 顺序正确",
    args[0] === "exec" && args[1] === "resume" && args[2] === tid && args[3] === "接着聊");
  check("resume：不带 -C（resume 子命令不认）", !args.includes("-C"));
  check("resume：不带 -m（模型跟随原会话）", !args.includes("-m"));
  check("resume：极简配置照样全给", configPairs(args).includes("project_doc_max_bytes=0"));
  check("resume：沙箱用配置键给", configPairs(args).includes('sandbox_mode="read-only"'));
}

// ---- 指令文件缺失时明确报错，不静默回退 ----
{
  const bak = INSTRUCTIONS_FILE + ".bak-test";
  fs.renameSync(INSTRUCTIONS_FILE, bak);
  let threw = false;
  let msg = "";
  try {
    buildCodexArgs({ prompt: "x" });
  } catch (e) {
    threw = true;
    msg = e instanceof Error ? e.message : String(e);
  } finally {
    fs.renameSync(bak, INSTRUCTIONS_FILE);
  }
  check("指令文件缺失时 throw", threw);
  check("报错信息说清了缺哪个文件", msg.includes("codex_companion_base.md"));
}

console.log(failed ? `\n${failed} 项没过` : "\n全过");
process.exit(failed ? 1 : 0);
