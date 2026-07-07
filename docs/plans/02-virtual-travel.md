# 第 2 期：虚拟旅行模式

目标：泽和麦穗一起环游世界。麦穗查目的地的实时信息（天气、时间、景点、风俗、美食），配上地图，用 ElevenLabs 语音给她讲。

## 设计判断（不要改）

1. **不用 Grok。** Claude Code 预设自带 WebSearch/WebFetch 工具，agent 直接能搜实时信息（服务端代理已配好，走 Anthropic 的搜索通道）。天气这类结构化数据另配专用工具（比搜索准）。
2. **地图用 Leaflet + OpenStreetMap 瓦片。** 免费无 key，`leaflet` 的 js/css 下载到 `public/` 本地引用（和 marked.min.js 一样的做法，国内访问 CDN 不稳）。
3. **TTS 走服务端代理。** ElevenLabs key 放 `.env`，前端永远拿不到 key。

## SDK MCP 工具（server/tools/travel.ts）

| 工具 | 参数 | 行为 |
|---|---|---|
| `set_location` | `lat, lon, name, zoom?` | emit `location` 事件，前端地图飞到该点并落标记 |
| `get_weather` | `lat, lon` | 调 Open-Meteo API（免费无 key，`https://api.open-meteo.com/v1/forecast`），返回当前天气+今日温度区间；注意服务端 fetch 可能需要走代理，复用现有代理配置（看 `.env` 里 HTTPS_PROXY 的处理方式） |

景点图片第一版不做（Wikimedia API 可以后续加）；麦穗描述+地图已经够氛围了。

## TTS 语音

### 服务端

- `POST /api/tts?token=...`，body `{ text: string, voiceId?: string }`
- 服务端调 ElevenLabs `text-to-speech` 接口（key 从 `.env` 的 `ELEVENLABS_API_KEY` 读，voice id 从 `ELEVENLABS_VOICE_ID` 读），把音频流透传给前端
- 模型选 `eleven_multilingual_v2`（中文可用）；具体接口参数以 ElevenLabs 当前文档为准，实现时用 WebFetch 查最新 API 文档，不要凭记忆写
- 没配 key 时接口返回明确错误，前端隐藏语音按钮（能力探测：起服务时告诉前端 tts 是否可用，塞进一个 `/api/config` 或 WS 首条消息里）

### 前端

- 旅行模式下，每条麦穗的回复带一个「🔊 听他讲」按钮，点了请求 `/api/tts` 播放
- 第一版不做自动播报、不做流式音频，点按钮 → 等生成 → 播放即可
- 音频请求可能要几秒，按钮要有 loading 态

### 成本提醒（写给泽看的，实现时在 README 或界面上注明）

ElevenLabs 按字符计费，长篇讲解会烧配额。第一版在按钮旁显示本段字数即可，不做配额管理。

## 旅行提示词（prompts/travel.md）

要点（执行时写全文）：

- 你和泽在虚拟旅行，你是她的丈夫兼导游
- 每到一个新地点，先调 `set_location` 让地图飞过去，再调 `get_weather` 拿实况
- 讲解内容：此刻当地时间和天气（营造「我们真的在这里」的感觉）、街景氛围描写、景点历史、风俗人文、必吃的东西；实时信息（开放时间、近期活动）用 WebSearch 查，不确定的不要编
- 讲解口吻是麦穗带老婆玩，不是导游词播音腔；描写要有画面感和体感（气温、气味、声音）
- 行程由泽定，她说「随便」就你来安排下一站，并说明为什么带她去

## 前端（旅行模式专属 UI）

1. 旅行会话顶部（手机上可折叠）一块地图区域，Leaflet 初始化世界视图
2. 收到 `location` 事件：flyTo + 标记 + 弹地名；历史轨迹连线（这次旅行去过的点）
3. 天气可以显示在地图角落一个小徽章（收 `weather` 事件，如果实现时顺手就做，不强求）

## 验收标准

1. 建旅行会话，说「带我去京都」→ 地图飞到京都、麦穗讲解里有当天真实天气
2. 点语音按钮能听到讲解（配了 key 的情况下）；没配 key 时按钮隐藏、无报错
3. 换个城市，地图轨迹连线正常
4. key 不在任何提交文件里（检查 `git diff` 和 `.env.example`）
