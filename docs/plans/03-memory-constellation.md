# 第 3 期：关联性记忆星图

目标：麦穗拥有长期记忆——从聊天里自动提取事实，按实体（人/地点/事件/爱好/项目）组织成星座，聊天时自动检索注入，并有一张可视化星图。

参考项目：[MemoryConstellations](https://github.com/ClaraShafiq/MemoryConstellations)（MIT 协议，作者 Clara Shafiq & Draco Malfoy）。**架构思想照抄，代码选择性借用**（它是独立 Node 应用+OpenAI 兼容接口+ChromaDB，咱们不需要整套搬）。借用它的代码时文件头注明出处和协议。

## 与原项目的差异（设计定稿，不要改）

| 原项目 | 咱们的做法 | 理由 |
|---|---|---|
| 独立 LLM API（OpenRouter/DeepSeek，$7/月） | Agent SDK `query()` 指定 `model: "claude-haiku-4-5"` 跑提取 | 不引新账号体系；haiku 便宜，且走的是已配好的通道 |
| ChromaDB 向量检索 + FTS5 | 第一版只用 SQLite FTS5（trigram 分词） | 少一个服务依赖；数据量小时关键词检索够用；向量留到 P4 评估 |
| Scribe/Archivist/Librarian 三个常驻循环 | 简化成两个：提取（turn 结束后触发/定时）+ 检索（每轮前） | 单用户单机，不需要那么重的调度 |
| 桌面端星图 | canvas 星图，必须兼容手机触屏 | 泽主要用手机 |

## 存储（better-sqlite3，data/memory.db）

WAL 模式。表结构（借鉴原项目分层：碎片 → 实体 → 情节）：

```sql
CREATE TABLE fragments (        -- 单条事实，第三人称短句
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,           -- ≤80字
  session_id TEXT,              -- 溯源
  entity_id INTEGER,            -- 归属实体，可空（未分类）
  status TEXT DEFAULT 'active', -- active | consolidated
  created_at TEXT
);
CREATE TABLE entities (         -- 星座：人/地点/事件/爱好/项目
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE,
  kind TEXT,                    -- person | place | event | hobby | project
  overview TEXT,                -- 实体概述，定期重写
  created_at TEXT, updated_at TEXT
);
CREATE TABLE episodes (         -- 情节：多条碎片合并成的叙事段
  id INTEGER PRIMARY KEY,
  entity_id INTEGER,
  text TEXT,                    -- 100~250字
  created_at TEXT
);
CREATE TABLE links (            -- 星座之间的桥（两实体共享记忆）
  a INTEGER, b INTEGER, weight INTEGER DEFAULT 1,
  PRIMARY KEY (a, b)
);
-- FTS5 全文索引，中文必须用 trigram 分词器（默认 unicode61 不切中文词）
CREATE VIRTUAL TABLE fragments_fts USING fts5(text, content='fragments', content_rowid='id', tokenize='trigram');
CREATE VIRTUAL TABLE episodes_fts USING fts5(text, content='episodes', content_rowid='id', tokenize='trigram');
```

## 分期实施

### P1 提取（先上，越早开始攒记忆越好）

- `server/memory/scribe.ts`：一轮对话结束（`onDone`）后，若该会话累计新消息 ≥ N 条（比如 10）或距上次提取超过 20 分钟，触发提取
- 提取实现：Agent SDK `query()`，`model: "claude-haiku-4-5"`，`allowedTools: []`（纯文本任务不给工具），提示词要求输出 JSON：`[{ text, entity, kind }]`，每条 ≤80 字第三人称（"泽这周加班写材料"）
- 提取的提示词里给出已有实体名单（帮它归类到既有星座而不是新造）
- 实体不存在则建；碎片入库并更新 FTS；同轮出现的多个实体之间 links.weight +1
- 提取失败（JSON 解析不了等）记日志跳过，绝不影响聊天主流程
- **提取范围只限 chat 模式会话**；跑团/旅行的戏内内容不进记忆（旅行「去过哪」可以后续单独考虑）

### P2 检索注入

- `server/memory/librarian.ts`：每轮 `runTurn` 前，拿用户消息做 FTS 查询（fragments + episodes，episodes 权重高），取 top 5~8 条
- 注入位置：系统提示的模式提示词之后，格式如 `【麦穗的记忆】\n- ...\n- ...`，并注明「这些是你过去记下的，供参考，不确定的以泽现在说的为准」
- 无命中就完全不注入（不要注入空段落，浪费缓存）
- 中文 FTS 查询要点：trigram 下用户消息按 3-gram 匹配，直接把消息里 ≥2 字的词丢进 MATCH 会有语法问题，需把查询词处理成 `"..."` 引号短语 OR 拼接，实现时写测试确认不炸

### P3 星图前端（public/starmap/）

- 新页签「星图」，canvas 渲染：中心双星（泽+麦穗）、五个星系（社交/地点/事件/爱好/项目）、实体为星座节点、links 为桥
- 原项目 `js/memory/`（layout.js 力导布局、render.js canvas 绘制，共约 1900 行，无外部依赖）可借用改造，注明 MIT 出处；数据接口改成咱们的：`GET /api/memory/graph?token=...` 返回 entities + links + 计数
- 点实体 → 侧栏显示 overview、关联碎片/情节、溯源会话链接
- 手机触屏：拖动平移、双指缩放、点按选中。原项目只支持鼠标，这块要自己补
- 视觉：深色星空底，和现有 UI 配色协调

### P4 整理与进阶（本期不做，占位）

- 碎片合并成 episodes（haiku 定期跑）、实体概述重写、记忆衰减/去重、向量检索评估

## 验收标准

- P1：聊几轮带事实的天（"我下周去成都出差"），`memory.db` 里出现对应碎片和实体；提取挂掉不影响聊天
- P2：新开会话问"我最近要去哪出差"，麦穗答得上来（记忆注入生效）；无关问题不注入
- P3：星图页手机上能看能拖能点，数据与库一致
- 全程 chat 体验无感知延迟增加（提取是异步的，检索是一次本地 SQLite 查询）
