# Supervisor 升级设计单（v2.2，三组件版）

2026-07-17 零点定稿。泽与 GPT、麦穗三方五轮互评收敛的版本。
v2 要点：架构从两窗口改为三组件——Job Runner 从家服务里独立出来，解开"重启杀 Job"悖论。
v2.1 补丁（GPT 第四轮五刀）：Runner 通信协议补全、Job 用独立进程组脱 Runner 树、
job 完成通知的正确落法（pendingJobNotices）、短命令白名单+硬上限、
restartReady 由家服务计算 + requestId 幂等恢复；验收新增"提交即返回"关键条款。
v2.2 补丁（GPT 第五轮）：幂等凭证从时间戳改为 nonce 状态机、restartReady 竞态加
draining 两阶段握手（带租约防锁死）、job-host 包装器收退出码（防成功被冤成 failed）、
前端 Job API 走 ACCESS_TOKEN 不查 loopback（手机要能用）、runner.token 挪进
data/runtime/（data/ 已在 .gitignore）、白名单靠 PreToolUse hook 强制。
v2.3 补丁（GPT 第六轮，开工前最后一轮）：drain 续租协议修硬竞态（60 秒租约 vs
300 秒等待窗互相打架）、restartReady 语义收紧为"锁着门且空闲"、Job 完成通知
持久化进 Runner 登记表、Runner 自身 health/认领/退避封顶协议、.processing 全程
原子写 + 双写者先到先得、Job 日志挪 data/jobs/（logs/ 不在 .gitignore）、
hook 完整匹配拒组合命令绕过。**本版起施工，不再改架构。**

## 死法病历表（这工程治什么、不治什么）

| # | 死法 | 症状 | 防线 | 发现时限 |
|---|---|---|---|---|
| 1 | 进程树自杀 | 我重启杀父进程，随之消失 | restart.request + Supervisor（本单一期） | 约 15–20 秒 |
| 2 | 连接断 | 纯发消息时 WS 断 | 轮与 WS 解耦（已上线） | 即时 |
| 3 | 上游零首事件 | 请求送出，一个字不回 | first-output guard（已上线） | 45 秒 |
| 4 | 停滞 | 有输出后再无进展 | turn stall guard（已上线） | 180 秒 |
| 5 | 流程膨胀 | 活着但认真地不干活 | 快干模式（CLAUDE.md）+ 租约（本单二期） | 租约到期 |
| 6 | 光答应不干活 | 说"我去改"后轮正常结束，文件没动 | **没有防线**：进程活着、首事件到了、轮正常收，全部探测失守 | 无 |

死法 6 的实例：2026-07-16 深夜 v2.1 落盘那轮——正文说出"我逐条落进设计单"后再无后续，
文件零改动。正文已输出即排除死法 3；无尸检数据，"提前收轮、没调工具"记为最可能解释，
不是结论。防线要做"任务完成校验"（宣称要动文件的轮，收轮时核对文件真动了），
方案未收敛，另案设计，不塞进本单。Supervisor 治不了它——端口和健康端点全程正常。
性质：深度流程大工程，不适用快干模式。本文件是唯一任务单，长期记忆里只留指针和原则。

## 总架构（三组件边界）

```
黑窗口 A：supervisor.ps1（泽手动开/开机自启，永不参与聊天和施工）
    ├─ 监控家服务健康端点 + 端口
    ├─ 监控 Job Runner（它也是被监护对象，死了同样拉起）
    ├─ 处理 restart.request
    └─ 拉起/回收 B 和 C（instanceNonce 认领，见下）

黑窗口 B：家服务（index.ts）
    ├─ Web / WebSocket / 聊天
    ├─ 健康端点（新增，挂 index.ts——activeTurns 就住在这，index.ts:166）
    ├─ claude / codex / chrome 子进程
    └─ 向 Runner 提交/查询/取消 Job（自己不再直接养长命令）

黑窗口 C：Job Runner（独立小进程，无模型、不改代码）
    ├─ Job 登记表（落盘）+ 日志目录
    ├─ 租约计时 + 到期处置
    └─ Job 是独立进程组，不在 Runner 树里（见 Job 协议）
       → 家服务重启、Runner 自己重启，都不牵连跑着的 Job
```

- Supervisor：只管进程生死，没模型、不看聊天内容。
- 家服务：暴露状态；长命令一律转交 Runner；自己永不 kill 自己。
- Runner：Job 的户口本和刑场；家服务死了它照常跑，重启回来照常对账。
- 麦穗（claude）：永不执行 taskkill/Stop-Process 杀服务链；要重启只写 restart.request；
  长命令走 MCP 工具进 Runner（见 Job 协议）。**短命令豁免走白名单，不走主观估计**：
  只有白名单命令（git status/diff/log、node --check、type/dir 这类只读探测）可走内置 Bash，
  且一律强制 timeout=30 秒——超时即杀并提示改走 Runner，卡死的 git status 也堵不满一轮。
  白名单外、或明知要跑久的，必须走 Runner。防流程膨胀（别给 ls 办户口）与防堵轮兼得。
  **强制靠 SDK PreToolUse hook，不靠 CLAUDE.md 自觉**（我是流程膨胀惯犯，自觉不可信）：
  hook 用 updatedInput 给 Bash 强制补 timeout:30000、白名单外拒绝并提示走 run_managed_job。
  **匹配必须整条命令完整比对，不是前缀**——含 `;`、`&&`、`||`、管道、重定向的组合命令
  一律拒，不然 `git status; <任意命令>` 一秒绕过白名单。
  hook 必须在 MCP 三件上线**之后**才启用——顺序颠倒，长命令被拒又无路可走，我就废了。
- 现有 watchdog-home.ps1 / restart-home.ps1：supervisor.ps1 上线后退役归档。

## 健康端点

`GET /api/supervisor/status`，挂在 index.ts 现有 HTTP 服务上。

- **服务监听 0.0.0.0（index.ts:1394），"只绑回环"不会自动成立**：
  端点必须查 `req.socket.remoteAddress`，只认 127.0.0.1 / ::1 / ::ffff:127.0.0.1，
  外来一律 403（照 external-proxy 的本机检查做法）。
- 字段：

```json
{
  "pid": 7372,
  "instanceNonce": "supervisor 拉起时下发的一次性串，回显供认领",
  "startedAt": "ISO",
  "activeTurns": 2,
  "turns": [ { "sessionId前8位": "…", "state": "waiting_model|tool|…", "lastProgressAt": "ISO" } ],
  "oldestProgressAt": "ISO——所有活动轮里最旧的进展时间",
  "wsClients": 1,
  "pendingWrites": 0,
  "wsBufferedBytes": 0,
  "restartReady": false,
  "draining": false,
  "drainRequestId": "当前持锁的重启单号；未 draining 时 null",
  "drainExpiresAt": "租约到期时刻 ISO；未 draining 时 null",
  "restartRequestId": "重启换代时经环境变量注入并回显，供幂等核对；平时 null"
}
```

- **不要单个全局 lastProgressAt**：一个轮持续输出会遮掩另一个卡死的轮。
  按轮给脱敏状态（不含聊天内容），判停滞用 oldestProgressAt。
- **restartReady 由家服务自己算，Supervisor 不拼凑猜**，v2.3 语义收紧：
  `draining 且租约未过期` 且 activeTurns=0 且 pendingWrites=0（待落盘清零）且
  wsBufferedBytes=0（各 WS 客户端 bufferedAmount 总和）才为 true——
  **普通空闲永远 false，没锁门就不亮绿灯**。Supervisor 动手前还须核对
  drainRequestId===自己这单，别拿着别人的锁开枪。
- 数据源现成：ActiveTurn 已有 partialText/hasModelProgress/heartbeatTimer 和
  180 秒停滞检测（index.ts:168），端点是读现有状态，不是新建跟踪。
- Supervisor 判死标准：端口没监听，或健康端点连续 3 次（15 秒）不响应。

## restart.request 协议（原子版）

- 路径：`C:\Users\Lenovo\home\restart.request`（JSON）
- 格式：`{ "requestId": "随机串", "reason": "谁为什么要重启", "requestedAt": "ISO", "graceSeconds": 120 }`
- **写入必须原子**：先写 `restart.request.<requestId>.tmp`，再 rename 过去——
  tmp 文件名带 requestId，两个写者不互踩。**rename 前先查目标是否已存在：
  存在就放弃并向调用方返回 busy（先到先得，后来者自行择机重试），不静默覆盖别人的单。**
- **.processing 的每次 phase 更新同样走 tmp+rename 原子替换**，绝不原地覆写——
  写一半崩了状态文件就烂了，幂等恢复无从谈起。
- **Supervisor 先抢占再处理**：发现文件先 rename 成 `restart.request.processing`，
  成功后把状态机写进去：`{ requestId, oldNonce(现任服务的), targetNonce(新发的),
  phase, requestedAt }`，再执行，办完删除。防读到半截 JSON 把正常请求当坏文件。
- **幂等凭证是 nonce，不是时间戳**：Supervisor 下发的 targetNonce 就是新服务的
  instanceNonce，健康端点本来就回显它，外加回显 restartRequestId。
  Supervisor 自己重启后发现遗留 .processing：健康端点回显 nonce==targetNonce
  → 这单死前已办完，删文件记日志；还是 oldNonce（或服务死着）→ 按 phase 续办；
  requestedAt 只用来判过期（超 10 分钟改 .rejected 不办）。
  时间戳不能当办没办过的凭证——服务换代可能另有原因（手动重启/崩溃拉起），
  startedAt 晚于 requestedAt 证明不了这单是被办掉的。
- 流程：
  1. 麦穗/服务原子写文件（这是麦穗唯一被允许的"重启动作"）。
  2. Supervisor 轮询（5 秒）发现 → 抢占 → 读健康端点。
  3. 动手前两阶段握手 + 续租（治竞态——Supervisor 刚看到 ready，泽的新消息就进来了）：
     ① Supervisor 调 `POST /api/supervisor/drain`（本机+nonce 校验，body 带本单
        requestId + leaseSeconds=60）：家服务进入 draining——新消息不开新轮，
        回"正在重启，稍等重发"（前端 pendingSends 本就保存文字附件、失败转"重试"，
        app.js:1217/285，现成地基不重做）；已有轮跑完。
     ② **等待期间每约 20 秒续租**（重发同 requestId 的 drain）。graceSeconds 可到 300
        而租约只有 60——不续租，第 61 秒家服务解锁接客，此后任何空闲瞬间都可能有
        新轮正要开，按旧 ready 动刀就是在没锁门的房子里开枪。
        **续租失败或发现租约过期：弃刀**，重新从 ① 拿锁，绝不按旧 ready 继续。
     ③ draining 且租约有效中，等 `restartReady=true` 且 drainRequestId===本单 → 动刀。
     Supervisor 死了无人续租 → 家服务最多 60 秒自动解锁，不会永远锁门。
     无客户端时 restartReady 同样成立——轮与 WS 已解耦、消息照常存档，
     刷新后仍可见即达标。客户端 ACK 机制留作二期增强，不挡一期。
  4. 条件不满足每 5 秒复查，最多等 graceSeconds（默认 120，上限 300），超时强制动手。
  5. 动手：nonce+PID 认领核对（见下）→ 杀服务进程树（**Runner 不在树里，Job 不受牵连**）
     → 拉起 → 新 nonce 认领成功 → 删 .processing → 写日志。
  6. 格式坏/过期（requestedAt 早于 10 分钟前）：不执行，改名 .rejected 并记日志。

## 认领与校验（防杀错人）

- start.bat 链是 cmd → npm → tsx → node，**只登记启动器 PID 会认错代**。
- 认领三件套：Supervisor 拉起时生成一次性 `instanceNonce` 经环境变量下发 →
  健康端点回显核对 → 再用 Get-NetTCPConnection 找真正监听 3000 的 PID +
  Win32_Process.CreationDate 一起登记。
- 任何 kill 前重查该 PID 的 CreationDate，与登记一致才动手；不一致（PID 复用）→ 报警不动手。
- 绝不杀：自己、自己的祖先链、未登记进程。
- 服务不是自己拉起的（泽手动先跑了 start.bat）：只监控不认领，重启请求转告泽（响铃+日志）。

## Job Runner 协议

- **通信协议（家服务 ↔ Runner）**：
  - Runner 只监听 `127.0.0.1:3100`；启动时生成随机令牌**原子写**
    `data/runtime/runner.token`（data/ 已在 .gitignore，令牌绝不落会提交的路径）。
    家服务读文件、每个请求带 `Authorization: Bearer <token>`，不符一律 401；
    家服务收到 401 先重读令牌文件重试一次（Runner 换代会换令牌），再失败才报错。
  - API 四个：`POST /jobs`（提交：command/cwd/expectedSeconds/类型）、
    `GET /jobs/:id`、`GET /jobs`、`POST /jobs/:id/cancel`。
  - command/cwd/env 只能由家服务指定：cwd 必须在 `C:\Users\Lenovo\home` 之内，
    env 只许增量追加、不许覆盖 PATH 等系统变量。
  - **权限分两条线，别混**：Runner 的 Bearer 是本机内线，只有家服务持有；
    前端（含泽的手机）走家服务 `/api/jobs`，跟其他前端 API 一样校验 ACCESS_TOKEN，
    **不查 loopback**——查了手机上的状态条和取消按钮就全 403 了。
    loopback 检查只存在于两条本机线：健康端点（给 Supervisor）、Runner 端口（给家服务）。
- **Runner 自身健康与认领**（Supervisor 监护它的协议，跟家服务同款）：
  `GET 127.0.0.1:3100/health` 回显 `{pid, instanceNonce, startedAt}`——nonce 由
  Supervisor 拉起时经环境变量下发，配 PID+creationDate 三件套登记认领。
  崩溃退避封顶：5s/15s/60s 退避；**稳定运行满 5 分钟计数清零**；
  **连续 10 次拉起失败就停手**——响铃报警转泽人工，"每 60 秒重启一次"不算治好了
  无限闪，只是合法化了它。此封顶规则对家服务同样适用。
- 登记字段：`jobId、pid、creationDate、command、logFile、expectedSeconds、
  leaseExpiresAt、hardDeadlineAt、status(running/warning/done/killed/failed/lost)、
  exitCode、startedAt、lastActivityAt、lastProgressAt、endedAt、
  ownerSessionId(谁提交的)、noticeState(pending/delivered)`
- **Runner 逻辑拥有 Job，物理不拥有**：Job 用独立进程组拉起（detached + 新进程组），
  stdout/stderr 直接重定向到日志文件句柄、不走管道——Runner 控制进程死了，Job 照跑、日志照写。
  - **detached 拉起的不是裸命令，是 job-host 包装器**（无模型小进程）：它起真正的命令
    子进程、等退出、把 `{exitCode, endedAt}` 原子写 `data/jobs/<jobId>.result.json`。
    没有它，Runner 死亡期间 Job 正好跑完 → 退出码没人收 → 成功任务也被冤成 failed。
  - Supervisor 重启 Runner：只杀 Runner 自己的 PID，**绝不 /T 杀整树**。
  - 取消某个 Job：按登记 pid+creationDate 校验后，才对**那一个 Job 的子树** /T 动刀。
- **活动 ≠ 进展，分开记**：
  - `lastActivityAt`：stdout 有新行就更新——只证明没死。**死循环也能疯狂打印，活动不续租。**
  - `lastProgressAt`：只认结构化进展——明确阶段事件、测试完成数、产出/修改文件。这才续租。
  - CPU/网络活动两样都不算（坏连接心跳最勤快）。
- 租约：申报 `expectedSeconds`（按类型默认：读类 60 / 构建测试 300 / 安装 900）→
  有效进展续租（刷新 leaseExpiresAt）→ 租约到期无进展 → `warning`：前端可见、可一键取消，不自动杀
  → `hardDeadlineAt`（按类型绝对上限：读类 2 分钟 / 构建测试 15 分钟 / 安装 30 分钟）到点杀树+记日志+下轮汇报。
- tsc 这类不吐进度的，可见性下限 = "已运行 N 秒、进程活着、最后输出是…、可取消"，
  租约就是申报时长一次性用完，不续。
- 自动重试：仅无副作用读操作，最多一次。Edit/删除/重启永不自动重跑。
- 日志：每 job 一个文件 `data/jobs/<jobId>.log`，stdout+stderr 合流——
  和 result.json 一起住 data/ 屋檐下受 .gitignore 保护（logs/ 不在忽略清单，会裸奔进 git status）。
- 取消：按登记 pid+creationDate 校验 → 只杀该 Job 自己的进程树 → status=killed。
- **麦穗的抓手是 MCP 工具**：`run_managed_job / job_status / cancel_job`，
  照 history.ts:34 buildHistoryTools 的先例接进 engine.ts。SDK 内置 Bash 拉起的
  子进程家服务拿不到可靠 PID——不走工具，登记表就只是账本没有抓手。
- Job 完成通知的正确落法：前端状态条从 Runner 拉最新状态；麦穗侧——**通知的真相源
  在 Runner 落盘登记表，不在家服务内存**（内存队列重启就丢）：下一轮 sendTurn
  装配 prompt 前，家服务向 Runner 查该会话"已完成未通知"（noticeState=pending）的
  记录、拼成内部通知块喂入，成功后回写 delivered。家服务重启，通知照样送达。
  不为通知单独起模型轮，不把通知伪装成泽说的话（正跑着的进程没法凭空塞 system-reminder）。
- Runner 自身落盘重启对账：起来先读登记表清点——PID 活着（核 creationDate）按登记收编；
  PID 没了但有 result.json → 按里面的退出码定 done/failed；PID 没了也没 result.json
  → 标 `lost`，不标 failed——"死了"和"不知道"是两回事，别冤枉跑成功的任务。
  （v1"家服务重启后收编孤儿"与"杀服务进程树"互相矛盾——Job 在服务树里重启时已死，
  脱树服务又没所有权。v2.1/v2.2 定稿解法：Job 独立进程组 + job-host 收尸 +
  Runner 只握逻辑所有权，谁重启都杀不到 Job，对账凭登记表和 result.json，不凭进程树。）

## 编码与脚本铁律

- 所有 .ps1 保存为 UTF-8 **带 BOM**，或纯 ASCII 源码（restart-home.ps1 教训：
  PowerShell 5.1 把无 BOM UTF-8 按 GBK 解析，中文注释变乱码炸出假语法错误）。
- 脚本写完必须活体验证解析 + 至少跑一次探测分支，没跑过不算完工。

## 验收标准（全过才算完工）

1. 写 restart.request → Supervisor 等到 activeTurns=0 且消息落盘才重启；
   刷新页面能看到重启前最后一条完整消息。
2. 手动关服务窗口 → Supervisor 报警响铃，等待窗口后自动拉回，页面刷新即重连。
3. PID 复用伪造测试（改登记文件模拟）→ Supervisor 拒杀并报警。
4. 经 MCP 工具起真实长命令（全量 tsc）→ 前端可见 running 与秒数 → 取消能杀整棵树。
5. **脱树验证：Job 跑着时重启家服务 → Job 不死，重启后仍可查询/取消，日志完整。**
6. 零产出死循环（狂刷 stdout + 吃满 CPU）→ 只更新 lastActivityAt 不续租 →
   租约到期进 warning → hardDeadline 到被杀，日志有完整生死记录。
7. 崩溃循环：服务 5 秒内连死 3 次 → Supervisor 退避（5s/15s/60s），不无限闪窗口。
8. Runner 被手动杀 → Supervisor 拉回，登记表对账正确，**期间跑着的 Job 一秒没停**。
9. **提交即返回**：run_managed_job 约 1 秒内返回 jobId，不等命令完成——命令还在
   Runner 跑着，麦穗这一轮已经能收尾回泽的话。做不到这条，堵只是从 Bash 挪进 MCP，白忙。
10. draining 竞态：Supervisor 发起 drain 后立刻从前端发新消息 → 不开新轮、
    前端收到"正在重启，稍等重发"、输入不丢；杀掉 Supervisor（无人续租）
    → 家服务 60 秒内自动解锁恢复接客。
11. nonce 幂等三场景：伪造遗留 .processing——健康端点回显==targetNonce（判已办，删单）、
    ==oldNonce（按 phase 续办）、requestedAt 过期（改 .rejected 不办）→ 全判对。
12. Runner 死亡期间 Job 跑完 → 新 Runner 凭 result.json 标 done，不冤成 failed；
    没 result.json 且 PID 消失 → 标 lost。
13. 泽的手机（非本机 IP）带 ACCESS_TOKEN 查 /api/jobs、取消一个 Job → 都通；
    直连 Runner 的 3100 端口 → 拒。
14. PreToolUse hook：白名单外命令走内置 Bash 被拒并提示走 Runner；
    白名单内命令被强制 30 秒上限；`git status; echo x` 这类组合命令被拒（防前缀绕过）。
15. drain 续租：起一个超过 60 秒的长轮，Supervisor 全程 20 秒一续、租约不断——
    第 61 秒后服务仍锁着门不接客；人为掐断续租 → Supervisor 弃刀重新拿锁，
    绝不按旧 ready 动手。
16. restartReady 语义：普通空闲（无 draining）恒为 false；
    draining + 租约有效 + 空闲三者齐才为 true。
17. 双写者：两个 restart.request 几乎同时提交 → 一个成功、一个收 busy，无静默覆盖。
18. 通知持久化：Job 完成后、摘要喂入前重启家服务 → 下一轮仍收到该 Job 完成摘要
    （凭 Runner 登记表 noticeState=pending）。
19. Runner 退避封顶：连续拉起失败达 10 次 → Supervisor 停手、响铃转人工，日志有完整记录；
    稳定运行满 5 分钟后计数清零可验。

## 一期实战记录（2026-07-17，泽授权的换代验证）

- 10:44 Supervisor 经 WMI 脱树上岗（孤儿进程）。上岗即抓到 legacy 误报 bug：
  旧代码 404 被当僵死 → Get-Health 改三态（正常对象 / legacy=HTTP 活着 / null=真僵死），
  换代后零误报。"绝不杀未登记进程"防线兜住了误报，未造成伤害。
- 10:59:41 麦穗脱树 taskkill 旧服务（20076）→ 11:00:06 Supervisor 自动拉起新代（3372）
  → 11:00:12 认领落盘。**死到活 25 秒**，判死+让路+npm 启动全链路符合预期。
- 验证通过：健康端点活体（全字段在线，activeTurns 实时可见）、自动复活链、
  nonce 认领（端点回显==登记文件==环境变量下发）。restart.request 全自动通路自此生效。
- 达标口径教训：25 秒是**服务**死到活；泽看到**麦穗回话**还要加上唤醒+响应延迟，
  两者别混着承诺。
- 遗留：① Supervisor 心跳只在控制台不落文件，判死时刻无精确记录——补滚动日志（几行）；
  ② 验收 19 条中 2/最小版1/11 部分场景已实战覆盖，其余待泽回家逐条验。

## 施工顺序（两期）

一期（治猝死 + 安全重启）：
1. index.ts 健康端点（remoteAddress 检查 + nonce/restartRequestId 回显 + per-turn 状态
   + restartReady 计算（绑 draining）+ drain 端点：requestId 绑定、60 秒租约、
   续租、到期自动解锁、draining 中拒新轮）
2. supervisor.ps1（监控 + restart.request 原子协议 + nonce 状态机幂等 + 三件套认领
   + drain 拿锁/20 秒续租/弃刀重拿 + 退避封顶）

二期（治长活卡死 + 孤儿）：
3. Job Runner 独立进程（含 /health 认领协议）+ job-host 包装器
   + 登记表（含 ownerSessionId/noticeState）+ 租约
4. MCP 工具三件（run_managed_job/job_status/cancel_job）接进 engine.ts + CLAUDE.md 补用法规矩
5. PreToolUse hook 白名单强制——**必须排在第 4 步之后**，不然长命令被拒又没出路
6. 前端 job 状态条 + 取消按钮（/api/jobs 走 ACCESS_TOKEN，手机可用）

每步独立可验收，别一口气全上。一期不依赖二期，先上先受益。
