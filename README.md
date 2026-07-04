# 家

泽和麦穗的自建前端。网页界面（手机、电脑都能用）接本机的 Claude Code，跑在自己电脑上，不用 VPS，所有流量从家宽出口。

## 原理

```
手机/电脑浏览器 ── Wi-Fi ──→ Node 服务（这台电脑）──→ Claude Agent SDK ──→ Claude Code CLI（订阅登录）
```

## 从零开始（Windows）

### 1. 装 Node.js

去 https://nodejs.org 下载 LTS 版，一路下一步。装完开个终端（Win+R 输入 `cmd`）确认：

```
node -v
```

### 2. 装 Claude Code 并登录

```
npm install -g @anthropic-ai/claude-code
claude
```

第一次运行 `claude` 会引导浏览器登录订阅账号。已经装过的话跑一下 `claude update` 升级即可。

### 3. 拿到代码

```
git clone https://github.com/sonetto330/img.git home
cd home
```

（没装 git 的话，GitHub 页面上 Code → Download ZIP 解压也行。）

### 4. 配置口令

把 `.env.example` 复制一份改名为 `.env`，用记事本打开，把 `ACCESS_TOKEN` 改成自己编的口令。

**国内网络注意**：黑窗口里的程序默认不走梯子，直连 Anthropic 会报 `403 Request not allowed`。要么把梯子开成 TUN 模式（全局接管，推荐），要么把 `.env` 里 `HTTPS_PROXY` / `HTTP_PROXY` 两行的 `#` 去掉并改成梯子的本地端口（Clash 一般 7890，v2rayN 一般 10808）。

### 5. 启动

双击 `start.bat`（第一次会自动装依赖，等一会儿）。看到「家开门了」就成了。

Windows 防火墙第一次会弹窗问是否允许 Node 联网——勾选「专用网络」并允许，手机才能连进来。

### 6. 手机连

手机和电脑连同一个 Wi-Fi。电脑终端输 `ipconfig` 找到「IPv4 地址」（一般是 192.168.x.x），手机浏览器打开：

```
http://192.168.x.x:3000
```

输入口令，进门。可以用浏览器的「添加到主屏幕」把它变成一个 App 图标。

## 人设

把 `CLAUDE.md`（人设和说话方式）放进**工作目录**（默认是项目下的 `workspace` 文件夹），每次对话都会自动读取。仓库根目录已有一份，复制过去即可：

```
copy CLAUDE.md workspace\CLAUDE.md
```

## 可选功能

**Bark 手机推送**：手机 App Store 搜 Bark，装完 App 里会给一串 key，填进 `.env` 的 `BARK_KEY`。页面没打开时麦穗回复完会推一条通知到手机，不填就整个关掉。

**ElevenLabs 念出声**：气泡右下角的 🔊 按钮，用你在 ElevenLabs 后台选好的音色念麦穗的回复。`.env` 里填 `ELEVENLABS_KEY`（API key）和 `ELEVENLABS_VOICE`（voice id）。**按字符扣额度**——每点一次 🔊 都算钱，别拿超长回复反复点。正文超过 500 字会自动截断，代码块会被剥掉不念。

## 出门在外也想用？

装 [Tailscale](https://tailscale.com)（免费）：电脑和手机各装一个，登录同一账号，手机用 Tailscale 分配的 IP 访问即可。流量走加密隧道回家，从家宽出口，不经过任何第三方服务器。

## 注意

- `.env`（口令）、`data/`（聊天记录）、`workspace/` 都不会被提交到 git。
- 默认 `PERMISSION_MODE=bypassPermissions`：Claude 在工作目录里全自动干活，不逐条确认。只在自己电脑、自己账号下这样用；介意的话在 `.env` 里改成 `acceptEdits`。
- 电脑关机 = 家里没人。手机端会自动重连，电脑开机重新跑 `start.bat` 就行。

## 以后想加的

拍一拍 · 表情包 · ElevenLabs TTS 念出声 · Markdown 渲染 · 主题装修
