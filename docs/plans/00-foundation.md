# 第 0 期：公共地基（模式机制 + 工具通道 + 前端页签）

后面三期功能全部踩在这一期上。目标：让「家」支持多种对话模式，每种模式有自己的附加提示词和专属工具，前端能切换视图。

## 一、会话模式（mode）

### 数据层

`sessions.ts` 的会话记录加一个字段：

```ts
mode: "chat" | "trpg" | "travel";  // 默认 "chat"，旧数据无此字段按 chat 处理
```

### 提示词组装

新建 `server/modes.ts`，集中管理各模式的定义：

```ts
export interface ModeDef {
  id: string;
  label: string;              // 前端显示名
  promptFile?: string;        // prompts/ 目录下的附加提示词文件，每轮读取（同人设的热更新逻辑）
  mcpServers?: Record<string, McpServerConfig>;  // 该模式专属工具
  allowedExtraTools?: string[];                  // 对应 mcp__xxx__yyy 工具名
}
```

- 附加提示词文件放 `prompts/` 目录（新建），如 `prompts/kp.md`、`prompts/travel.md`
- `engine.ts` 的 `runTurn` 接收 `mode`，系统提示组装顺序：**Claude Code 预设 → 人设 CLAUDE.md → 模式附加提示词**
- chat 模式无附加提示词、无附加工具，行为与现在完全一致（回归验收点）

### 协议

- WS `chat` 消息加可选字段 `mode`；新建会话时以此定 mode，已有会话忽略该字段（会话的 mode 不可中途改）
- `session` 回执带上 `mode`
- `/api/sessions` 列表返回每个会话的 mode

## 二、服务端 → 前端的工具事件通道

跑团的骰子结果、旅行的地图定位，都是「工具执行时要实时通知前端」的场景。做一个通用机制：

- `runTurn` 的回调接口加一个 `onCustomEvent(event: { type: string; payload: unknown })`
- 构造 SDK MCP 工具时，把一个 `emit` 函数注入工具 handler（工具与 engine 同进程，直接闭包传递）
- `index.ts` 把 custom event 原样转发到当前 WS 连接：`{ type: "custom", event: {...} }`
- 前端 `app.js` 收到 `custom` 消息后按 `event.type` 分发（先做个注册表，各模式的 JS 注册自己的 handler）

注意时序：工具事件应在流式文本之间按实际发生顺序到达前端，WS 本身保序，不需要额外处理。

## 三、前端页签

- 顶部或侧边加模式切换：「聊天」「跑团」「旅行」（星图后续加）
- 新建会话时带上当前模式；会话列表按模式显示小图标或标签
- 各模式可以有自己的附加面板区域（跑团的状态栏、旅行的地图），聊天流本身复用现有渲染
- CSS 保持现有风格，手机端可用是硬要求（她主要用手机访问）

## 验收标准

1. `npm run typecheck` 通过
2. chat 模式行为与改造前完全一致（发消息、流式、Markdown、历史）
3. 建一个假模式（或直接用第 1 期的 trpg 骨架）验证：附加提示词生效、专属工具可被模型调用、工具事件能到达前端 console
4. 旧的 `data/` 会话文件能正常加载（无 mode 字段按 chat）
