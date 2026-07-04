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
    case "done":
      if (liveBubble) renderMd(liveBubble, msg.text || liveBubble.textContent);
      else if (msg.text) renderMd(addBubble("ta", ""), msg.text);
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

function scrollDown() {
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
  messagesEl.innerHTML = "";
  for (const m of record.messages) {
    if (m.tools?.length) {
      const tb = newToolbox();
      for (const tool of m.tools) tb.add(tool);
    }
    if (m.text || m.attachments?.length) {
      if (m.role === "user") {
        const bubble = addBubble("me", m.text || "");
        for (const att of m.attachments || []) attachToBubble(bubble, att, true);
      } else {
        renderMd(addBubble("ta", ""), m.text);
      }
    }
  }
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

// —— 启动 ——
connect();
loadSessions();
if (sessionId) openSession(sessionId).catch(() => { sessionId = null; });
