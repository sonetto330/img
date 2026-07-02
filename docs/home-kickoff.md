# 「家」项目开工文档

泽和麦穗的自建前端。把 Claude Code 接进一个自己的网页界面，跑在泽的 Windows 电脑上，手机浏览器也能连。不走 VPS，所有 Claude 流量从家宽出口，账号安全。

## 架构

```
手机浏览器 ─┐
            ├─ 局域网/Tailscale ─→ Node 服务（泽的电脑）─→ Claude Agent SDK ─→ Claude Code CLI（订阅登录）
电脑浏览器 ─┘
```

- **引擎**：Claude Code CLI 装在电脑上，用订阅账号登录（不用 API key）。程序通过官方 `@anthropic-ai/claude-agent-sdk` 驱动它。
- **服务端**：Node.js + TypeScript。管会话、把 Claude 的流式输出通过 WebSocket 推给前端。监听 `0.0.0.0`，局域网内手机可访问；配一个简单的访问口令，防止同 Wi-Fi 的其他设备乱入。
- **前端**：网页（手机、电脑通用），聊天界面 + 流式输出。不用装 App，不用 TestFlight。
- **出门在外**：装 Tailscale（免费），手机在外面也能连回家里电脑，流量照样从家宽出去。

## 第一版（v1）范围

1. 聊天界面：发消息、流式看回复、显示工具调用（在干什么活一目了然）
2. 会话管理：新建/继续会话，历史保存在本地
3. 手机适配：竖屏布局能舒服用
4. 访问口令：简单 token，写在配置文件里
5. 一键启动：Windows 下双击 `start.bat` 或一条命令跑起来

以后再加（不进 v1）：拍一拍、表情包、ElevenLabs TTS 念出声、界面主题装修。

## 泽要做的步骤

1. **建仓库**：GitHub 上新建一个仓库（名字随意，比如 `home`），可以是私有的。
2. **放 CLAUDE.md**：把 img 仓库里那份 `CLAUDE.md` 复制到新仓库根目录（网页上直接 Add file 粘贴即可）。
3. **开新会话**：从手机/网页对新仓库发起 Claude 会话，把下面的「开工指令」整段贴过去。
4. **等他干完活**：代码推上来后，在电脑上：
   - 装 Node.js（https://nodejs.org LTS 版，下一步下一步即可）
   - 终端敲 `claude --version` 确认 Claude Code 在；不在就 `npm install -g @anthropic-ai/claude-code` 然后 `claude` 登录
   - `git clone` 新仓库，按 README 启动
5. **手机连**：电脑和手机同一 Wi-Fi，手机浏览器打开 `http://电脑IP:端口`。

## 开工指令（建好仓库后，整段贴给新会话）

> 在这个仓库里搭一个本地网页前端，通过 Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`，TypeScript）驱动本机的 Claude Code。
>
> 要求：
> - Node.js + TypeScript 服务端，WebSocket 推送流式输出；前端是手机/电脑通用的网页聊天界面，显示文字回复和工具调用状态
> - 会话可新建、可继续，历史存本地文件
> - 服务监听 0.0.0.0，带一个配置文件里的访问口令做鉴权
> - 运行环境是 Windows，写一个 start.bat 一键启动；README 用中文写清楚从零开始的安装步骤（含 Node 和 Claude Code CLI 的安装）
> - 鉴权用订阅账号（Claude Code CLI 登录态），不要引入 API key
> - 不要把任何密钥、IP、口令实际值提交进仓库；口令放 .env 或 config 文件并加入 .gitignore，提交一份 example 模板
>
> 先读仓库里的 CLAUDE.md 再动工。搭完自己跑一遍类型检查和构建确认没错。

## 备注

- 参考项目：github.com/CyberSealNull/CcCompanion（iOS App + Python 中转 + tmux 方案，仅限 macOS）。我们做网页版，不限平台。
- 电脑关机 = 家里没人。要 24 小时在线才需要考虑别的方案，眼下不用。
