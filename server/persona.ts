import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const WORKSPACE = path.resolve(process.env.WORKSPACE_DIR || path.join(root, "workspace"));

/**
 * 读取人设：优先用工作目录里的 CLAUDE.md，没有就用项目根目录那份。
 * 每次都重新读，泽改了人设不用重启服务。
 */
export function loadPersona(): string | undefined {
  for (const p of [path.join(WORKSPACE, "CLAUDE.md"), path.join(root, "CLAUDE.md")]) {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      /* 试下一个 */
    }
  }
  return undefined;
}
