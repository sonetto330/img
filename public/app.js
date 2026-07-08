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
let liveThinking = null; // 正在流式输出的思考卡片

// —— WebSocket ——
function connect() {
  statusTextEl.textContent = "连接中…";
  dotEl.classList.add("off");
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onopen = () => {
    dotEl.classList.remove("off");
    if (!busy) statusTextEl.textContent = "在线";
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    dotEl.classList.add("off");
    if (!busy) statusTextEl.textContent = "已断线，重连中…";
    setTimeout(connect, 1500);
  };
}

function handle(msg) {
  switch (msg.type) {
    case "session":
      sessionId = msg.sessionId;
      localStorage.setItem("home_session", sessionId);
      break;
    case "thinking":
      hideTyping();
      if (!liveThinking) {
        maybeStamp();
        liveThinking = newThinkingCard();
      }
      liveThinking.append(msg.text);
      break;
    case "thinking_done":
      liveThinking?.finish(msg.ms);
      break;
    case "delta":
      hideTyping();
      if (!liveBubble) {
        maybeStamp();
        liveBubble = addBubble("ta", "");
      }
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
        maybeStamp();
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
  liveThinking = null;
  hideTyping();
  dotEl.classList.remove("busy");
  statusTextEl.textContent = "在线";
  sendBtn.hidden = false;
  stopBtn.hidden = true;
  scrollDown();
}

// —— 思考卡片（"思考了 X.Xs"，点开看他想了什么） ——
function newThinkingCard(saved) {
  const box = document.createElement("div");
  box.className = "thinking";
  const head = document.createElement("button");
  head.className = "thinking-head";
  const label = document.createElement("span");
  label.className = "thinking-label";
  label.textContent = "思考中…";
  head.appendChild(label);
  const body = document.createElement("div");
  body.className = "thinking-body";
  body.hidden = true;
  head.onclick = () => {
    body.hidden = !body.hidden;
    head.classList.toggle("open", !body.hidden);
    scrollDown();
  };
  box.append(head, body);
  messagesEl.appendChild(box);

  // 翻译按钮：思考多为英文，点一下翻中文，再点切回原文
  let original = null; // 非 null 表示当前显示的是译文
  let translated = null;
  const tx = document.createElement("button");
  tx.className = "thinking-tx";
  tx.textContent = "译";
  tx.onclick = async (e) => {
    e.stopPropagation(); // 别顺手把卡片折叠了
    if (original !== null) {
      body.textContent = original;
      original = null;
      tx.textContent = "译";
      return;
    }
    if (!translated) {
      tx.textContent = "…";
      try {
        const res = await fetch(`/api/translate?token=${encodeURIComponent(token)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: body.textContent }),
        });
        if (!res.ok) throw new Error((await res.json()).error || "翻译失败");
        translated = (await res.json()).text;
      } catch (err) {
        tx.textContent = "译";
        return addBubble("error", err.message);
      }
    }
    original = body.textContent;
    body.textContent = translated;
    tx.textContent = "原";
    body.hidden = false;
    head.classList.add("open");
  };

  const card = {
    el: box,
    append(text) {
      box.classList.add("live");
      body.textContent += text;
      scrollDown();
    },
    finish(ms) {
      box.classList.remove("live");
      label.textContent = `思考了 ${(ms / 1000).toFixed(1)}s`;
      if (body.textContent && !tx.isConnected) head.appendChild(tx);
    },
  };
  if (saved) {
    body.textContent = saved.text;
    card.finish(saved.ms);
  }
  return card;
}

// —— 工具卡片（一步一张卡，点开看细节） ——
const TOOL_ICONS = [
  ["read", "📄"], ["glob", "🗂"], ["grep", "🔍"], ["search", "🌐"], ["fetch", "🌐"],
  ["edit", "✏️"], ["write", "📝"], ["bash", "💻"], ["task", "🤖"], ["agent", "🤖"],
  ["todo", "📋"], ["notebook", "📓"],
];
function toolIcon(name) {
  const n = name.toLowerCase();
  for (const [key, icon] of TOOL_ICONS) if (n.includes(key)) return icon;
  return "🔧";
}
// mcp__ombre__hold 这类内部名字太丑，剥掉外皮只留人能看的部分
function toolLabel(name) {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  return m ? `${m[2]} · ${m[1]}` : name;
}

function newToolbox() {
  const box = document.createElement("div");
  box.className = "steps";
  // 总开关：默认收起，头上滚动显示步数和当前动作，点开才展开一步步的卡片
  const head = document.createElement("button");
  head.className = "steps-head";
  const count = document.createElement("span");
  count.className = "steps-count";
  const brief = document.createElement("span");
  brief.className = "step-brief";
  head.append(count, brief);
  const list = document.createElement("div");
  list.className = "steps-list";
  list.hidden = true;
  head.onclick = () => {
    list.hidden = !list.hidden;
    head.classList.toggle("open", !list.hidden);
    scrollDown();
  };
  box.append(head, list);
  messagesEl.appendChild(box);
  let n = 0;
  return {
    add(tool) {
      n++;
      count.textContent = `🛠 ${n} 步操作`;
      brief.textContent = toolLabel(typeof tool === "string" ? tool : tool.name);
      const name = typeof tool === "string" ? tool : tool.name;
      const detail = typeof tool === "string" ? undefined : tool.detail;
      const row = document.createElement("div");
      row.className = "step";
      const rowHead = document.createElement("button");
      rowHead.className = "step-head";
      const icon = document.createElement("span");
      icon.className = "step-icon";
      icon.textContent = toolIcon(name);
      const nm = document.createElement("span");
      nm.className = "step-name";
      nm.textContent = toolLabel(name);
      rowHead.append(icon, nm);
      row.appendChild(rowHead);
      if (detail) {
        const rowBrief = document.createElement("span");
        rowBrief.className = "step-brief";
        const firstLine = detail.split("\n")[0];
        rowBrief.textContent = firstLine.length > 46 ? firstLine.slice(0, 46) + "…" : firstLine;
        rowHead.appendChild(rowBrief);
        const body = document.createElement("div");
        body.className = "step-body";
        body.textContent = detail;
        body.hidden = true;
        row.appendChild(body);
        rowHead.classList.add("has-body");
        rowHead.onclick = () => {
          body.hidden = !body.hidden;
          rowHead.classList.toggle("open", !body.hidden);
          scrollDown();
        };
      }
      list.appendChild(row);
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

// —— 时间戳：两条消息隔了 10 分钟以上，中间插一行居中小字 ——
const STAMP_GAP = 10 * 60 * 1000;
let lastStampTime = 0;

function fmtStamp(d) {
  const now = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hhmm;
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return `昨天 ${hhmm}`;
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  if (d.getFullYear() === now.getFullYear()) return `${md} ${hhmm}`;
  return `${d.getFullYear()}年${md} ${hhmm}`;
}

// at 不传就是"现在"（正在发生的消息）；历史消息传存下来的时间
function maybeStamp(at) {
  const t = at ? new Date(at).getTime() : Date.now();
  if (!Number.isFinite(t)) return;
  if (t - lastStampTime >= STAMP_GAP) {
    const div = document.createElement("div");
    div.className = "msg stamp";
    div.textContent = fmtStamp(new Date(t));
    messagesEl.appendChild(div);
  }
  lastStampTime = t;
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
  const ready = pending.filter((p) => !p.uploading);
  if ((!text && ready.length === 0) || busy || !ws || ws.readyState !== 1) return;
  if (pending.some((p) => p.uploading)) return addBubble("error", "附件还在上传，稍等一下");
  const attachments = ready.map(({ _thumb, ...att }) => att);
  maybeStamp();
  const bubble = addBubble("me", text);
  // attachToBubble 的 before 是插最前面，倒着喂才能保持选择顺序
  for (const att of [...ready].reverse()) attachToBubble(bubble, att, true);
  clearPending();
  inputEl.value = "";
  autoGrow();
  busy = true;
  dotEl.classList.add("busy");
  statusTextEl.textContent = "正在干活…";
  sendBtn.hidden = true;
  stopBtn.hidden = false;
  showTyping();
  ws.send(JSON.stringify({ type: "chat", sessionId, text, attachments, model: modelSelect.value || undefined }));
  // 你刚发了消息，肯定想看到，无条件贴底
  forceScrollDown();
}

// —— 附件（可多个）——
const fileInput = $("fileInput");
const pendingBar = $("pendingBar");
let pending = []; // [{ file, name, kind, _thumb }]

$("attachBtn").onclick = () => fileInput.click(); // 手机上会弹相册/拍照/文件三选一
fileInput.onchange = () => pickFiles(fileInput);

async function pickFiles(input) {
  const files = Array.from(input.files);
  input.value = "";
  for (const f of files) {
    if (f.size > 30 * 1024 * 1024) {
      addBubble("error", `「${f.name}」太大，上限 30MB`);
      continue;
    }
    // 先占位显示"上传中"，传完原地替换
    const chip = { name: f.name, uploading: true };
    pending.push(chip);
    renderPending();
    try {
      const res = await fetch(`/api/upload?token=${encodeURIComponent(token)}&name=${encodeURIComponent(f.name)}`, {
        method: "POST",
        body: f,
      });
      if (!res.ok) throw new Error((await res.json()).error || "上传失败");
      const att = await res.json();
      if (att.kind === "image") att._thumb = URL.createObjectURL(f);
      pending[pending.indexOf(chip)] = att;
    } catch (e) {
      pending = pending.filter((p) => p !== chip);
      addBubble("error", `「${f.name}」上传失败：${e.message}`);
    }
    renderPending();
  }
}

function renderPending() {
  pendingBar.innerHTML = "";
  pendingBar.hidden = pending.length === 0;
  for (const att of pending) {
    const chip = document.createElement("div");
    chip.className = "pending-chip";
    if (att.uploading) {
      chip.classList.add("uploading");
      chip.textContent = `${att.name} 上传中…`;
    } else {
      if (att._thumb) {
        const img = document.createElement("img");
        img.src = att._thumb;
        chip.appendChild(img);
      } else {
        const icon = document.createElement("span");
        icon.className = "chip-icon";
        icon.textContent = "📄";
        chip.appendChild(icon);
      }
      const name = document.createElement("span");
      name.className = "chip-name";
      name.textContent = att.name;
      chip.appendChild(name);
      const rm = document.createElement("button");
      rm.className = "chip-remove";
      rm.textContent = "✕";
      rm.setAttribute("aria-label", `移除 ${att.name}`);
      rm.onclick = () => {
        pending = pending.filter((p) => p !== att);
        renderPending();
      };
      chip.appendChild(rm);
    }
    pendingBar.appendChild(chip);
  }
}

function clearPending() {
  pending = [];
  renderPending();
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

// —— 模型切换：不选就用服务端默认，选了记在本机 ——
const modelSelect = $("modelSelect");
modelSelect.value = localStorage.getItem("home_model") || "";
if (modelSelect.value !== (localStorage.getItem("home_model") || "")) {
  // 存的值已经不在选项里（比如以后下架了），回落到默认
  modelSelect.value = "";
  localStorage.removeItem("home_model");
}
modelSelect.onchange = () => {
  if (modelSelect.value) localStorage.setItem("home_model", modelSelect.value);
  else localStorage.removeItem("home_model");
};

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
  maybeStamp();
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
document.querySelector(".who").addEventListener("dblclick", sendPat);

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
    lastStampTime = 0;
  }
  loadSessions();
}

// 一条消息的渲染逻辑，openSession 和"查看更早"复用同一份
function renderMessage(m) {
  if (m.at) maybeStamp(m.at);
  if (m.thinking?.text) newThinkingCard(m.thinking);
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

// 分段渲染：会话超长时先只上最近 50 条 DOM，其他留在内存里等按钮拉
const CHAT_CHUNK = 50;
let pendingOlderMessages = null;

function addLoadOlderButton() {
  const existing = document.getElementById("loadOlderBtn");
  if (existing) existing.remove();
  const btn = document.createElement("button");
  btn.id = "loadOlderBtn";
  btn.className = "load-older";
  const n = Math.min(CHAT_CHUNK, pendingOlderMessages?.length || 0);
  btn.textContent = `查看更早的 ${n} 条`;
  btn.onclick = loadOlder;
  // 放到消息区最上面
  messagesEl.insertBefore(btn, messagesEl.firstChild);
}

function loadOlder() {
  if (!pendingOlderMessages?.length) return;
  const before = messagesEl.scrollHeight;
  const chunk = pendingOlderMessages.slice(-CHAT_CHUNK);
  pendingOlderMessages = pendingOlderMessages.slice(0, -CHAT_CHUNK);

  // 保住现有 DOM，清空后按"更早 → 现有"顺序重排；比 insertBefore 一条条插省心
  const saved = Array.from(messagesEl.children).filter((n) => n.id !== "loadOlderBtn");
  messagesEl.innerHTML = "";
  // 还有更早的 → 顶部继续放按钮
  if (pendingOlderMessages.length > 0) addLoadOlderButton();
  // 时间戳基准从头算（这段更早），渲染完恢复到原来的（最新消息的时间），
  // 不然下一条新消息会拿"更早那段"当基准，多插一行也可能少插一行
  const savedStampTime = lastStampTime;
  lastStampTime = 0;
  for (const m of chunk) renderMessage(m);
  lastStampTime = savedStampTime;
  for (const node of saved) messagesEl.appendChild(node);

  // 视野不跳：把 scrollTop 加上新增内容的高度差
  const after = messagesEl.scrollHeight;
  messagesEl.scrollTop += (after - before);
}

async function openSession(id) {
  const record = await api(`/api/sessions/${id}`);
  sessionId = record.id;
  localStorage.setItem("home_session", sessionId);
  messagesEl.innerHTML = "";
  pendingOlderMessages = null;
  lastStampTime = 0;

  const all = record.messages;
  if (all.length > CHAT_CHUNK) {
    pendingOlderMessages = all.slice(0, -CHAT_CHUNK);
    addLoadOlderButton();
    for (const m of all.slice(-CHAT_CHUNK)) renderMessage(m);
  } else {
    for (const m of all) renderMessage(m);
  }

  forceScrollDown();
  closeDrawer();
  loadSessions();
}

$("newChat").onclick = () => {
  sessionId = null;
  localStorage.removeItem("home_session");
  messagesEl.innerHTML = "";
  pendingOlderMessages = null;
  lastStampTime = 0;
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
const memoryViewEl = $("memoryView");
const bottomNavEl = $("bottomNav");

function showView(name) {
  homeViewEl.hidden = name !== "home";
  chatViewEl.hidden = name !== "chat";
  memoryViewEl.hidden = name !== "memory";
  // 聊天和星图都要占满屏，底部导航让位；首页导航常驻
  bottomNavEl.hidden = name === "chat" || name === "memory";
  for (const btn of bottomNavEl.querySelectorAll(".nav-btn")) {
    btn.classList.toggle("active", btn.dataset.view === name);
  }
  if (name === "home") updateGreeting();
  if (name === "memory") loadMemoryGraph();
  if (name === "chat") {
    // 视图刚显示，浏览器还没做布局，scrollHeight 可能是 0。
    // 等一帧让布局完成再贴底，否则永远停在顶。
    requestAnimationFrame(() => requestAnimationFrame(forceScrollDown));
  }
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
    else if (route === "memory") showView("memory");
  };
}

$("backHome").onclick = () => showView("home");
$("memoryBack").onclick = () => showView("home");

// —— 记忆星图 ——
// 星图渲染在 starmap.js 里（另一个 <script> 标签），通过 window 共享数据
async function loadMemoryGraph() {
  try {
    const graph = await api("/api/memory/graph");
    window.memoryGraph = graph;
    const n = graph.entities?.length || 0;
    $("memoryMeta").textContent = n
      ? `${n} 个星座 · ${graph.links.length} 条桥`
      : "";
    $("memoryEmpty").hidden = n > 0;
    if (typeof window.attachStarmapGestures === "function") window.attachStarmapGestures();
    if (typeof window.renderStarmap === "function") window.renderStarmap();
  } catch {
    $("memoryEmpty").hidden = false;
    $("memoryMeta").textContent = "";
  }
}

$("detailClose").onclick = () => { $("memoryDetail").hidden = true; };

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
