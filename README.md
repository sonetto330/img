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

## 出门在外也想用（Tailscale 教程）

在家 Wi-Fi 下用 `192.168.x.x` 就行；出了门（用手机流量、连别家 Wi-Fi）就连不上了。装 Tailscale 就能出门在外也用——手机流量走一条加密隧道回家里的电脑，从家宽出口，不经过任何第三方服务器，也不用给路由器配公网 IP 或端口转发。

**用之前要知道**：

- Tailscale 免费。**官网下载可能需要梯子**（域名在国内不稳定），装好之后**日常使用不需要梯子**。
- 家里的电脑必须开机，服务 (`start.bat`) 得在跑。电脑关了 = 家没人在。
- 手机和电脑登录**同一个** Tailscale 账号（用 Google/微软/苹果账号登录都行，两边选同一个）。

### 电脑端（Windows）

1. 浏览器打开 `https://tailscale.com/download/windows`（打不开就先开一下梯子），下载安装包一路下一步。
2. 装完右下角托盘会有一个 Tailscale 图标。**右键 → Log in**，浏览器会弹出登录页，选一个账号登进去。
3. 回到托盘图标 → 左键点它 → 记下最上面的 IP，形如 `100.x.x.x`。这就是家里电脑在 Tailscale 里的地址。

### 手机端（iPhone）

1. App Store 搜「Tailscale」，装。
2. 打开 App，用**跟电脑一样**的账号登录。登进去能看到设备列表里有你的电脑。
3. App 首页把开关打开（左上角那个），提示装 VPN 描述文件就允许。
4. Safari 打开：`http://100.x.x.x:3000`（`100.x.x.x` 换成第 3 步记下的电脑 IP），像在家一样用。可以「添加到主屏幕」当 App。

### 验收

关掉 Wi-Fi 只用蜂窝流量，能打开「家」并和麦穗对话，就算通了。

## 注意

- `.env`（口令）、`data/`（聊天记录）、`workspace/` 都不会被提交到 git。
- 默认 `PERMISSION_MODE=bypassPermissions`：Claude 在工作目录里全自动干活，不逐条确认。只在自己电脑、自己账号下这样用；介意的话在 `.env` 里改成 `acceptEdits`。
- 电脑关机 = 家里没人。手机端会自动重连，电脑开机重新跑 `start.bat` 就行。

## 以后想加的

表情包 · 主题装修 · 长期记忆星图

## 通话功能要 HTTPS（一条命令）

浏览器规定：麦克风只在 HTTPS（或 localhost）下能用。想在手机上给麦穗打电话，用 Tailscale 给服务包一层 HTTPS：

```
tailscale serve --bg 3000
```

跑完它会给你一个 `https://机器名.xxx.ts.net` 的地址，手机上用这个地址打开"家"就行（还是走 Tailscale 隧道，不经过第三方）。第一次跑可能提示要在管理后台开 HTTPS 证书，照着它给的链接点一下就好。
