import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 阅后即焚：把内部会话历史（jsonl）里附件的原文替换成占位符。
 *
 * 背景：泽发的图片/文件是麦穗用 Read 工具看的，原文（图片 base64、文件全文）
 * 会作为工具结果留在历史里，之后每轮 resume 都跟着整段重发。看完这一轮就没
 * 用了——原件一直在 uploads 目录，需要时重新 Read 就是。
 *
 * 调用时机：下一轮 resume 之前。改动点在会话末尾，提示词缓存只作废尾部一小
 * 截，下一轮重写就重新稳定，不像 /compact 是整段历史作废。
 *
 * 格式风险：jsonl 是 SDK 内部格式，没有兼容性承诺。所以这里只做保守替换：
 * 解析不了的行原样保留，图片不删结构、只把 base64 换成 1x1 透明 PNG——
 * 不管 SDK 用消息体还是 toolUseResult 元数据里的那份重建历史，都还是合法
 * 图片。最坏情况是焚不掉，不会弄坏会话。
 */

// 1x1 透明 PNG，占位用
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// base64 比占位图还短的就是已经焚过的（或本来就小到没意义），跳过 → 幂等
const IMAGE_MIN_CHARS = 512;

// 文本附件超过这个字符数才焚：小片段留着不亏，焚了反而丢上下文
const TEXT_MIN_CHARS = 2000;

export interface BurnStats {
  /** 焚掉的附件块数 */
  burned: number;
  /** 省下的字符数（约等于历史文件瘦身量） */
  savedChars: number;
}

const NOOP: BurnStats = { burned: 0, savedChars: 0 };

/** Claude Code 把 cwd 里的非字母数字全换成 - 作为 projects 子目录名 */
function sessionFilePath(claudeSessionId: string, cwd: string): string {
  const munged = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", munged, `${claudeSessionId}.jsonl`);
}

function isUnderDir(filePath: string | undefined, dir: string): boolean {
  if (!filePath) return false;
  // Windows 路径大小写不敏感
  const p = path.resolve(filePath).toLowerCase();
  const d = path.resolve(dir).toLowerCase() + path.sep;
  return p.startsWith(d);
}

function burnNote(kind: string, filePath: string | undefined, chars?: number): string {
  const size = chars ? `（原文约 ${chars} 字符）` : "";
  const where = filePath ? `原件还在：${filePath}` : "原件还在 uploads 目录里";
  return `[${kind}原文已阅后即焚${size}，${where}，需要再看就重新 Read]`;
}

/**
 * 对一个会话历史文件做阅后即焚。找不到文件、没东西可焚都安静返回。
 * 图片：Read 出来的一律焚（重读代价低）；文本：只焚 uploads 目录下的大文件，
 * 别误伤麦穗自己读的代码和配置。
 */
export function burnAttachments(claudeSessionId: string, cwd: string, uploadsDir: string): BurnStats {
  return burnFile(sessionFilePath(claudeSessionId, cwd), uploadsDir);
}

/** 拆出来方便直接对着文件测试 */
export function burnFile(file: string, uploadsDir: string): BurnStats {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return NOOP; // 会话文件还没落盘或路径规则变了，这轮不焚
  }
  const lines = raw.split("\n");

  // 第一遍：记下每个 Read 调用读的是哪个文件，焚的时候好在占位符里留路径
  const readPaths = new Map<string, string>();
  for (const line of lines) {
    if (!line.includes('"tool_use"')) continue;
    try {
      const o = JSON.parse(line);
      if (o.type !== "assistant" || !Array.isArray(o.message?.content)) continue;
      for (const block of o.message.content) {
        if (block.type === "tool_use" && block.name === "Read" && typeof block.input?.file_path === "string") {
          readPaths.set(block.id, block.input.file_path);
        }
      }
    } catch {
      // 解析不了就不认识这行，跳过
    }
  }

  const stats: BurnStats = { burned: 0, savedChars: 0 };
  let anyChange = false;

  const out = lines.map((line) => {
    if (!line.includes('"tool_result"')) return line;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      return line;
    }
    if (o.type !== "user" || !Array.isArray(o.message?.content)) return line;

    let changed = false;

    for (const block of o.message.content) {
      if (block?.type !== "tool_result") continue;
      const fp = readPaths.get(block.tool_use_id);

      if (Array.isArray(block.content)) {
        for (const c of block.content) {
          if (
            c?.type === "image" &&
            c.source?.type === "base64" &&
            typeof c.source.data === "string" &&
            c.source.data.length > IMAGE_MIN_CHARS
          ) {
            stats.savedChars += c.source.data.length;
            c.source.data = TINY_PNG;
            c.source.media_type = "image/png";
            block.content.push({ type: "text", text: burnNote("图片", fp) });
            stats.burned++;
            changed = true;
          } else if (
            c?.type === "text" &&
            typeof c.text === "string" &&
            c.text.length > TEXT_MIN_CHARS &&
            isUnderDir(fp, uploadsDir)
          ) {
            stats.savedChars += c.text.length;
            c.text = burnNote("文件", fp, c.text.length);
            stats.burned++;
            changed = true;
          }
        }
      } else if (
        typeof block.content === "string" &&
        block.content.length > TEXT_MIN_CHARS &&
        isUnderDir(fp, uploadsDir)
      ) {
        stats.savedChars += block.content.length;
        block.content = burnNote("文件", fp, block.content.length);
        stats.burned++;
        changed = true;
      }
    }

    // SDK 元数据里还存了一份原文，一起焚，但不重复计块数
    const f = o.toolUseResult?.file;
    if (f) {
      if (typeof f.base64 === "string" && f.base64.length > IMAGE_MIN_CHARS) {
        stats.savedChars += f.base64.length;
        f.base64 = TINY_PNG;
        f.type = "image/png";
        changed = true;
      }
      if (
        typeof f.content === "string" &&
        f.content.length > TEXT_MIN_CHARS &&
        isUnderDir(typeof f.filePath === "string" ? f.filePath : undefined, uploadsDir)
      ) {
        stats.savedChars += f.content.length;
        f.content = burnNote("文件", f.filePath, f.content.length);
        changed = true;
      }
    }

    if (!changed) return line;
    anyChange = true;
    return JSON.stringify(o);
  });

  if (anyChange) {
    // 原子替换，写一半断电也不会留下坏文件
    const tmp = file + ".burn-tmp";
    fs.writeFileSync(tmp, out.join("\n"));
    fs.renameSync(tmp, file);
  }
  return stats;
}
