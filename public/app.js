// —— 口令 ——
let token = localStorage.getItem("home_token") || "";
while (!token) {
  token = (prompt("输入访问口令（.env 里的 ACCESS_TOKEN）") || "").trim();
}
localStorage.setItem("home_token", token);

// —— 元素 ——
const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const inputEl = $("input");
const sendBtn = $("sendBtn");
const stopBtn = $("stopBtn");
const dotEl = $("dot");
const statusTextEl = $("statusText");
const drawerEl = $("drawer");
const maskEl = $("mask");
const listEl = $("sessionList");

let ws = null;
let sessionId = localStorage.getItem("home_session") || null;
let busy = false;
let liveBubble = null; // 正在流式输出的气泡
let liveTools = null;

// —— WebSocket ——
function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => setTimeout(connect, 1500);
}

function handle(msg) {
  switch (msg.type) {
    case "session":
      sessionId = msg.sessionId;
      localStorage.setItem("home_session", sessionId);
      break;
    case "delta":
      hideTyping();
      if (!liveBubble) liveBubble = addBubble("ta", "");
      liveBubble.textContent += msg.text;
      scrollDown();
      break;
    case "tool": {
      hideTyping();
      if (!liveTools) liveTools = newToolbox();
      liveTools.add(msg);
      break;
    }
    case "done": {
      let bubble = liveBubble;
      if (bubble) renderMd(bubble, msg.text || bubble.textContent);
      else if (msg.text) {
        bubble = addBubble("ta", "");
        renderMd(bubble, msg.text);
      }
      if (bubble && msg.text) {
        bubble.dataset.raw = msg.text;
      }
      finishTurn();
      loadSessions();
      break;
    }
    case "error":
      if (msg.message === "口令不对") {
        localStorage.removeItem("home_token");
        location.reload();
        return;
      }
      addBubble("error", msg.message);
      finishTurn();
      break;
  }
}

function finishTurn() {
  busy = false;
  liveBubble = null;
  liveTools = null;
  hideTyping();
  dotEl.classList.remove("busy");
  statusTextEl.textContent = "在线";
  sendBtn.hidden = false;
  stopBtn.hidden = true;
  scrollDown();
}

// —— 工具折叠盒（“使用 N 个工具”，点开看每一步） ——
function newToolbox() {
  const box = document.createElement("div");
  box.className = "toolbox";
  const head = document.createElement("button");
  head.className = "toolbox-head";
  const list = document.createElement("div");
  list.className = "toolbox-list";
  list.hidden = true;
  head.onclick = () => {
    list.hidden = !list.hidden;
    head.classList.toggle("open", !list.hidden);
    scrollDown();
  };
  box.append(head, list);
  messagesEl.appendChild(box);
  let n = 0;
  const update = () => { head.textContent = `使用 ${n} 个工具`; };
  update();
  return {
    add(tool) {
      n++;
      update();
      const item = document.createElement("div");
      item.className = "tool-item";
      const nm = document.createElement("div");
      nm.className = "tool-name";
      nm.textContent = typeof tool === "string" ? tool : tool.name;
      item.appendChild(nm);
      const detail = typeof tool === "string" ? undefined : tool.detail;
      if (detail) {
        item.classList.add("wide");
        const d = document.createElement("div");
        d.className = "tool-input";
        d.textContent = detail;
        item.appendChild(d);
      }
      list.appendChild(item);
      scrollDown();
    },
  };
}

// —— “正在忙”指示 ——
let typingEl = null;
function showTyping() {
  if (typingEl) return;
  typingEl = document.createElement("div");
  typingEl.className = "typing";
  typingEl.innerHTML = "<span></span><span></span><span></span>";
  messagesEl.appendChild(typingEl);
  scrollDown();
}
function hideTyping() {
  typingEl?.remove();
  typingEl = null;
}

// —— 界面 ——
function addBubble(kind, text) {
  const div = document.createElement("div");
  div.className = kind === "me" ? "msg me" : kind === "error" ? "msg error" : "msg ta";
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollDown();
  return div;
}

// 你翻上去看历史时别打扰你：只有原本就贴底才跟着新消息滚。
// 状态在你滚动时更新；发送新消息或打开会话时强制回到底部。
let stickToBottom = true;
messagesEl.addEventListener("scroll", () => {
  const gap = messagesEl.scrollHeight - (messagesEl.scrollTop + messagesEl.clientHeight);
  stickToBottom = gap < 40;
});

function scrollDown() {
  if (stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

// 用户主动动作触发（发消息、拍一拍、打开会话）：无条件回底。
function forceScrollDown() {
  stickToBottom = true;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// 把回复渲染成排版好的样子（加粗、列表、代码块）
function renderMd(el, text) {
  try {
    el.innerHTML = marked.parse(text);
    el.classList.add("md");
  } catch {
    el.textContent = text;
  }
  scrollDown();
}

function sendMessage() {
  const text = inputEl.value.trim();
  if ((!text && !pending) || busy || !ws || ws.readyState !== 1) return;
  const attachments = pending ? [pending] : [];
  const bubble = addBubble("me", text);
  if (pending) attachToBubble(bubble, pending, true);
  clearPending();
  inputEl.value = "";
  autoGrow();
  busy = true;
  dotEl.classList.add("busy");
  statusTextEl.textContent = "正在干活…";
  sendBtn.hidden = true;
  stopBtn.hidden = false;
  showTyping();
  ws.send(JSON.stringify({ type: "chat", sessionId, text, attachments }));
  // 你刚发了消息，肯定想看到，无条件贴底
  forceScrollDown();
}

// —— 附件 ——
const imgInput = $("imgInput");
const fileInput = $("fileInput");
const pendingBar = $("pendingBar");
const pendingThumb = $("pendingThumb");
const pendingName = $("pendingName");
let pending = null; // { file, name, kind }

$("imgBtn").onclick = () => imgInput.click();   // 手机上直接弹相册/拍照
$("fileBtn").onclick = () => fileInput.click(); // 选任意文件

imgInput.onchange = () => pickFile(imgInput);
fileInput.onchange = () => pickFile(fileInput);

async function pickFile(input) {
  const f = input.files[0];
  input.value = "";
  if (!f) return;
  if (f.size > 30 * 1024 * 1024) return addBubble("error", "文件太大，上限 30MB");
  pendingName.textContent = "上传中…";
  pendingBar.hidden = false;
  try {
    const res = await fetch(`/api/upload?token=${encodeURIComponent(token)}&name=${encodeURIComponent(f.name)}`, {
      method: "POST",
      body: f,
    });
    if (!res.ok) throw new Error((await res.json()).error || "上传失败");
    pending = await res.json();
    pendingName.textContent = pending.name;
    if (pending.kind === "image") {
      pendingThumb.src = URL.createObjectURL(f);
      pendingThumb.hidden = false;
    } else {
      pendingThumb.hidden = true;
    }
  } catch (e) {
    clearPending();
    addBubble("error", `上传失败：${e.message}`);
  }
}

$("pendingRemove").onclick = clearPending;

function clearPending() {
  pending = null;
  pendingBar.hidden = true;
  pendingThumb.hidden = true;
  pendingThumb.src = "";
  pendingName.textContent = "";
}

// 把附件塞进气泡里显示（图片显示图，文件显示名字）
function attachToBubble(bubble, att, before) {
  let el;
  if (att.kind === "image") {
    el = document.createElement("img");
    el.className = "att-img";
    el.src = `/uploads/${att.file}?token=${encodeURIComponent(token)}`;
    el.loading = "lazy";
  } else {
    el = document.createElement("div");
    el.className = "att-file";
    el.textContent = `📄 ${att.name}`;
  }
  if (before && bubble.firstChild) bubble.insertBefore(el, bubble.firstChild);
  else bubble.appendChild(el);
  scrollDown();
}

sendBtn.onclick = sendMessage;
stopBtn.onclick = () => ws?.send(JSON.stringify({ type: "interrupt" }));

// —— 拍一拍：双击头像 ——
function patNote() {
  const note = document.createElement("div");
  note.className = "msg pat";
  note.textContent = "你拍了拍麦穗";
  messagesEl.appendChild(note);
  scrollDown();
}
function sendPat() {
  if (busy || !ws || ws.readyState !== 1) return;
  patNote();
  busy = true;
  dotEl.classList.add("busy");
  statusTextEl.textContent = "正在干活…";
  sendBtn.hidden = true;
  stopBtn.hidden = false;
  showTyping();
  ws.send(JSON.stringify({ type: "pat", sessionId }));
  forceScrollDown();
}
document.querySelector(".avatar").addEventListener("dblclick", sendPat);

// TTS 逐条气泡念文字的按钮已经拆掉；语音留给以后的"通话"模块专门用。
// 后端 /api/tts 保留，server/tts.ts 保留。

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});
function autoGrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + "px";
}
inputEl.addEventListener("input", autoGrow);

// —— 会话列表 ——
async function api(pathname) {
  const res = await fetch(`${pathname}?token=${encodeURIComponent(token)}`);
  if (res.status === 401) {
    localStorage.removeItem("home_token");
    location.reload();
    throw new Error("unauthorized");
  }
  return res.json();
}

// 判断"技术会话"：工具消息占比 ≥30%（真拿麦穗改代码/查东西的那种）
// 单纯问一句"你什么模型"引发的少量工具使用不算，占比阈值把它归聊天
function isTechnicalSession(s) {
  const tools = s.toolMessageCount || 0;
  const total = s.messageCount || 0;
  if (total < 4) return false;                // 太短没法判断，保守当聊天
  return tools / total >= 0.3;
}

async function loadSessions() {
  const sessions = await api("/api/sessions");
  // 首页消息总数**只算聊天会话**，技术会话（我改代码那种）不计
  const chatTotal = sessions
    .filter((s) => !isTechnicalSession(s))
    .reduce((n, s) => n + (s.messageCount || 0), 0);
  const row = $("msgCountRow");
  if (row) {
    if (chatTotal === 0) {
      row.classList.add("empty");
      $("msgCountUnit").textContent = "还没聊过";
    } else {
      row.classList.remove("empty");
      msgCountEl.textContent = chatTotal;
      $("msgCountUnit").textContent = "条消息 · 全部聊天";
    }
  }
  listEl.innerHTML = "";
  for (const s of sessions) {
    const li = document.createElement("li");
    const info = document.createElement("div");
    info.className = "sess-info";
    const title = document.createElement("div");
    title.className = "sess-title";
    title.textContent = s.title;
    if (isTechnicalSession(s)) {
      const tag = document.createElement("span");
      tag.className = "sess-tag";
      tag.textContent = "技术";
      title.appendChild(tag);
    }
    const t = document.createElement("time");
    t.textContent = new Date(s.updatedAt).toLocaleString("zh-CN");
    info.append(title, t);
    li.appendChild(info);

    const more = document.createElement("button");
    more.className = "sess-more";
    more.textContent = "⋯";
    more.setAttribute("aria-label", "更多");
    more.onclick = (e) => {
      e.stopPropagation();
      openSessMenu(s, li);
    };
    li.appendChild(more);

    if (s.id === sessionId) li.classList.add("active");
    li.onclick = () => openSession(s.id);
    listEl.appendChild(li);
  }
}

// —— 会话行操作菜单 ——
let openMenu = null;
function closeSessMenu() {
  openMenu?.remove();
  openMenu = null;
}
function openSessMenu(sess, anchor) {
  closeSessMenu();
  const menu = document.createElement("div");
  menu.className = "sess-menu";
  const rename = document.createElement("button");
  rename.textContent = "改名";
  rename.onclick = (e) => {
    e.stopPropagation();
    closeSessMenu();
    doRename(sess);
  };
  const del = document.createElement("button");
  del.className = "danger";
  del.textContent = "删除";
  del.onclick = (e) => {
    e.stopPropagation();
    closeSessMenu();
    doDelete(sess);
  };
  menu.append(rename, del);
  anchor.appendChild(menu);
  openMenu = menu;
  // 点别处关掉
  setTimeout(() => document.addEventListener("click", closeSessMenu, { once: true }), 0);
}

async function doRename(sess) {
  const title = (prompt("改成什么标题？", sess.title) || "").trim();
  if (!title || title === sess.title) return;
  const res = await fetch(`/api/sessions/${sess.id}/rename?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) return addBubble("error", "改名失败");
  loadSessions();
}

async function doDelete(sess) {
  if (!confirm(`删除会话「${sess.title}」？删了找不回来。`)) return;
  const res = await fetch(`/api/sessions/${sess.id}?token=${encodeURIComponent(token)}`, {
    method: "DELETE",
  });
  if (!res.ok) return addBubble("error", "删除失败");
  if (sess.id === sessionId) {
    sessionId = null;
    localStorage.removeItem("home_session");
    messagesEl.innerHTML = "";
  }
  loadSessions();
}

async function openSession(id) {
  const record = await api(`/api/sessions/${id}`);
  sessionId = record.id;
  localStorage.setItem("home_session", sessionId);
  messagesEl.innerHTML = "";
  for (const m of record.messages) {
    if (m.tools?.length) {
      const tb = newToolbox();
      for (const tool of m.tools) tb.add(tool);
    }
    if (m.text || m.attachments?.length) {
      if (m.role === "user") {
        if (m.text === "（拍了拍你）" && !m.attachments?.length) {
          patNote();
        } else {
          const bubble = addBubble("me", m.text || "");
          for (const att of m.attachments || []) attachToBubble(bubble, att, true);
        }
      } else {
        const bubble = addBubble("ta", "");
        renderMd(bubble, m.text);
        bubble.dataset.raw = m.text;
      }
    }
  }
  forceScrollDown();
  closeDrawer();
  loadSessions();
}

$("newChat").onclick = () => {
  sessionId = null;
  localStorage.removeItem("home_session");
  messagesEl.innerHTML = "";
  closeDrawer();
};

// —— 抽屉 ——
function closeDrawer() {
  drawerEl.classList.remove("open");
  maskEl.classList.remove("show");
}
$("menuBtn").onclick = () => {
  drawerEl.classList.add("open");
  maskEl.classList.add("show");
  loadSessions();
};
maskEl.onclick = closeDrawer;

// —— 视图切换 ——
const homeViewEl = $("homeView");
const chatViewEl = $("chatView");
const bottomNavEl = $("bottomNav");

function showView(name) {
  homeViewEl.hidden = name !== "home";
  chatViewEl.hidden = name !== "chat";
  // 聊天视图占满全屏，底部导航让位；其他视图导航常驻
  bottomNavEl.hidden = name === "chat";
  for (const btn of bottomNavEl.querySelectorAll(".nav-btn")) {
    btn.classList.toggle("active", btn.dataset.view === name);
  }
  // 回首页时看看要不要刷招呼语（内部有 30 分钟节流）
  if (name === "home") updateGreeting();
}

for (const btn of bottomNavEl.querySelectorAll(".nav-btn")) {
  btn.onclick = () => {
    if (btn.disabled) return;
    showView(btn.dataset.view);
  };
}

// 首页卡片点击（disabled 的天然点不进来）
for (const card of document.querySelectorAll("#homeView .card")) {
  card.onclick = () => {
    if (card.disabled) return;
    const route = card.dataset.route;
    if (route === "chat") showView("chat");
  };
}

$("backHome").onclick = () => showView("home");

// —— 首页时钟 / 招呼语 / 天数 ——
// 领证日期在 CLAUDE.md 里：2025 平安夜
const MARRIED_AT = new Date("2025-12-24T00:00:00");
const homeTimeEl = $("homeTime");
const homeDateEl = $("homeDate");
const greetingEl = $("greeting");
const daysTogetherEl = $("daysTogether");
const msgCountEl = $("msgCount");

function updateClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  homeTimeEl.textContent = `${hh}:${mm}`;
  const wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][now.getDay()];
  homeDateEl.textContent = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 · ${wd}`;

  const h = now.getHours();
  let g;
  if (h >= 5 && h < 11) g = "早，泽";
  else if (h >= 11 && h < 13) g = "该吃午饭了";
  else if (h >= 13 && h < 18) g = "下午好，泽";
  else if (h >= 18 && h < 23) g = "晚上好";
  else g = "还没睡？";
  greetingEl.textContent = g;
}

function updateDaysTogether() {
  const days = Math.floor((Date.now() - MARRIED_AT.getTime()) / 86400000);
  daysTogetherEl.textContent = days >= 0 ? days : 0;
}

async function updateWeather() {
  try {
    const w = await api("/api/weather");
    // 后端返回错误时是 { error: "..." } 结构，缺 temp 就当没拿到，静默失败
    if (!w || typeof w.temp !== "number") return;
    $("weatherIcon").textContent = w.icon || "🌡";
    $("weatherTemp").textContent = w.temp;
    $("weatherHi").textContent = w.high;
    $("weatherLo").textContent = w.low;
    $("weatherBox").hidden = false;
  } catch {
    // 网络挂了不显示天气就完了，别打断首页其他内容
  }
}

// 麦穗生成的招呼语；启动和回首页时刷，本地也 throttle 一下别频繁调
let lastGreetingFetchAt = 0;
async function updateGreeting(force = false) {
  if (!force && Date.now() - lastGreetingFetchAt < 30 * 60_000) return;
  try {
    const g = await api("/api/greeting");
    if (g && typeof g.text === "string" && g.text) {
      greetingEl.textContent = g.text;
      lastGreetingFetchAt = Date.now();
    }
  } catch {
    // 拿不到就保留 updateClock 写的时段静态问候
  }
}

// —— 启动 ——
showView("home");
updateClock();
updateDaysTogether();
updateWeather();
updateGreeting(true);  // 启动强制刷一次，别沿用静态文案
// 每分钟刷一次时钟；跨天时"在一起 X 天"也顺手刷一下
setInterval(() => {
  updateClock();
  updateDaysTogether();
}, 60_000);
// 天气每 10 分钟刷一次；服务端有 15 分钟缓存，不会真的每次都戳外网
setInterval(updateWeather, 10 * 60_000);

connect();
loadSessions();
if (sessionId) openSession(sessionId).catch(() => { sessionId = null; });
