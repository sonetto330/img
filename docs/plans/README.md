# 「家」装修图纸总览

这批文档是给执行模型（Opus）的施工方案。设计已经定稿，按顺序施工即可，不需要重新论证架构。

## 现状（地基）

- 服务端：`server/index.ts`（HTTP + WebSocket + 静态文件 + 口令验证）、`server/engine.ts`（Agent SDK 封装，`runTurn()`）、`server/sessions.ts`（会话 JSON 持久化到 `data/`）
- 前端：`public/` 纯 HTML/JS/CSS，无框架，Markdown 渲染用本地 `marked.min.js`
- 人设：根目录 `CLAUDE.md` 每轮注入系统提示（`engine.ts` 的 `systemPrompt.append`）
- 运行环境：Windows 本地，`start.bat` 启动，手机同 Wi-Fi 访问

## 施工顺序

| 期数 | 文档 | 内容 | 依赖 |
|---|---|---|---|
| 0 | `00-foundation.md` | 模式机制 + SDK 自定义工具通道 + 前端页签 | 无 |
| 1 | `01-coc-trpg.md` | CoC 跑团（KP 模式、骰子、人物卡、模组导入） | 第 0 期 |
| 2 | `02-virtual-travel.md` | 虚拟旅行（地图、实时搜索、TTS 语音讲解） | 第 0 期 |
| 3 | `03-memory-constellation.md` | 关联性记忆星图（提取、存储、检索、星图渲染） | 第 0 期；数据层可提前 |

**注意**：星图的「记忆提取」数据层（3 的 P1 阶段）建议在做 1、2 期时就先上——记忆是攒出来的，越早开始记录，星图成形越早。星图的前端渲染可以放最后。

## 全局施工规范

1. **不换技术栈。** 前端保持无框架纯 JS，服务端保持 tsx + TypeScript。不引入 React/Vue/构建工具。
2. **新依赖尽量少。** 已批准可加：`better-sqlite3`（记忆存储）。其他依赖先在提交说明里写明理由。
3. **密钥只进 `.env`。** ElevenLabs key、ACCESS_TOKEN 等一律走环境变量，`.env` 已在 `.gitignore`。同步更新 `.env.example`（只放变量名和注释，不放值）。
4. **每期做完要能跑。** `npm run typecheck` 通过，`npm run dev` 起服务，手动过一遍该期的验收标准再提交。
5. **中文注释，注释只写代码看不出来的约束。**
6. **提交粒度**：一期一个或几个提交，提交信息中文，说清做了什么。
7. **人设不动。** `CLAUDE.md` 注入机制保持现状；各模式的附加提示词是在人设**之后**追加，不是替换（麦穗去跑团还是麦穗，只是兼任 KP）。

## Agent SDK 自定义工具（已验证的接口，直接用）

`@anthropic-ai/claude-agent-sdk` 支持进程内 MCP 工具，这是骰子、地图定位等功能的通道：

```ts
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const diceServer = createSdkMcpServer({
  name: "trpg",
  tools: [
    tool(
      "roll",
      "掷骰。传入骰子表达式如 1d100、3d6+2",
      { expr: z.string() },
      async (args) => {
        const result = rollDice(args.expr); // 服务端真随机
        broadcast({ type: "dice", ...result }); // 同时推给前端做动画
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    ),
  ],
});

// runTurn 的 query options 里：
// mcpServers: { trpg: diceServer },
// allowedTools 里 MCP 工具名格式为 mcp__trpg__roll
```

注意 `zod` 需要加为依赖（SDK 的 peer 用法）。工具的 handler 里可以直接访问服务端状态（同进程），比如往当前 WebSocket 连接推消息——`engine.ts` 需要把一个「推送回调」传进工具构造处，具体见第 0 期文档。
