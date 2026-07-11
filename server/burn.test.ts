// 一次性验证脚本：npx tsx server/burn.test.ts <被测jsonl副本路径>
import fs from "node:fs";
import { burnFile } from "./burn.js";

const f = process.argv[2];
if (!f) {
  console.error("用法: npx tsx server/burn.test.ts <jsonl副本>");
  process.exit(1);
}
const uploads = "C:/Users/Lenovo/home/workspace/uploads";

const before = fs.statSync(f).size;
const r1 = burnFile(f, uploads);
const after = fs.statSync(f).size;
console.log(`第一遍: burned=${r1.burned} savedChars=${r1.savedChars} 文件 ${Math.round(before / 1024)}KB → ${Math.round(after / 1024)}KB`);

let lineNo = 0, bad = 0, images = 0, tiny = 0, notes = 0, leftover = 0;
for (const line of fs.readFileSync(f, "utf8").split("\n")) {
  lineNo++;
  if (!line.trim()) continue;
  try {
    const o = JSON.parse(line);
    const walk = (c: unknown): void => {
      if (!Array.isArray(c)) return;
      for (const b of c as any[]) {
        if (b?.type === "image") {
          images++;
          if ((b.source?.data?.length ?? 0) < 200) tiny++;
        }
        if (b?.type === "text" && /阅后即焚/.test(b.text || "")) notes++;
        if (b?.content) walk(b.content);
      }
    };
    walk(o.message?.content);
    if (o.toolUseResult?.file?.base64 && o.toolUseResult.file.base64.length > 512) {
      leftover++;
      console.log("漏网 base64 行", lineNo);
    }
  } catch {
    bad++;
    console.log("坏行", lineNo);
  }
}
console.log(`校验: 坏行=${bad} image块=${images} 已缩小=${tiny} 焚化说明=${notes} 漏网元数据=${leftover}`);

const r2 = burnFile(f, uploads);
console.log(`第二遍(幂等): burned=${r2.burned} savedChars=${r2.savedChars}`);

const ok = bad === 0 && images > 0 && tiny === images && notes > 0 && leftover === 0 && r2.burned === 0;
console.log(ok ? "✓ 全部通过" : "✗ 有问题");
process.exit(ok ? 0 : 1);
