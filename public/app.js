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
let pendingMode = null; // "议事厅"入口进来时是 "group"，随首条消息发出；后端只在新建会话时认
let chatArea = "solo"; // 当前聊天区："solo"=跟麦穗单聊（心形进），"group"=议事厅（工具页进）；抽屉列表按区过滤
let liveSpeaker = null; // 当前 live 气泡属于谁："gpt" 或 null（麦穗）
let gptHeadEl = null; // GPT 的名字头：gpt_start 先放上，delta 复用，沉默时收掉

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
        ensureTaHead();
        liveThinking = newThinkingCard();
      }
      liveThinking.append(msg.text);
      break;
    case "thinking_done":
      liveThinking?.finish(msg.ms);
      break;
    case "delta":
      hideTyping();
      if (msg.speaker === "gpt") {
        // 麦穗侧的 live 态还开着就先收口（正常时序他的 done 已经到了，这里是兜底）
        if (liveBubble && liveSpeaker !== "gpt") {
          renderMd(liveBubble, bubbleRawText.get(liveBubble) || "");
          liveBubble = null;
          liveTools = null;
          liveThinking = null;
        }
        if (!liveBubble) {
          maybeStamp();
          if (!gptHeadEl) gptHeadEl = addTaHead(undefined, "GPT");
          liveBubble = addBubble("gpt", "");
          liveSpeaker = "gpt";
        }
      } else if (!liveBubble) {
        maybeStamp();
        ensureTaHead();
        liveBubble = addBubble("ta", "");
      }
      setBubbleText(liveBubble, (bubbleRawText.get(liveBubble) || "") + msg.text);
      scrollDown();
      break;
    case "tool": {
      hideTyping();
      if (!liveTools) {
        ensureTaHead();
        liveTools = newToolbox();
      }
      liveTools.add(msg);
      break;
    }
    case "gpt_start": {
      // 麦穗说完了，GPT 轮开跑（子进程要几秒到几十秒）：挂上名字头等着，打断键保持可用
      hideTyping();
      busy = true;
      dotEl.classList.add("busy");
      statusTextEl.textContent = "GPT 正在输入…";
      sendBtn.hidden = true;
      stopBtn.hidden = false;
      maybeStamp();
      if (!gptHeadEl) gptHeadEl = addTaHead(undefined, "GPT");
      showTyping();
      break;
    }
    case "done": {
      if (msg.speaker === "gpt" && !msg.text) {
        // GPT 沉默或被打断：把名字头和空气泡收掉，别留空壳
        clearGptIndicator();
        finishTurn();
        loadSessions();
        break;
      }
      let bubble = liveBubble;
      if (bubble) renderMd(bubble, msg.text || bubbleRawText.get(bubble) || "");
      else if (msg.text) {
        maybeStamp();
        if (msg.speaker === "gpt") {
          if (!gptHeadEl) gptHeadEl = addTaHead(undefined, "GPT");
          bubble = addBubble("gpt", "");
        } else {
          ensureTaHead();
          bubble = addBubble("ta", "");
        }
        renderMd(bubble, msg.text);
      }
      finishTurn();
      loadSessions();
      break;
    }
    case "channel_fallback": {
      // 订阅额度用完，服务端换外部 API 重打这一轮；插一行居中小字说明
      const note = document.createElement("div");
      note.className = "chan-note";
      note.textContent = "订阅额度用完，这条走外部 API";
      messagesEl.appendChild(note);
      scrollDown();
      break;
    }
    // 会话自动瘦身：这轮上下文太重，服务端在后台压缩历史，聊过的都还在
    case "compact_start":
      addChanNote("这个会话有点重，正在自动瘦身…压完之后又快又省");
      break;
    case "compact_done":
      addChanNote("瘦身完成");
      break;
    case "compact_error":
      addChanNote(`瘦身没成功：${msg.message}`);
      break;
    case "error":
      if (msg.message === "口令不对") {
        localStorage.removeItem("home_token");
        location.reload();
        return;
      }
      // GPT 侧失败时麦穗的回复已经正常收完，只用收掉 GPT 的等待指示，别动他的气泡
      if (msg.speaker === "gpt") clearGptIndicator();
      addBubble("error", msg.message);
      finishTurn();
      break;
  }
}

// 把 GPT 的等待指示（名字头 + 还空着的 live 气泡）从页面上撤掉
// 已经吐过内容的气泡不动：打断发生在半截时，说出来的话留着
function clearGptIndicator() {
  if (liveSpeaker === "gpt" && liveBubble) {
    const raw = bubbleRawText.get(liveBubble) || "";
    if (raw) {
      renderMd(liveBubble, raw);
      gptHeadEl = null;
      return;
    }
    liveBubble.closest(".msg-group")?.remove();
    liveBubble = null;
  }
  gptHeadEl?.remove();
  gptHeadEl = null;
}

function finishTurn() {
  busy = false;
  liveBubble = null;
  liveTools = null;
  liveThinking = null;
  liveHead = false;
  liveSpeaker = null;
  gptHeadEl = null;
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
  const tIcon = document.createElement("span");
  tIcon.className = "t-icon";
  tIcon.innerHTML = ICONS.think;
  const label = document.createElement("span");
  label.className = "thinking-label";
  label.textContent = "思考中…";
  head.append(tIcon, label);
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

// —— 线条小图标（描边 SVG，颜色跟随文字，替掉五颜六色的 emoji） ——
const SVG = (d) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  think: SVG('<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3z"/>'),
  tools: SVG('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
  read: SVG('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
  glob: SVG('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
  grep: SVG('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/>'),
  web: SVG('<circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>'),
  edit: SVG('<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>'),
  bash: SVG('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>'),
  agent: SVG('<rect x="4" y="8" width="16" height="12" rx="2"/><line x1="12" y1="4" x2="12" y2="8"/><line x1="9" y1="13" x2="9" y2="15"/><line x1="15" y1="13" x2="15" y2="15"/>'),
  todo: SVG('<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><polyline points="4 5.5 5 6.5 6.5 4.5"/><polyline points="4 11.5 5 12.5 6.5 10.5"/><polyline points="4 17.5 5 18.5 6.5 16.5"/>'),
  copy: SVG('<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>'),
  copied: SVG('<polyline points="4 12 9 17 20 6"/>'),
  copyFail: SVG('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>'),
  trash: SVG('<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/>'),
};
const TOOL_ICON_KEYS = [
  ["read", "read"], ["glob", "glob"], ["grep", "grep"], ["search", "web"], ["fetch", "web"],
  ["edit", "edit"], ["write", "edit"], ["bash", "bash"], ["task", "agent"], ["agent", "agent"],
  ["todo", "todo"], ["notebook", "read"],
];
function toolIcon(name) {
  const n = name.toLowerCase();
  for (const [key, icon] of TOOL_ICON_KEYS) if (n.includes(key)) return ICONS[icon];
  return ICONS.tools;
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
  const headIcon = document.createElement("span");
  headIcon.className = "steps-icon";
  headIcon.innerHTML = ICONS.tools;
  const count = document.createElement("span");
  count.className = "steps-count";
  const brief = document.createElement("span");
  brief.className = "step-brief";
  head.append(headIcon, count, brief);
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
      count.textContent = `${n} 步操作`;
      brief.textContent = toolLabel(typeof tool === "string" ? tool : tool.name);
      const name = typeof tool === "string" ? tool : tool.name;
      const detail = typeof tool === "string" ? undefined : tool.detail;
      const row = document.createElement("div");
      row.className = "step";
      const rowHead = document.createElement("button");
      rowHead.className = "step-head";
      const icon = document.createElement("span");
      icon.className = "step-icon";
      icon.innerHTML = toolIcon(name);
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

// —— 他的话不带框，开头一行名字+时间（参考泽给的截图风格） ——
function fmtTime(t) {
  const d = t ? new Date(t) : new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
let liveHead = false; // 这一轮回复的头行是否已经放了
function addTaHead(at, name = "麦穗") {
  const div = document.createElement("div");
  div.className = "ta-head";
  if (name === "GPT") div.classList.add("gpt");
  const nameEl = document.createElement("span");
  nameEl.textContent = name;
  const tm = document.createElement("time");
  tm.textContent = fmtTime(at);
  div.append(nameEl, tm);
  messagesEl.appendChild(div);
  return div;
}
function ensureTaHead() {
  if (liveHead) return;
  liveHead = true;
  addTaHead();
}

// —— 界面 ——
// 居中小字提示条（channel_fallback 同款样式），返回元素方便后面改字
function addChanNote(text) {
  const note = document.createElement("div");
  note.className = "chan-note";
  note.textContent = text;
  messagesEl.appendChild(note);
  scrollDown();
  return note;
}

const bubbleRawText = new WeakMap();
const bubbleMessageIds = new WeakMap();
const copyResetTimers = new WeakMap();
const deleteResetTimers = new WeakMap();
let armedDeleteButton = null;

// https 外优先走现代剪贴板；http 入口用老办法兜底
async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;font-size:16px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {}
  textarea.remove();
  return copied;
}

function resetCopyButton(button) {
  button.classList.remove("copied", "copy-failed");
  button.innerHTML = ICONS.copy;
  button.title = "复制";
  button.setAttribute("aria-label", "复制消息");
}

function addCopyButton(bubble, actions) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy-btn";
  resetCopyButton(button);
  button.onclick = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const oldTimer = copyResetTimers.get(button);
    if (oldTimer) clearTimeout(oldTimer);
    const copied = await writeClipboard(bubbleRawText.get(bubble) || "");
    button.classList.toggle("copied", copied);
    button.classList.toggle("copy-failed", !copied);
    button.innerHTML = copied ? ICONS.copied : ICONS.copyFail;
    button.title = copied ? "已复制" : "复制失败";
    button.setAttribute("aria-label", button.title);
    copyResetTimers.set(button, setTimeout(() => resetCopyButton(button), 1000));
  };
  actions.appendChild(button);
}

function resetDeleteButton(button) {
  const timer = deleteResetTimers.get(button);
  if (timer) clearTimeout(timer);
  deleteResetTimers.delete(button);
  button.disabled = false;
  button.classList.remove("delete-confirm", "delete-failed");
  button.innerHTML = ICONS.trash;
  button.title = "删除";
  button.setAttribute("aria-label", "删除消息");
  if (armedDeleteButton === button) armedDeleteButton = null;
}

function failDeleteButton(button, text) {
  if (armedDeleteButton && armedDeleteButton !== button) resetDeleteButton(armedDeleteButton);
  resetDeleteButton(button);
  button.classList.add("delete-failed");
  button.textContent = text;
  button.title = text;
  button.setAttribute("aria-label", text);
  deleteResetTimers.set(button, setTimeout(() => resetDeleteButton(button), 1600));
}

function armDeleteButton(button) {
  if (armedDeleteButton && armedDeleteButton !== button) resetDeleteButton(armedDeleteButton);
  resetDeleteButton(button);
  armedDeleteButton = button;
  button.classList.add("delete-confirm");
  button.textContent = "删除？";
  button.title = "再点一次删除";
  button.setAttribute("aria-label", "再点一次删除消息");
  deleteResetTimers.set(button, setTimeout(() => resetDeleteButton(button), 3000));
}

function bubbleDirection(bubble) {
  return bubble.classList.contains("me") ? "user" : "assistant";
}

async function resolveBubbleMessageId(bubble) {
  const known = bubbleMessageIds.get(bubble);
  if (known) return known;
  if (!sessionId) return null;

  const record = await api(`/api/sessions/${sessionId}`);
  if (!Array.isArray(record.messages)) return null;
  const role = bubbleDirection(bubble);
  const text = bubbleRawText.get(bubble);
  if (typeof text !== "string") return null;

  let occurrence = 0;
  let foundBubble = false;
  for (const candidate of messagesEl.querySelectorAll(".msg-group > .msg")) {
    if (bubbleDirection(candidate) !== role || bubbleRawText.get(candidate) !== text) continue;
    if (candidate === bubble) {
      foundBubble = true;
      break;
    }
    occurrence++;
  }
  if (!foundBubble) return null;
  const match = record.messages.filter((message) => message.role === role && message.text === text)[occurrence];
  if (!match?.id) return null;
  bubbleMessageIds.set(bubble, match.id);
  return match.id;
}

function removeEmptyMessageDecorations(group) {
  const previous = group.previousElementSibling;
  group.remove();
  // 普通 assistant 气泡的名字头就在组上方；删掉服务对象后别留一行空名字。
  if (previous?.classList.contains("ta-head")) previous.remove();
  // 一个时间戳管到下一个时间戳为止；区间里已经没有消息组就一并收掉。
  for (const stamp of messagesEl.querySelectorAll(".msg.stamp")) {
    let node = stamp.nextElementSibling;
    let hasMessage = false;
    while (node && !node.matches(".msg.stamp")) {
      if (node.matches(".msg-group")) {
        hasMessage = true;
        break;
      }
      node = node.nextElementSibling;
    }
    if (!hasMessage) stamp.remove();
  }
}

async function deleteBubble(bubble, button) {
  let messageId;
  try {
    messageId = await resolveBubbleMessageId(bubble);
  } catch {
    return failDeleteButton(button, "删除失败");
  }
  if (!messageId) return failDeleteButton(button, "这条还没落库");

  try {
    const res = await fetch(`/api/sessions/${sessionId}/messages?token=${encodeURIComponent(token)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: messageId }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "删除失败");
    const group = bubble.closest(".msg-group");
    if (group) removeEmptyMessageDecorations(group);
    if (armedDeleteButton === button) armedDeleteButton = null;
    loadSessions().catch(() => {});
  } catch (error) {
    failDeleteButton(button, error.message || "删除失败");
  }
}

function addDeleteButton(bubble, actions) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "delete-btn";
  resetDeleteButton(button);
  button.onclick = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return failDeleteButton(button, "正在说话");
    if (!button.classList.contains("delete-confirm")) return armDeleteButton(button);

    const timer = deleteResetTimers.get(button);
    if (timer) clearTimeout(timer);
    deleteResetTimers.delete(button);
    armedDeleteButton = null;
    button.disabled = true;
    button.textContent = "删除中…";
    await deleteBubble(bubble, button);
  };
  actions.appendChild(button);
}

// 确认态只留给紧接着的第二击；点页面任何别处都复原。
document.addEventListener("click", () => {
  if (armedDeleteButton) resetDeleteButton(armedDeleteButton);
});

function setBubbleText(bubble, text) {
  const raw = text ?? "";
  bubbleRawText.set(bubble, raw);
  bubble.textContent = raw;
}

function addBubble(kind, text) {
  const div = document.createElement("div");
  div.className =
    kind === "me" ? "msg me" :
    kind === "error" ? "msg error" :
    kind === "gpt" ? "msg ta gpt" : "msg ta";
  if (kind === "error") {
    div.textContent = text;
    messagesEl.appendChild(div);
  } else {
    const group = document.createElement("div");
    group.className = `msg-group ${kind === "me" ? "me" : "ta"}`;
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    setBubbleText(div, text);
    addCopyButton(div, actions);
    addDeleteButton(div, actions);
    group.append(div, actions);
    messagesEl.appendChild(group);
  }
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
  const raw = text ?? "";
  bubbleRawText.set(el, raw);
  try {
    el.innerHTML = marked.parse(raw);
    el.classList.add("md");
  } catch {
    el.textContent = raw;
  }
  scrollDown();
}

function sendMessage() {
  const text = inputEl.value.trim();
  const ready = pending.filter((p) => !p.uploading);
  if ((!text && ready.length === 0) || busy || !ws || ws.readyState !== 1) return;
  if (pending.some((p) => p.uploading)) return addBubble("error", "附件还在上传，稍等一下");
  const attachments = ready.map(({ _thumb, ...att }) => att);
  const sentDraftKey = draftStorageKey();
  const payload = { type: "chat", sessionId, text, attachments, model: modelSelect.value || undefined };
  // 待建群聊的首条消息带 mode:"group"；后端只在新建会话时认，发完就清
  if (pendingMode) payload.mode = pendingMode;
  ws.send(JSON.stringify(payload));
  pendingMode = null;
  maybeStamp();
  const bubble = addBubble("me", text);
  // attachToBubble 的 before 是插最前面，倒着喂才能保持选择顺序
  for (const att of [...ready].reverse()) attachToBubble(bubble, att, true);
  clearPending();
  inputEl.value = "";
  autoGrow();
  localStorage.removeItem(sentDraftKey);
  busy = true;
  dotEl.classList.add("busy");
  statusTextEl.textContent = "正在干活…";
  sendBtn.hidden = true;
  stopBtn.hidden = false;
  showTyping();
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
    if (f.size > 200 * 1024 * 1024) {
      addBubble("error", `「${f.name}」太大，上限 200MB`);
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
  if (modelSelect.value === "__custom") return handleCustomModel();
  if (modelSelect.value) localStorage.setItem("home_model", modelSelect.value);
  else localStorage.removeItem("home_model");
};

// —— 模型列表：订阅一组（写死仨别名）、外部一组（现拉）、手填一组（本机记住） ——
let modelsCache = null;

function customModels() {
  try {
    const list = JSON.parse(localStorage.getItem("home_custom_models") || "[]");
    return Array.isArray(list) ? list.filter((x) => typeof x === "string" && x) : [];
  } catch {
    return [];
  }
}

function rebuildModelOptions() {
  const saved = localStorage.getItem("home_model") || "";
  const subs = (modelsCache && modelsCache.subscription) || [
    { id: "opus", name: "Opus" }, { id: "sonnet", name: "Sonnet" }, { id: "haiku", name: "Haiku" },
  ];
  modelSelect.innerHTML = "";
  modelSelect.appendChild(new Option("默认", ""));
  const subGroup = document.createElement("optgroup");
  subGroup.label = "订阅";
  for (const m of subs) subGroup.appendChild(new Option(m.name, m.id));
  modelSelect.appendChild(subGroup);
  if (modelsCache && modelsCache.external.length) {
    const extGroup = document.createElement("optgroup");
    extGroup.label = "外部 API";
    for (const m of modelsCache.external) extGroup.appendChild(new Option(m.name, m.id));
    modelSelect.appendChild(extGroup);
  }
  const customs = customModels();
  if (customs.length) {
    const cusGroup = document.createElement("optgroup");
    cusGroup.label = "手填";
    for (const id of customs) cusGroup.appendChild(new Option(id, id));
    modelSelect.appendChild(cusGroup);
  }
  modelSelect.appendChild(new Option("✏️ 手填型号…", "__custom"));
  // 恢复本机记的选择；已经不在列表里就回默认
  modelSelect.value = saved;
  if (modelSelect.value !== saved) {
    modelSelect.value = "";
    localStorage.removeItem("home_model");
  }
}

function handleCustomModel() {
  const input = (prompt("填完整模型型号，比如 claude-opus-4-5\n（填「清空」可删掉所有手填过的）") || "").trim();
  if (!input) return rebuildModelOptions(); // 取消/空输入：恢复原选择
  if (input === "清空") {
    const wasCustom = customModels().includes(localStorage.getItem("home_model") || "");
    localStorage.removeItem("home_custom_models");
    if (wasCustom) localStorage.removeItem("home_model"); // 正选着手填的，跟着回默认
    return rebuildModelOptions();
  }
  const list = [...new Set([...customModels(), input])];
  localStorage.setItem("home_custom_models", JSON.stringify(list));
  localStorage.setItem("home_model", input);
  rebuildModelOptions();
}

async function loadModels(refresh = false) {
  const data = await api(`/api/models${refresh ? "?refresh=1" : ""}`);
  modelsCache = data;
  rebuildModelOptions();
  return data;
}
rebuildModelOptions();            // 先用写死的仨 + 手填的画出来，别等网络
loadModels().catch(() => {});     // 再拉外部列表补上

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

function draftStorageKey() {
  if (sessionId) return `home_draft_${sessionId}`;
  return pendingMode === "group" ? "home_draft_new_group" : "home_draft_new";
}

function saveDraft() {
  const key = draftStorageKey();
  if (inputEl.value) localStorage.setItem(key, inputEl.value);
  else localStorage.removeItem(key);
}

function restoreDraft() {
  inputEl.value = localStorage.getItem(draftStorageKey()) || "";
  autoGrow();
}

inputEl.addEventListener("input", autoGrow);
inputEl.addEventListener("input", saveDraft);

// —— 会话列表 ——
async function api(pathname) {
  // 路径里可能已经带参数（如 /api/models?refresh=1），别把 token 拼坏了
  const sep = pathname.includes("?") ? "&" : "?";
  const res = await fetch(`${pathname}${sep}token=${encodeURIComponent(token)}`);
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

// 文件夹折叠状态记在本机；默认折叠（整理进文件夹的多半是旧会话，收着省地方）
function collapsedFolders() {
  try {
    const v = JSON.parse(localStorage.getItem("home_folders_open") || "[]");
    return Array.isArray(v) ? new Set(v) : new Set();
  } catch {
    return new Set();
  }
}
function toggleFolder(name) {
  const open = collapsedFolders();
  if (open.has(name)) open.delete(name);
  else open.add(name);
  localStorage.setItem("home_folders_open", JSON.stringify([...open]));
}

let sessionsCache = [];

async function loadSessions() {
  sessionsCache = await api("/api/sessions");
  // 首页消息总数**只算聊天会话**，技术会话（我改代码那种）不计
  const chatTotal = sessionsCache
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
  renderSessions();
}

// 画会话列表：散装的按时间在上，文件夹收在底部（折叠状态记本机，点行头开合）
// 只画当前区的会话：单聊区不见群聊，议事厅里不见单聊
function renderSessions() {
  listEl.innerHTML = "";
  const inArea = sessionsCache.filter((s) => (s.mode === "group") === (chatArea === "group"));
  const loose = inArea.filter((s) => !s.folder);
  const folders = new Map();
  for (const s of inArea) {
    if (!s.folder) continue;
    if (!folders.has(s.folder)) folders.set(s.folder, []);
    folders.get(s.folder).push(s);
  }
  for (const s of loose) listEl.appendChild(sessionRow(s));
  const open = collapsedFolders();
  for (const [name, items] of [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-CN"))) {
    const li = document.createElement("li");
    li.className = "folder-row";
    const isOpen = open.has(name);
    const arrow = document.createElement("span");
    arrow.className = "folder-arrow";
    arrow.textContent = isOpen ? "▾" : "▸";
    const label = document.createElement("span");
    label.className = "folder-name";
    label.textContent = `📁 ${name}`;
    const count = document.createElement("span");
    count.className = "folder-count";
    count.textContent = items.length;
    li.append(arrow, label, count);
    li.onclick = () => {
      toggleFolder(name);
      renderSessions();
    };
    listEl.appendChild(li);
    if (isOpen) {
      for (const s of items) {
        const row = sessionRow(s);
        row.classList.add("in-folder");
        listEl.appendChild(row);
      }
    }
  }
}

function sessionRow(s) {
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
  return li;
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
  const move = document.createElement("button");
  move.textContent = sess.folder ? `移出「${sess.folder}」` : "移动到…";
  move.onclick = (e) => {
    e.stopPropagation();
    closeSessMenu();
    doMove(sess);
  };
  const slim = document.createElement("button");
  slim.textContent = "瘦身";
  slim.onclick = (e) => {
    e.stopPropagation();
    closeSessMenu();
    doCompact(sess);
  };
  const del = document.createElement("button");
  del.className = "danger";
  del.textContent = "删除";
  del.onclick = (e) => {
    e.stopPropagation();
    closeSessMenu();
    doDelete(sess);
  };
  menu.append(rename, move, slim, del);
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

async function doMove(sess) {
  let folder = "";
  if (!sess.folder) {
    // 移进：列出已有文件夹让她照抄，或直接输新名字建新的
    const existing = [...new Set(sessionsCache.map((s) => s.folder).filter(Boolean))];
    const hint = existing.length ? `已有文件夹：${existing.join("、")}\n输入其中一个归进去，或输新名字新建` : "输入文件夹名（没有会自动新建）";
    folder = (prompt(hint) || "").trim();
    if (!folder) return;
  }
  const res = await fetch(`/api/sessions/${sess.id}/folder?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder }),
  });
  if (!res.ok) return addBubble("error", "移动失败");
  loadSessions();
}

// 瘦身（手动挡）：让服务端对这个会话做一次 /compact，历史压成摘要
async function doCompact(sess) {
  if (!confirm(`给「${sess.title}」瘦身？\n聊天历史会压成摘要：聊过什么、定过什么都还在，但发过的大文件原文会被压掉。压完之后每轮又快又省。`)) return;
  const note = addChanNote(`「${sess.title}」正在瘦身，大会话要压一阵，别关页面…`);
  try {
    const res = await fetch(`/api/sessions/${sess.id}/compact?token=${encodeURIComponent(token)}`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "服务器没接住");
    note.textContent = `「${sess.title}」瘦身完成`;
  } catch (e) {
    note.textContent = `瘦身没成功：${e.message}`;
  }
  scrollDown();
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
  const isGpt = m.role === "assistant" && m.speaker === "gpt";
  // 他的回合开头放一行名字+时间（拍一拍的回应除外，那个本来就是小字）
  if (m.role === "assistant" && (m.text || m.thinking?.text || m.tools?.length)) {
    addTaHead(m.at, isGpt ? "GPT" : "麦穗");
  }
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
        if (m.id) bubbleMessageIds.set(bubble, m.id);
        for (const att of m.attachments || []) attachToBubble(bubble, att, true);
      }
    } else {
      const bubble = addBubble(isGpt ? "gpt" : "ta", "");
      if (m.id) bubbleMessageIds.set(bubble, m.id);
      renderMd(bubble, m.text);
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
  // 打开哪个区的会话就落在哪个区（初始恢复上次会话时靠这行自动定区）
  chatArea = record.mode === "group" ? "group" : "solo";
  updateAreaLabels();
  messagesEl.innerHTML = "";
  pendingOlderMessages = null;
  lastStampTime = 0;
  pendingMode = null; // 点开旧会话就不算待建群聊了
  restoreDraft();

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
  // 在议事厅里点＋就是开新群聊，单聊区照旧
  pendingMode = chatArea === "group" ? "group" : null;
  restoreDraft();
  if (chatArea === "group") addChanNote("新议事：泽 + 麦穗 + GPT，发第一条消息就开张");
  closeDrawer();
};

// 议事厅（工具页入口）→ 群聊区；心形爱心 → 单聊区。两区列表互不掺和
function updateAreaLabels() {
  const group = chatArea === "group";
  $("whoName").textContent = group ? "议事厅" : "麦穗";
  $("drawerTitle").textContent = group ? "议事厅" : "会话";
}

async function enterChatArea(area) {
  if (chatArea === area) {
    // 已经在这个区就直接进去，不打断正开着的会话
    showView("chat");
    restoreDraft();
    return;
  }
  chatArea = area;
  updateAreaLabels();
  sessionId = null;
  localStorage.removeItem("home_session");
  messagesEl.innerHTML = "";
  pendingOlderMessages = null;
  lastStampTime = 0;
  pendingMode = area === "group" ? "group" : null;
  showView("chat");
  // 接着上次的聊：找这个区最近的会话打开；一个都没有就空白待建
  try {
    await loadSessions();
    const latest = sessionsCache.find((s) => (s.mode === "group") === (area === "group"));
    if (latest) {
      await openSession(latest.id);
      return;
    }
  } catch {}
  restoreDraft();
  if (area === "group") addChanNote("议事厅：泽 + 麦穗 + GPT，发第一条消息就开张");
}

$("toolGroup").onclick = () => enterChatArea("group");

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
const toolsViewEl = $("toolsView");
const settingsViewEl = $("settingsView");
const bottomNavEl = $("bottomNav");

function showView(name) {
  homeViewEl.hidden = name !== "home";
  chatViewEl.hidden = name !== "chat";
  memoryViewEl.hidden = name !== "memory";
  toolsViewEl.hidden = name !== "tools";
  settingsViewEl.hidden = name !== "settings";
  // 聊天和星图都要占满屏，底部导航让位；首页/工具/设置导航常驻
  bottomNavEl.hidden = name === "chat" || name === "memory";
  for (const btn of bottomNavEl.querySelectorAll(".nav-btn")) {
    btn.classList.toggle("active", btn.dataset.view === name);
  }
  if (name === "home") updateGreeting();
  if (name === "memory") loadMemoryGraph();
  if (name === "settings") loadChannelSettings();
  if (name === "chat") {
    // 视图刚显示，浏览器还没做布局，scrollHeight 可能是 0。
    // 等一帧让布局完成再贴底，否则永远停在顶。
    requestAnimationFrame(() => requestAnimationFrame(forceScrollDown));
  }
}

for (const btn of bottomNavEl.querySelectorAll(".nav-btn")) {
  btn.onclick = () => {
    if (btn.disabled) return;
    // 心形永远进单聊区；正开着议事厅时点它就切回跟麦穗单聊
    if (btn.dataset.view === "chat") enterChatArea("solo");
    else showView(btn.dataset.view);
  };
}

// 首页卡片点击（disabled 的天然点不进来）
for (const card of document.querySelectorAll("#homeView .card")) {
  card.onclick = () => {
    if (card.disabled) return;
    const route = card.dataset.route;
    if (route === "chat") enterChatArea("solo");
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
// 在一起 2024-12-30，天数从这天算（泽 2026-07-08 纠正）；领证 2025 平安夜是另一个纪念日
const TOGETHER_AT = new Date("2024-12-30T00:00:00");
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

  // 便签纸右下角的日期戳，JUL · 8 这种
  const MONTHS_EN = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const noteDateEl = $("noteDate");
  if (noteDateEl) noteDateEl.textContent = `${MONTHS_EN[now.getMonth()]} · ${now.getDate()}`;
}

function updateDaysTogether() {
  const days = Math.floor((Date.now() - TOGETHER_AT.getTime()) / 86400000);
  daysTogetherEl.textContent = days >= 0 ? days : 0;
  const md = Math.floor((Date.now() - MARRIED_AT.getTime()) / 86400000);
  const mdEl = $("marriedDays");
  if (mdEl) mdEl.textContent = md >= 0 ? md : 0;
}

// 天气线条图标：按 Open-Meteo 天气码分档，跟全站细线风格一致
const ICONS_W = {
  sun: SVG('<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.3M12 19.2v2.3M2.5 12h2.3M19.2 12h2.3M5 5l1.6 1.6M17.4 17.4 19 19M19 5l-1.6 1.6M6.6 17.4 5 19"/>'),
  suncloud: SVG('<circle cx="8" cy="7.5" r="2.8"/><path d="M8 2.4v1.5M2.9 7.5h1.5M4.4 3.9l1 1"/><path d="M10 19.5a3.6 3.6 0 0 1-.4-7.2A4.8 4.8 0 0 1 19 13.5a3 3 0 0 1-.3 6z"/>'),
  cloud: SVG('<path d="M6.5 18.5a4 4 0 0 1-.5-8 5.5 5.5 0 0 1 10.8 1.2 3.4 3.4 0 0 1-.3 6.8z"/>'),
  rain: SVG('<path d="M6.5 15.5a4 4 0 0 1-.5-8 5.5 5.5 0 0 1 10.8 1.2 3.4 3.4 0 0 1-.3 6.8z"/><path d="M9 18.5v2.3M13 18.5v2.3M17 18.5v2.3"/>'),
  snow: SVG('<path d="M6.5 15.5a4 4 0 0 1-.5-8 5.5 5.5 0 0 1 10.8 1.2 3.4 3.4 0 0 1-.3 6.8z"/><path d="M9 19.5h.01M13 21h.01M17 19.5h.01"/>'),
  fog: SVG('<path d="M4 9.5h16M6 13.5h14M4 17.5h12"/>'),
  storm: SVG('<path d="M6.5 14.5a4 4 0 0 1-.5-8 5.5 5.5 0 0 1 10.8 1.2 3.4 3.4 0 0 1-.3 6.8z"/><path d="M12.5 14.5 10.4 18h3l-1.6 3.4"/>'),
};
function weatherSvg(code) {
  const c = Number(code);
  if (c === 0) return ICONS_W.sun;
  if (c === 1 || c === 2) return ICONS_W.suncloud;
  if (c === 45 || c === 48) return ICONS_W.fog;
  if (c >= 95) return ICONS_W.storm;
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return ICONS_W.snow;
  if (c >= 51) return ICONS_W.rain;
  return ICONS_W.cloud;
}

async function updateWeather() {
  try {
    const w = await api("/api/weather");
    // 后端返回错误时是 { error: "..." } 结构，缺 temp 就当没拿到，静默失败
    if (!w || typeof w.temp !== "number") return;
    $("weatherIcon").innerHTML = weatherSvg(w.code);
    $("weatherTemp").textContent = w.temp;
    $("weatherHi").textContent = w.high;
    $("weatherLo").textContent = w.low;
    $("weatherBox").hidden = false;
  } catch {
    // 网络挂了不显示天气就完了，别打断首页其他内容
  }
}

// 麦穗生成的一句话：现在写在便签纸上（顶部问候留给时段静态款）
let lastGreetingFetchAt = 0;
async function updateGreeting(force = false) {
  if (!force && Date.now() - lastGreetingFetchAt < 30 * 60_000) return;
  try {
    const g = await api("/api/greeting");
    if (g && typeof g.text === "string" && g.text) {
      $("noteText").textContent = g.text;
      lastGreetingFetchAt = Date.now();
    }
  } catch {
    // 拿不到便签就先空着，不挡首页其他内容
  }
}

// —— 收藏室：纪念卡轮播，8 秒翻一张，泽摸过就先歇 20 秒 ——
async function loadKeepsakes() {
  try {
    const items = await api("/api/keepsakes");
    const track = $("keepsakeTrack");
    if (!track || !Array.isArray(items) || items.length === 0) return;
    track.innerHTML = "";
    for (const it of items) {
      const card = document.createElement("div");
      card.className = "keepsake-card";
      const d = document.createElement("div");
      d.className = "k-date";
      d.textContent = String(it.date || "").replaceAll("-", " · ");
      const t = document.createElement("div");
      t.className = "k-text";
      t.textContent = it.text || "";
      card.append(d, t);
      track.appendChild(card);
    }
    let idx = 0;
    let pausedUntil = 0;
    const pause = () => { pausedUntil = Date.now() + 20_000; };
    track.addEventListener("touchstart", pause, { passive: true });
    track.addEventListener("mousedown", pause);
    setInterval(() => {
      if (Date.now() < pausedUntil || homeViewEl.hidden || track.children.length === 0) return;
      idx = (idx + 1) % track.children.length;
      track.scrollTo({ left: track.children[idx].offsetLeft - 12, behavior: "smooth" });
    }, 8_000);
  } catch {
    // 收藏室拿不到就先空着
  }
}

// —— iOS Safari 无视 viewport 的缩放禁令，得亲手拦住捏合手势 ——
document.addEventListener("gesturestart", (e) => e.preventDefault());
document.addEventListener("gesturechange", (e) => e.preventDefault());
// 双击放大也拦掉（300ms 内的第二次触摸）
let lastTouchEnd = 0;
document.addEventListener("touchend", (e) => {
  const now = Date.now();
  if (now - lastTouchEnd <= 300) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });

// —— 设置页：调用通道 + 外部 API 配置 ——
async function loadChannelSettings() {
  const statusEl = $("channelStatus");
  const extStatusEl = $("externalStatus");
  try {
    const s = await api("/api/settings");
    for (const input of settingsViewEl.querySelectorAll("input[name=channel]")) {
      input.checked = input.value === s.channel;
      // 外部 key 没配就只剩订阅能选
      input.disabled = input.value !== "subscription" && !s.externalConfigured;
    }
    statusEl.textContent = s.externalConfigured
      ? `外部 API key 已配置（${s.keySource === "settings" ? "本页保存的" : "服务器 .env 里的"}，尾号 ${s.keyTail}）`
      : "外部 API 还没配置：在下面填好 key 保存，另外两项才能选";
    // key 不回显，占位符提示当前状态；地址和验证方式正常回填
    $("extKey").value = "";
    $("extKey").placeholder = s.externalConfigured ? `已配置（尾号 ${s.keyTail}），要换就填新的` : "sk-…（中转站或官方的 key）";
    $("extBaseUrl").value = s.externalBaseUrl || "";
    $("extBearer").checked = s.externalAuth === "bearer";
    extStatusEl.textContent = "改完点保存，立即生效，不用重启服务";
    // 模型下拉框：先用启动时拉的列表填上；没拉到过就静默留默认项
    fillExtModelSelects(s);
    if (s.externalConfigured && !(modelsCache && modelsCache.external.length)) {
      loadModels().then(() => fillExtModelSelects(s)).catch(() => {});
    }
  } catch {
    statusEl.textContent = "设置读不到，稍后再试";
    extStatusEl.textContent = "设置读不到，稍后再试";
  }
}

// 把拉到的外部模型列表灌进设置页的两个下拉框，并回显当前配置
function fillExtModelSelects(s) {
  const list = (modelsCache && modelsCache.external) || [];
  for (const [id, current] of [["extModel", s.externalModel], ["extHaiku", s.externalHaiku]]) {
    const sel = $(id);
    const keep = sel.querySelector("option[value='']");
    sel.innerHTML = "";
    sel.appendChild(keep);
    for (const m of list) sel.appendChild(new Option(m.name, m.id));
    // 当前配的模型不在列表里（还没拉过/中转下架了）也得显示出来，别默默变成"不指定"
    if (current && !list.some((m) => m.id === current)) sel.appendChild(new Option(`${current}（不在列表里）`, current));
    sel.value = current || "";
  }
  const hint = $("extModelHint");
  if (modelsCache && modelsCache.externalError) hint.textContent = `拉取失败：${modelsCache.externalError}`;
  else if (list.length) hint.textContent = `拉到 ${list.length} 个模型`;
}

$("extModelRefresh").onclick = async () => {
  const hint = $("extModelHint");
  hint.textContent = "拉取中…";
  try {
    await loadModels(true);
    const s = await api("/api/settings");
    fillExtModelSelects(s);
  } catch (err) {
    hint.textContent = `拉取失败：${err.message || "网络不通"}`;
  }
};

async function postSettings(body) {
  const res = await fetch(`/api/settings?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "保存失败");
  return data;
}

for (const input of settingsViewEl.querySelectorAll("input[name=channel]")) {
  input.onchange = async () => {
    const statusEl = $("channelStatus");
    try {
      await postSettings({ channel: input.value });
      statusEl.textContent = "已保存";
      setTimeout(loadChannelSettings, 1200);
    } catch (err) {
      statusEl.textContent = err.message || "保存失败";
      loadChannelSettings();
    }
  };
}

$("extSave").onclick = async () => {
  const extStatusEl = $("externalStatus");
  const body = {
    externalBaseUrl: $("extBaseUrl").value.trim(),
    externalAuth: $("extBearer").checked ? "bearer" : "x-api-key",
    externalModel: $("extModel").value,
    externalHaiku: $("extHaiku").value,
  };
  // key 框留空 = 不动现有的 key；填了才覆盖
  const key = $("extKey").value.trim();
  if (key) body.externalKey = key;
  try {
    extStatusEl.textContent = "保存中…";
    await postSettings(body);
    extStatusEl.textContent = "已保存，立即生效";
    setTimeout(loadChannelSettings, 1200);
  } catch (err) {
    extStatusEl.textContent = err.message || "保存失败";
  }
};

// —— 通话 ——
const callOverlayEl = $("callOverlay");
const callStatusEl = $("callStatus");
const callTranscriptEl = $("callTranscript");
const callTalkEl = $("callTalk");

let callSession = null;     // 一通电话一个会话
let callBusy = false;       // 这一轮还没回完
let callRecorder = null;
let callStream = null;
let callChunks = [];
let callTimerId = null;
let callStartedAt = 0;
// 单个 audio 元素反复用：第一次用户手势里 play 过之后，iOS 才允许后续程序化播放
const callAudio = new Audio();

// 挑一个当前浏览器录得出来的格式；iPhone 是 mp4/aac，桌面多是 webm/opus
function pickMime() {
  for (const m of ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"]) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

function callSetStatus(text) {
  callStatusEl.textContent = text;
}

function callTick() {
  const s = Math.floor((Date.now() - callStartedAt) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function callLine(who, text) {
  const div = document.createElement("div");
  div.className = `call-line ${who}`;
  div.textContent = text;
  callTranscriptEl.appendChild(div);
  callTranscriptEl.scrollTop = callTranscriptEl.scrollHeight;
}

$("toolCall").onclick = async () => {
  // 麦克风只在安全环境（https 或 localhost）能用，这是浏览器的硬规定
  if (!window.isSecureContext) {
    alert("打电话要用麦克风，浏览器要求 HTTPS 环境。\n用 tailscale serve 给服务包一层 HTTPS 就行（README 里有写法）。");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    alert("这个浏览器不支持录音，换 Safari/Chrome 试试。");
    return;
  }
  callSession = null;
  callBusy = false;
  callTranscriptEl.innerHTML = "";
  callOverlayEl.hidden = false;
  callStartedAt = Date.now();
  callTimerId = setInterval(() => {
    if (!callBusy) callSetStatus(callTick());
  }, 1000);
  try {
    callStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    callSetStatus("接通了，按住下面说话");
  } catch {
    callSetStatus("拿不到麦克风权限");
  }
};

function startTalk(e) {
  e.preventDefault();
  if (callBusy || !callStream) return;
  // 借这次手势把 audio 解锁，之后回复的语音才放得出来
  callAudio.play().catch(() => {});
  const mime = pickMime();
  callChunks = [];
  try {
    callRecorder = new MediaRecorder(callStream, mime ? { mimeType: mime } : undefined);
  } catch {
    callSetStatus("录音起不来，换个浏览器试试");
    return;
  }
  callRecorder.ondataavailable = (ev) => { if (ev.data.size) callChunks.push(ev.data); };
  callRecorder.onstop = sendTalk;
  callRecorder.start();
  callTalkEl.classList.add("talking");
  callSetStatus("在听…");
}

function stopTalk(e) {
  e.preventDefault();
  callTalkEl.classList.remove("talking");
  if (callRecorder && callRecorder.state === "recording") callRecorder.stop();
}

async function sendTalk() {
  const mime = callRecorder?.mimeType || "audio/mp4";
  const blob = new Blob(callChunks, { type: mime });
  callChunks = [];
  if (blob.size < 1000) { callSetStatus(callTick()); return; } // 手滑碰了一下，不算
  callBusy = true;
  callSetStatus("想…");
  try {
    const qs = new URLSearchParams({ token, mime });
    if (callSession) qs.set("session", callSession);
    const res = await fetch(`/api/call/turn?${qs}`, { method: "POST", body: blob });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "这轮没接上");
    if (data.empty) { callSetStatus(data.hint || "没听清，再说一遍？"); callBusy = false; return; }
    callSession = data.sessionId;
    callLine("me", data.userText);
    callLine("fox", data.replyText);
    callSetStatus("…");
    callAudio.src = `data:${data.mime};base64,${data.audio}`;
    callAudio.onended = () => { callBusy = false; callSetStatus(callTick()); };
    await callAudio.play();
  } catch (err) {
    callBusy = false;
    callSetStatus(err.message || "断了一下，再说一次");
  }
}

// 按住说话：pointer 事件一套（手机触摸、桌面鼠标都走这）
callTalkEl.addEventListener("pointerdown", startTalk);
callTalkEl.addEventListener("pointerup", stopTalk);
callTalkEl.addEventListener("pointercancel", stopTalk);
callTalkEl.addEventListener("pointerleave", stopTalk);

$("callHangup").onclick = () => {
  if (callRecorder && callRecorder.state === "recording") callRecorder.stop();
  callRecorder = null;
  callStream?.getTracks().forEach((t) => t.stop());
  callStream = null;
  callAudio.pause();
  clearInterval(callTimerId);
  callOverlayEl.hidden = true;
  callSession = null;
  callBusy = false;
};

// —— 启动 ——
showView("home");
updateClock();
updateDaysTogether();
updateWeather();
updateGreeting(true);  // 启动强制刷一次，往便签纸上写今天这句
loadKeepsakes();
// 每分钟刷一次时钟；跨天时"在一起 X 天"也顺手刷一下
setInterval(() => {
  updateClock();
  updateDaysTogether();
}, 60_000);
// 天气每 10 分钟刷一次；服务端有 15 分钟缓存，不会真的每次都戳外网
setInterval(updateWeather, 10 * 60_000);

connect();
loadSessions();
if (sessionId) {
  openSession(sessionId).catch(() => {
    sessionId = null;
    localStorage.removeItem("home_session");
    restoreDraft();
  });
} else {
  restoreDraft();
}
