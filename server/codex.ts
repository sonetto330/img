import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { TurnHandle } from "./engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

/** 陪伴用的极简基础指令；缺失时直接报错，绝不静默回落到 Codex 内置的开发型指令 */
const INSTRUCTIONS_FILE = path.join(root, "prompts", "codex_companion_base.md");

/**
 * AionsHome 专用的隔离 CODEX_HOME：不碰泽日常用的 ~/.codex，
 * 只在首次使用时从那边复制一份认证文件过来。
 */
const CODEX_HOME_DIR = path.join(root, "data", "codex-home");
/** 中性工作目录：藏在隔离 HOME 里，防止 Codex 读到仓库的 AGENTS/CLAUDE 文档 */
const CODEX_WORKDIR = path.join(CODEX_HOME_DIR, "workdir");

/** 单轮最长跑多久；聊天轮不该有长活，卡住多半是网络或登录问题 */
const TURN_TIMEOUT_MS = 180_000;

export interface CodexTurnCallbacks {
  /** 拿到会话 thread id（首轮就有，resume 轮也会回报同一个） */
  onThreadId(threadId: string): void;
  /** 一条完整的回复文本（codex exec 的 --json 不给增量，整段到达） */
  onMessage(text: string): void;
  onDone(finalText: string): void;
  onError(message: string): void;
}

/** 找 codex.exe：环境变量优先，否则去桌面端安装目录挑最新的 */
export function findCodexBin(): string | null {
  const fromEnv = (process.env.CODEX_BIN || "").trim();
  if (fromEnv) return fs.existsSync(fromEnv) ? fromEnv : null;
  const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "OpenAI", "Codex", "bin");
  try {
    let best: { file: string; mtime: number } | null = null;
    for (const dir of fs.readdirSync(base)) {
      const exe = path.join(base, dir, "codex.exe");
      try {
        const st = fs.statSync(exe);
        if (!best || st.mtimeMs > best.mtime) best = { file: exe, mtime: st.mtimeMs };
      } catch {
        /* 这个目录没有 codex.exe，比如只放 rg 的 */
      }
    }
    return best?.file || null;
  } catch {
    return null;
  }
}

/** Codex 是否可用（装了 CLI 且日常目录里有登录凭证可借） */
export function codexAvailable(): boolean {
  if (!findCodexBin()) return false;
  return fs.existsSync(path.join(CODEX_HOME_DIR, "auth.json")) ||
    fs.existsSync(path.join(os.homedir(), ".codex", "auth.json"));
}

/**
 * 备好隔离 HOME：目录、工作目录、认证。
 * 认证只在隔离侧没有时才从日常 ~/.codex 复制——隔离侧的 auth.json 会被
 * Codex 自己刷新 token，无脑覆盖会把新 token 冲掉。
 */
function ensureIsolatedHome(): void {
  fs.mkdirSync(CODEX_WORKDIR, { recursive: true });
  const target = path.join(CODEX_HOME_DIR, "auth.json");
  if (fs.existsSync(target)) return;
  const source = path.join(os.homedir(), ".codex", "auth.json");
  if (fs.existsSync(source)) fs.copyFileSync(source, target);
}

/** TOML 基本字符串：JSON 的转义规则是 TOML 基本字符串的子集，直接复用，Windows 反斜杠不用手拼 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * 极简配置覆盖：短陪伴指令替换内置开发指令、关掉 shell/多代理/远程插件/记忆，
 * 去掉 apps/权限/协作/环境等与陪伴聊天无关的注入块。联网搜索显式开
 * （0.144.2 默认关，得给 tools.web_search=true），图片理解不动。
 * 实测（codex-cli 0.144.2）：默认 ~12.2k 输入 token，全套开完 ~7.4k。
 */
function minimalConfig(): string[] {
  const pairs = [
    `model_instructions_file=${tomlString(INSTRUCTIONS_FILE)}`,
    `project_doc_max_bytes=0`,
    `sandbox_mode="read-only"`,
    `tools.web_search=true`,
    `features.shell_tool=false`,
    `features.multi_agent=false`,
    `features.remote_plugin=false`,
    `features.memories=false`,
    `include_apps_instructions=false`,
    `include_permissions_instructions=false`,
    `include_collaboration_mode_instructions=false`,
    `include_environment_context=false`,
  ];
  return pairs.flatMap((p) => ["-c", p]);
}

/**
 * 组装 codex exec 的完整参数。纯函数，方便测试。
 * 首轮走 `exec`（带 -C 中性工作目录）；后续轮走 `exec resume <threadId>`
 * （resume 子命令不认 -C/-s，沙箱用 -c sandbox_mode 统一给）。
 */
export function buildCodexArgs(opts: { prompt: string; threadId?: string; model?: string }): string[] {
  if (!fs.existsSync(INSTRUCTIONS_FILE)) {
    throw new Error(`陪伴基础指令文件缺失：${INSTRUCTIONS_FILE}，拒绝以开发型指令启动 Codex`);
  }
  const shared = [
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    ...minimalConfig(),
    "--json",
  ];
  if (opts.threadId) {
    return ["exec", "resume", opts.threadId, opts.prompt, ...shared];
  }
  const args = ["exec", "-C", CODEX_WORKDIR, ...shared];
  if (opts.model) args.push("-m", opts.model);
  args.push(opts.prompt);
  return args;
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: { type: string; text?: string };
  message?: string;
  error?: { message?: string };
}

/**
 * 跑一轮 Codex：spawn 子进程，逐行吃 --json 事件流，收完整回复。
 * 一轮一进程（codex exec 天然如此），会话连续性靠 thread resume。
 */
export function runCodexTurn(
  opts: { prompt: string; threadId?: string; model?: string },
  cb: CodexTurnCallbacks,
): TurnHandle {
  let child: ChildProcess | null = null;
  let settled = false;
  const texts: string[] = [];
  let stderrTail = "";

  const finish = (err?: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (err) cb.onError(err);
    else cb.onDone(texts.join("\n\n"));
  };

  const timer = setTimeout(() => {
    child?.kill();
    finish(`Codex 这轮超过 ${TURN_TIMEOUT_MS / 1000} 秒没跑完，已掐掉`);
  }, TURN_TIMEOUT_MS);

  try {
    ensureIsolatedHome();
    const bin = findCodexBin();
    if (!bin) throw new Error("找不到 codex.exe（装了桌面端吗？或设 CODEX_BIN 指向可执行文件）");
    const args = buildCodexArgs(opts);
    child = spawn(bin, args, {
      // stdin 必须关掉：codex exec 见到管道会等 stdin 追加内容，不关就挂住
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CODEX_HOME: CODEX_HOME_DIR },
    });
  } catch (err) {
    finish(err instanceof Error ? err.message : String(err));
    return { interrupt: async () => {} };
  }

  let buf = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("{")) continue; // 偶发的纯文本提示行（如 stdin 提示）
      let event: CodexEvent;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "thread.started" && event.thread_id) cb.onThreadId(event.thread_id);
      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
        texts.push(event.item.text);
        cb.onMessage(event.item.text);
      }
      if (event.type === "turn.failed" || event.type === "error") {
        finish(event.error?.message || event.message || "Codex 这轮失败了，没说原因");
      }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-800);
  });
  child.on("error", (err) => finish(`Codex 进程起不来：${err.message}`));
  child.on("close", (code) => {
    if (settled) return;
    if (code === 0 && texts.length) finish();
    else finish(`Codex 退出码 ${code}${stderrTail ? `：${stderrTail.trim().slice(-300)}` : "，什么都没说"}`);
  });

  return {
    interrupt: async () => {
      settled = true; // 主动打断不算错误，安静收掉
      clearTimeout(timer);
      child?.kill();
    },
  };
}
