// 一次性验证脚本：npx tsx server/apierror.test.ts
import { splitApiError, apiErrorNote } from "./apierror.js";

let failed = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) failed++;
}

// 纯正文不受影响
const normal = splitApiError("今天想吃什么？\n我看了菜谱。");
check("纯正文原样返回", normal.clean === "今天想吃什么？\n我看了菜谱。" && !normal.apiError);

// 纯报错：clean 为空、apiError 有货
const pure = splitApiError('API Error: 402 {"error":{"message":"usage limit reached"}}');
check("纯报错 clean 为空", pure.clean === "");
check("纯报错 apiError 拿到原文", pure.apiError?.includes("402") === true);

// 混在真话里：剥出来，真话保留
const mixed = splitApiError('先说到这。\nAPI Error: 400 {"error":"bad gateway"}\n下次继续。');
check("混合时真话保留", mixed.clean === "先说到这。\n下次继续。");
check("混合时报错剥出", mixed.apiError === 'API Error: 400 {"error":"bad gateway"}');

// 多行报错都剥掉
const multi = splitApiError("API Error: 402 x\nAPI Error: 402 y");
check("多行报错全剥", multi.clean === "" && multi.apiError?.split("\n").length === 2);

// 聊天里聊到这个词组不误伤（不在行首带三位数字的格式）
const talk = splitApiError("你昨天说的 API Error: abc 是什么意思？\n哦还有 API Error 这个词。");
check("聊到词组不误伤", talk.clean.includes("API Error: abc") && !talk.apiError);

// 行首缩进也认
const indented = splitApiError("  API Error: 529 overloaded");
check("行首缩进也认", indented.clean === "" && indented.apiError === "API Error: 529 overloaded");

// 中转站漏标压缩头时 CLI 自己生成的解析错误，没有三位 HTTP 状态码，也得当错误处理
const parse = splitApiError("API Error: Failed to parse JSON");
check("JSON 解析失败也剥出", parse.clean === "" && parse.apiError === "API Error: Failed to parse JSON");

// 人话版：402 提额度，其他提重试
check("402 提额度", apiErrorNote("API Error: 402 usage limit").includes("额度"));
check("非限额提重试", apiErrorNote("API Error: 400 bad request").includes("再发一次"));
check("人话版附原文", apiErrorNote("API Error: 402 x").includes("API Error: 402 x"));

// 原文超长截断到 200
const long = apiErrorNote("API Error: 402 " + "x".repeat(500));
check("原文截断", long.length < 300);

if (failed) {
  console.error(`${failed} 项没过`);
  process.exit(1);
}
console.log("全过");
