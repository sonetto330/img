import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const WORKSPACE = path.resolve(process.env.WORKSPACE_DIR || path.join(root, "workspace"));

/**
 * 读取人设：CLAUDE.md 主人设 + data/profile-ze.md（泽的长期资料）
 * + data/profile-maisui.md（麦穗补充资料，一般为空因为 CLAUDE.md 里已有）。
 * 每次都重新读，改了不用重启服务。
 * profile 文件在 data/ 目录，已 gitignore，不会被提交。
 */
export function loadPersona(): string | undefined {
  const parts: string[] = [];

  // 主人设 CLAUDE.md：优先 WORKSPACE/CLAUDE.md，回落项目根
  for (const p of [path.join(WORKSPACE, "CLAUDE.md"), path.join(root, "CLAUDE.md")]) {
    try {
      parts.push(fs.readFileSync(p, "utf8"));
      break;
    } catch {
      /* 试下一个 */
    }
  }

  // Profile 补充（可选）
  const profileZe = readIfExists(path.join(root, "data", "profile-ze.md"));
  if (profileZe) parts.push(`\n\n## 关于泽（长期资料）\n\n${profileZe}`);
  const profileMai = readIfExists(path.join(root, "data", "profile-maisui.md"));
  if (profileMai) parts.push(`\n\n## 关于麦穗（补充资料）\n\n${profileMai}`);

  return parts.length ? parts.join("") : undefined;
}

function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
