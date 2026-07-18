// 记忆星图 — 3D 星空版（2026-07-18 重写）
// 视觉参照：印刷星表美学 — 深纸色底、米金星点、细线星座、带环亮星、四角框线（框线在 HTML/CSS 层）
// 技术路线：Canvas 2D 手写球面布局 + 透视投影。不引 Three.js —— 前端无构建步骤、
//   CDN 不稳，而节点量（几十星 + 一两百桥）Canvas 全重绘毫无压力。别手贱引库。
// 交互：单指拖动 = 旋转（yaw/pitch + 惯性），双指 = 缩放，点星 = 详情。空闲时缓慢自转。

/* global memoryGraph */

const KIND_META = {
  person:  { label: "社交", dir: [ 0.00,  0.85,  0.30] },
  place:   { label: "地点", dir: [ 0.85,  0.15, -0.40] },
  event:   { label: "事件", dir: [ 0.35, -0.75,  0.45] },
  hobby:   { label: "爱好", dir: [-0.75, -0.45, -0.35] },
  project: { label: "项目", dir: [-0.60,  0.35,  0.60] },
};
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const STAR_FONT = '"Didot", "KingHwa_OldSong", Georgia, serif';

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

// —— 3D 布局：每个 kind 占球面一个方向，类内在球帽上做种子化 sunflower ——
// 坐标是单位球归一化的，跟屏幕尺寸无关；投影时再乘半径。同一实体每次刷新位置稳定。
function buildLayout3D(entities) {
  const nodes = [];
  const byId = new Map();
  const groups = {};
  for (const e of entities) (groups[e.kind] || (groups[e.kind] = [])).push(e);

  for (const kind of Object.keys(KIND_META)) {
    const list = (groups[kind] || []).slice().sort(
      (a, b) => (b.fragmentCount || 0) - (a.fragmentCount || 0),
    );
    if (!list.length) continue;
    const dir = norm3(KIND_META[kind].dir);
    const ref = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm3(cross3(dir, ref));
    const v = cross3(dir, u);
    const maxAng = 0.55 + Math.min(0.38, list.length * 0.014);
    const rng = seededRng(hashStr(kind));

    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const theta = maxAng * Math.sqrt((i + 0.5) / list.length);
      const phi = i * GOLDEN + rng() * 0.6;
      const st = Math.sin(theta), ct = Math.cos(theta);
      const cp = Math.cos(phi), sp = Math.sin(phi);
      const rr = 0.68 + rng() * 0.6; // 半径抖动 → 星域有厚度
      const node = {
        entity: e,
        x: (dir[0] * ct + (u[0] * cp + v[0] * sp) * st) * rr,
        y: -(dir[1] * ct + (u[1] * cp + v[1] * sp) * st) * rr, // 屏幕 y 向下，翻转
        z: (dir[2] * ct + (u[2] * cp + v[2] * sp) * st) * rr,
        r: Math.min(8, 2.2 + Math.sqrt((e.fragmentCount || 0) + 1) * 1.5),
        ring: false,
        labelRank: 0,
      };
      nodes.push(node);
      byId.set(e.id, node);
    }
  }

  // 亮星戴环 + 标签显示优先级：全局按碎片数排
  const ranked = nodes.slice().sort(
    (a, b) => (b.entity.fragmentCount || 0) - (a.entity.fragmentCount || 0),
  );
  ranked.forEach((n, i) => {
    n.labelRank = i;
    if (i < 3) n.ring = true;
  });
  return { nodes, byId };
}

// —— 3D 星尘壳：比数据星更远的一层装饰光点，跟着一起转出厚度感，各有各的闪烁节奏 ——
let _dustCache = null;
function dustShell() {
  if (_dustCache) return _dustCache;
  const rng = seededRng(1224);
  const list = [];
  for (let i = 0; i < 190; i++) {
    const y = rng() * 2 - 1;
    const a = rng() * Math.PI * 2;
    const rxy = Math.sqrt(1 - y * y);
    const rr = 1.25 + rng() * 0.75;
    list.push({
      x: Math.cos(a) * rxy * rr, y: y * rr, z: Math.sin(a) * rxy * rr,
      r: rng() * 0.9 + 0.35,
      alpha: rng() * 0.22 + 0.06,
      phase: rng() * Math.PI * 2,
      freq: 0.4 + rng() * 1.1,
    });
  }
  _dustCache = list;
  return list;
}

// —— 纸面墨点：不转不闪的静态底噪，离屏缓存一张，每帧 drawImage ——
let _paperCache = null;
function paperInk(cssW, cssH, dpr) {
  if (_paperCache && _paperCache.w === cssW && _paperCache.h === cssH) return _paperCache.cv;
  const cv = document.createElement("canvas");
  cv.width = cssW * dpr;
  cv.height = cssH * dpr;
  const c = cv.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const rng = seededRng(42);
  const n = Math.max(40, Math.floor((cssW * cssH) / 9000));
  c.fillStyle = "rgba(48, 39, 28, 0.5)";
  for (let i = 0; i < n; i++) {
    c.globalAlpha = rng() * 0.10 + 0.04;
    c.beginPath();
    c.arc(rng() * cssW, rng() * cssH, rng() * 0.8 + 0.3, 0, Math.PI * 2);
    c.fill();
  }
  _paperCache = { w: cssW, h: cssH, cv };
  return cv;
}

// —— 满屏闪烁星场：屏幕空间固定位置的细星，忽明忽灭（参考视频背景那层的魂）——
let _twinkleCache = null;
function twinkleField(cssW, cssH) {
  if (_twinkleCache && _twinkleCache.w === cssW && _twinkleCache.h === cssH) return _twinkleCache.list;
  const rng = seededRng(310); // 3 月 10 日
  const list = [];
  const n = Math.max(160, Math.floor((cssW * cssH) / 950));
  for (let i = 0; i < n; i++) {
    const quick = rng() > 0.85; // 少数星闪得快，其余慢慢呼吸
    list.push({
      x: rng() * cssW,
      y: rng() * cssH,
      r: rng() * 0.8 + 0.3,
      base: rng() * 0.30 + 0.08,
      phase: rng() * Math.PI * 2,
      freq: quick ? 2.2 + rng() * 1.4 : 0.35 + rng() * 1.1,
    });
  }
  _twinkleCache = { w: cssW, h: cssH, list };
  return list;
}

// —— 相机与渲染循环 ——
const view = {
  // 初始 yaw 选 3.5：让两个最大星域（project / event）都朝向观察者，开屏就有名字可读
  yaw: 3.5, pitch: -0.22, scale: 1,
  vyaw: 0, vpitch: 0,          // 惯性速度
  dragging: false,
};
const AUTO_SPIN = 0.0007;      // 空闲自转（rad/帧），约两分钟一圈
const FOCAL = 2.4;             // 透视焦距（单位 = 投影半径）
const CORE = [                 // 中心双星：泽在左，麦穗在右
  { who: "ze", name: "泽", x: -0.055, y: 0, z: 0 },
  { who: "maisui", name: "麦穗", x: 0.055, y: 0, z: 0 },
];

let layout3d = null;
let selectedId = null;         // 选中的实体 id 或 "core:ze" / "core:maisui"
let running = false;
let projCache = [];            // 本帧投影结果，点击命中用
let spinPauseUntil = 0;        // 交互后自转的"冷静期"截止时间；恢复时短暂缓升

function project(px, py, pz, cx, cy, R, siny, cosy, sinp, cosp) {
  const x1 = px * cosy + pz * siny;
  const z1 = -px * siny + pz * cosy;
  const y2 = py * cosp - z1 * sinp;
  const z2 = py * sinp + z1 * cosp;
  const persp = FOCAL / (FOCAL + z2);
  return { sx: cx + x1 * R * persp, sy: cy + y2 * R * persp, z: z2, persp };
}
// 深度 → 亮度因子：非线性，亮度向近处集中。
// 近端 1 → 中距 ~0.3 → 远端 0.08，动态范围拉满，星多了也糊不成一片白。
function depthAlpha(z) {
  const lin = Math.max(0, Math.min(1, (1.15 - z) / 2.3));
  return 0.08 + 0.92 * Math.pow(lin, 2);
}

function frame(ts) {
  const canvas = document.getElementById("memoryCanvas");
  const memView = document.getElementById("memoryView");
  if (!canvas || !memView || memView.hidden) { running = false; return; }
  const graph = window.memoryGraph;
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  if (!cssW || !cssH) { requestAnimationFrame(frame); return; }
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const t = (ts || 0) / 1000;
  const now = Date.now();

  // 惯性（拖动中不衰减，跟手优先）
  if (!view.dragging) {
    view.yaw += view.vyaw;
    view.pitch += view.vpitch;
    view.vyaw *= 0.93;
    view.vpitch *= 0.93;
    if (Math.abs(view.vyaw) < 0.00012) view.vyaw = 0;
    if (Math.abs(view.vpitch) < 0.00012) view.vpitch = 0;
    view.pitch = Math.max(-1.25, Math.min(1.25, view.pitch));
  }
  // 自转分两类交互对待：
  // - 按住 / 详情面板开着：纯拦截，不欠债——一解除立刻恢复（tap 零延迟）。
  // - 真拖拽甩出的惯性：滑完埋 700ms 冷静期，再 0.9 秒缓升，不跟泽抢方向。
  const coasting = Math.abs(view.vyaw) + Math.abs(view.vpitch) > 0.0004;
  const detailOpen = !document.getElementById("memoryDetail").hidden;
  if (!view.dragging && !detailOpen) {
    if (coasting) {
      spinPauseUntil = now + 700;
    } else if (now > spinPauseUntil) {
      const ramp = Math.min(1, (now - spinPauseUntil) / 900);
      view.yaw += AUTO_SPIN * ramp;
    }
  }

  // 底色 + 纸面墨点 + 满屏闪烁星场
  ctx.fillStyle = "#7d6e58";
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.drawImage(paperInk(cssW, cssH, dpr), 0, 0, cssW, cssH);
  ctx.fillStyle = "#faf3e4";
  for (const s of twinkleField(cssW, cssH)) {
    const wave = 0.5 + 0.5 * Math.sin(t * s.freq + s.phase);
    ctx.globalAlpha = s.base * Math.pow(wave, 1.8); // 波谷压深 → 真的会灭
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const cx = cssW / 2, cy = cssH / 2 + 14; // 稍下移，给顶部标题留呼吸
  const R = Math.min(cssW, cssH) * 0.40 * view.scale;
  const siny = Math.sin(view.yaw), cosy = Math.cos(view.yaw);
  const sinp = Math.sin(view.pitch), cosp = Math.cos(view.pitch);
  const P = (n) => project(n.x, n.y, n.z, cx, cy, R, siny, cosy, sinp, cosp);

  // 3D 星尘壳（穿过视点太近的裁掉，避免一颗尘糊满屏）；跟着转，也各自明灭
  ctx.fillStyle = "#faf3e4";
  for (const d of dustShell()) {
    const p = P(d);
    if (p.persp > 2.2 || p.persp <= 0) continue;
    const wave = 0.5 + 0.5 * Math.sin(t * d.freq + d.phase);
    ctx.globalAlpha = d.alpha * depthAlpha(p.z) * (0.3 + 0.7 * wave);
    ctx.beginPath();
    ctx.arc(p.sx, p.sy, d.r * p.persp, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  if (!graph || !layout3d) { requestAnimationFrame(frame); return; }
  const nodes = layout3d.nodes;

  // 投影全部数据星（缓存给点击命中用）
  projCache = [];
  for (const n of nodes) {
    const p = P(n);
    projCache.push({ node: n, ...p });
  }
  const projById = new Map();
  for (const pc of projCache) projById.set(pc.node.entity.id, pc);

  // 桥线：透明度按两端深度均值，选中星的桥提亮
  for (const link of (graph.links || [])) {
    const a = projById.get(link.a);
    const b = projById.get(link.b);
    if (!a || !b) continue;
    const dl = (depthAlpha(a.z) + depthAlpha(b.z)) / 2;
    const hot = selectedId && (link.a === selectedId || link.b === selectedId);
    ctx.strokeStyle = hot ? "rgba(224, 158, 116, 0.75)" : "rgba(242, 230, 206, 1)";
    ctx.globalAlpha = hot ? Math.min(1, 0.25 + dl * 1.3) : (0.04 + 0.2 * dl);
    ctx.lineWidth = (hot ? 1.1 : 0.5) + Math.log2(1 + (link.weight || 1)) * 0.28;
    ctx.beginPath();
    ctx.moveTo(a.sx, a.sy);
    ctx.lineTo(b.sx, b.sy);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // 数据星：远的先画
  const sorted = projCache.slice().sort((a, b) => b.z - a.z);
  for (const pc of sorted) {
    drawStar(ctx, pc.sx, pc.sy, pc.node.r * pc.persp * 0.62, depthAlpha(pc.z), {
      ring: pc.node.ring,
      selected: pc.node.entity.id === selectedId,
    });
  }

  // 中心双星：最亮、带双环、名字常显
  const coreProj = CORE.map((c) => ({ core: c, ...P(c) }));
  for (const cp of coreProj.slice().sort((a, b) => b.z - a.z)) {
    drawStar(ctx, cp.sx, cp.sy, 5.2 * cp.persp, 1, {
      bright: true, ring: true, ring2: true,
      selected: selectedId === "core:" + cp.core.who,
    });
  }
  const mid = {
    sx: (coreProj[0].sx + coreProj[1].sx) / 2,
    sy: Math.max(coreProj[0].sy, coreProj[1].sy),
  };
  ctx.font = `12px ${STAR_FONT}`;
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(250, 243, 229, 0.92)";
  ctx.fillText("泽 · 麦穗", mid.sx, mid.sy + 26);

  // 标签：碎片数排名前 K 的才显示，缩放越大显示越多；背面的淡出不画。
  // rank 高的先占位，跟已画标签打架的让位；顶部标题区 / 底部提示区不进。
  const K = view.scale < 1.35 ? 9 : view.scale < 2 ? 18 : 999;
  ctx.font = `10.5px ${STAR_FONT}`;
  const placed = [{ x: mid.sx, y: mid.sy + 26, w: 60 }]; // 双星名字先占位
  const headSafe = 150, footSafe = cssH - 58;
  const byRank = projCache.slice().sort((a, b) => a.node.labelRank - b.node.labelRank);
  for (const pc of byRank) {
    const show = pc.node.labelRank < K || pc.node.entity.id === selectedId;
    const da = depthAlpha(pc.z);
    if (!show || da < 0.34) continue;
    const ly = pc.sy + pc.node.r * pc.persp * 0.62 + 13;
    if (ly < headSafe || ly > footSafe) continue;
    const w = ctx.measureText(pc.node.entity.name).width;
    if (pc.sx - w / 2 < 10 || pc.sx + w / 2 > cssW - 10) continue; // 出屏边的不画半截
    let clash = false;
    for (const pl of placed) {
      if (Math.abs(pc.sx - pl.x) < (w + pl.w) / 2 + 10 && Math.abs(ly - pl.y) < 15) { clash = true; break; }
    }
    if (clash) continue;
    placed.push({ x: pc.sx, y: ly, w });
    ctx.fillStyle = `rgba(247, 239, 224, ${(0.88 * da).toFixed(3)})`;
    ctx.fillText(pc.node.entity.name, pc.sx, ly);
  }

  requestAnimationFrame(frame);
}

// 一颗星：光晕 + 核心 + 可选细环（参考旧星表里的"命名亮星"画法）
function drawStar(ctx, x, y, r, da, opt) {
  const rr = Math.max(1.1, r);
  // 光晕半径也吃深度：近星晕开、远星几乎裸点，层次跟着拉
  const gr = rr * (2.0 + 1.8 * da);
  const glow = ctx.createRadialGradient(x, y, 0, x, y, gr);
  glow.addColorStop(0, `rgba(250, 240, 218, ${(0.46 * da).toFixed(3)})`);
  glow.addColorStop(1, "rgba(250, 240, 218, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, gr, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = opt.bright
    ? `rgba(253, 246, 227, ${da})`
    : `rgba(246, 236, 212, ${(0.92 * da).toFixed(3)})`;
  ctx.beginPath();
  ctx.arc(x, y, rr, 0, Math.PI * 2);
  ctx.fill();

  if (opt.ring) {
    ctx.strokeStyle = `rgba(244, 233, 210, ${(0.5 * da).toFixed(3)})`;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.arc(x, y, rr * 2.2, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (opt.ring2) {
    ctx.strokeStyle = `rgba(244, 233, 210, ${(0.28 * da).toFixed(3)})`;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.arc(x, y, rr * 3.1, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (opt.selected) {
    ctx.strokeStyle = "rgba(224, 158, 116, 0.9)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(x, y, rr * 2.2 + 3, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function renderStarmap() {
  const graph = window.memoryGraph;
  if (graph) layout3d = buildLayout3D(graph.entities || []);
  if (!running) {
    running = true;
    requestAnimationFrame(frame);
  }
}

// —— 手势：单指旋转（带惯性）、双指 pinch 缩放、单指点击选中 —— //
const pointers = new Map();
let pinchState = null;

function attachStarmapGestures() {
  const canvas = document.getElementById("memoryCanvas");
  if (!canvas || canvas.dataset.gestureBound) return;
  canvas.dataset.gestureBound = "1";

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    // 指针已失效/合成事件时 capture 会抛 NotFoundError，别让它打断手势
    try { canvas.setPointerCapture(e.pointerId); } catch { /* 无碍 */ }
    pointers.set(e.pointerId, {
      x: e.clientX, y: e.clientY,
      downX: e.clientX, downY: e.clientY,
      downT: Date.now(), moved: false,
    });
    view.dragging = true;
    view.vyaw = 0;
    view.vpitch = 0;
    if (pointers.size === 2) startPinch();
  });

  canvas.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (Math.hypot(e.clientX - p.downX, e.clientY - p.downY) > 6) p.moved = true;

    if (pointers.size === 1) {
      // 单指拖动 = 转动星空
      const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
      const dyaw = dx * (Math.PI / w) * 1.15;
      const dpitch = dy * (Math.PI / h) * 0.9;
      view.yaw += dyaw;
      view.pitch = Math.max(-1.25, Math.min(1.25, view.pitch + dpitch));
      // 抬手惯性用最近几帧的速度
      view.vyaw = view.vyaw * 0.5 + dyaw * 0.35;
      view.vpitch = view.vpitch * 0.5 + dpitch * 0.35;
    } else if (pointers.size === 2 && pinchState) {
      updatePinch();
    }
  });

  const endPointer = (e) => {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchState = null;
    if (pointers.size === 0) view.dragging = false; // 惯性接管
    if (!p) return;
    if (!p.moved && Date.now() - p.downT < 500 && pointers.size === 0) {
      view.vyaw = 0;
      view.vpitch = 0;
      handleTap(p.x, p.y, canvas);
    }
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
}

function startPinch() {
  const [a, b] = [...pointers.values()];
  pinchState = {
    initDist: Math.hypot(a.x - b.x, a.y - b.y),
    initScale: view.scale,
  };
}
function updatePinch() {
  const [a, b] = [...pointers.values()];
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  view.scale = Math.max(0.55, Math.min(2.8, pinchState.initScale * (dist / pinchState.initDist)));
}

function handleTap(screenX, screenY, canvas) {
  const rect = canvas.getBoundingClientRect();
  const tx = screenX - rect.left;
  const ty = screenY - rect.top;

  // 双星命中区大一点（用上一帧投影，误差一帧可忽略）
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  const cx = cssW / 2, cy = cssH / 2 + 14;
  const R = Math.min(cssW, cssH) * 0.40 * view.scale;
  const siny = Math.sin(view.yaw), cosy = Math.cos(view.yaw);
  const sinp = Math.sin(view.pitch), cosp = Math.cos(view.pitch);
  for (const c of CORE) {
    const p = project(c.x, c.y, c.z, cx, cy, R, siny, cosy, sinp, cosp);
    if (Math.hypot(p.sx - tx, p.sy - ty) < 20) {
      selectedId = "core:" + c.who;
      return showCoreDetail(c.who);
    }
  }

  // 数据星：命中半径随投影大小，多命中取离观察者最近的
  let hit = null;
  let bestZ = Infinity;
  for (const pc of projCache) {
    const rr = Math.max(13, pc.node.r * pc.persp * 0.62 * 2.4);
    if (Math.hypot(pc.sx - tx, pc.sy - ty) < rr && pc.z < bestZ) {
      bestZ = pc.z;
      hit = pc.node;
    }
  }
  if (hit) {
    selectedId = hit.entity.id;
    showEntityDetail(hit.entity.id);
  } else {
    selectedId = null;
    hideEntityDetail();
  }
}

// —— 详情面板（沿用原有 DOM 与接口） —— //
async function showEntityDetail(id) {
  const token = localStorage.getItem("home_token") || "";
  try {
    const res = await fetch(`/api/memory/entity/${id}?token=${encodeURIComponent(token)}`);
    if (!res.ok) return;
    const detail = await res.json();
    document.getElementById("detailKind").textContent = KIND_META[detail.kind]?.label || detail.kind;
    document.getElementById("detailName").textContent = detail.name;
    document.getElementById("detailProfile").hidden = true;  // 普通实体没有 profile
    renderFragments(detail.fragments, "还没有关于这里的碎片。");
    document.getElementById("memoryDetail").hidden = false;
  } catch {
    /* 静默失败 */
  }
}

async function showCoreDetail(who) {
  const token = localStorage.getItem("home_token") || "";
  try {
    const res = await fetch(`/api/memory/core/${who}?token=${encodeURIComponent(token)}`);
    if (!res.ok) return;
    const detail = await res.json();
    document.getElementById("detailKind").textContent = "双星";
    document.getElementById("detailName").textContent = detail.name;
    const profileEl = document.getElementById("detailProfile");
    if (detail.profile) {
      profileEl.textContent = detail.profile;
      profileEl.classList.remove("detail-profile-empty");
    } else {
      profileEl.textContent = `还没有 ${detail.name} 的 profile。跟麦穗说一声让他给你写进 data/profile-${who}.md。`;
      profileEl.classList.add("detail-profile-empty");
    }
    profileEl.hidden = false;
    renderFragments(detail.fragments, `暂无关于 ${detail.name} 的碎片记忆。`);
    document.getElementById("memoryDetail").hidden = false;
  } catch {
    /* 静默失败 */
  }
}

function renderFragments(fragments, emptyText) {
  const list = document.getElementById("detailFragments");
  list.innerHTML = "";
  if (!fragments.length) {
    const empty = document.createElement("div");
    empty.className = "detail-frag";
    empty.textContent = emptyText;
    list.appendChild(empty);
    return;
  }
  const title = document.createElement("div");
  title.className = "detail-frag-section-title";
  title.textContent = `${fragments.length} 条碎片`;
  list.appendChild(title);
  for (const f of fragments) {
    const div = document.createElement("div");
    div.className = "detail-frag";
    const text = document.createElement("div");
    text.textContent = f.text;
    const meta = document.createElement("div");
    meta.className = "detail-frag-meta";
    meta.textContent = friendlyAge(f.ageDays);
    div.append(text, meta);
    list.appendChild(div);
  }
}

function hideEntityDetail() {
  document.getElementById("memoryDetail").hidden = true;
  selectedId = null;
}

function friendlyAge(days) {
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days <= 7) return days + " 天前";
  if (days <= 30) return days + " 天前";
  if (days <= 60) return "一个多月前";
  if (days <= 120) return "两三个月前";
  if (days <= 240) return "半年多前";
  if (days <= 400) return "去年";
  return "很久以前";
}

// 进入记忆库时惰性绑定手势（canvas 不存在时会跳过）
window.attachStarmapGestures = attachStarmapGestures;
window.renderStarmap = renderStarmap;
