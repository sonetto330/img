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
const statusEl = $("status");
const drawerEl = $("drawer");
const maskEl = $("mask");
const listEl = $("sessionList");
const titleEl = $("title");

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
      if (!liveBubble) liveBubble = addBubble("ta", "");
      liveBubble.textContent += msg.text;
      scrollDown();
      break;
    case "tool": {
      if (!liveTools) {
        liveTools = document.createElement("div");
        liveTools.className = "tools";
        messagesEl.appendChild(liveTools);
      }
      const chip = document.createElement("span");
      chip.textContent = `🔧 ${msg.name}`;
      liveTools.appendChild(chip);
      scrollDown();
      break;
    }
    case "done":
      if (liveBubble) liveBubble.textContent = msg.text;
      else if (msg.text) addBubble("ta", msg.text);
      finishTurn();
      loadSessions();
      break;
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
  statusEl.classList.remove("busy");
  sendBtn.hidden = false;
  stopBtn.hidden = true;
  scrollDown();
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

function scrollDown() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || busy || !ws || ws.readyState !== 1) return;
  addBubble("me", text);
  inputEl.value = "";
  autoGrow();
  busy = true;
  statusEl.classList.add("busy");
  sendBtn.hidden = true;
  stopBtn.hidden = false;
  ws.send(JSON.stringify({ type: "chat", sessionId, text }));
}

sendBtn.onclick = sendMessage;
stopBtn.onclick = () => ws?.send(JSON.stringify({ type: "interrupt" }));
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

async function loadSessions() {
  const sessions = await api("/api/sessions");
  listEl.innerHTML = "";
  for (const s of sessions) {
    const li = document.createElement("li");
    li.textContent = s.title;
    const t = document.createElement("time");
    t.textContent = new Date(s.updatedAt).toLocaleString("zh-CN");
    li.appendChild(t);
    if (s.id === sessionId) li.classList.add("active");
    li.onclick = () => openSession(s.id);
    listEl.appendChild(li);
  }
}

async function openSession(id) {
  const record = await api(`/api/sessions/${id}`);
  sessionId = record.id;
  localStorage.setItem("home_session", sessionId);
  titleEl.textContent = record.title;
  messagesEl.innerHTML = "";
  for (const m of record.messages) {
    if (m.tools?.length) {
      const tools = document.createElement("div");
      tools.className = "tools";
      for (const name of m.tools) {
        const chip = document.createElement("span");
        chip.textContent = `🔧 ${name}`;
        tools.appendChild(chip);
      }
      messagesEl.appendChild(tools);
    }
    if (m.text) addBubble(m.role === "user" ? "me" : "ta", m.text);
  }
  closeDrawer();
  loadSessions();
}

$("newChat").onclick = () => {
  sessionId = null;
  localStorage.removeItem("home_session");
  titleEl.textContent = "家";
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

// —— 启动 ——
connect();
loadSessions();
if (sessionId) openSession(sessionId).catch(() => { sessionId = null; });
