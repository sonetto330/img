// 记忆星图 — 布局与渲染
// 布局思路参考 MemoryConstellations（MIT，Clara Shafiq & Draco Malfoy）js/memory/layout.js
// 简化到只有一层视图：5 个 kind galaxy 环绕中间双星（泽 + 麦穗）

/* global memoryGraph */

const KIND_META = {
  person:  { label: "社交", color: "#e8ba6a", angleDeg: 270 }, // 正上
  place:   { label: "地点", color: "#8ac2ea", angleDeg: 342 }, // 右上
  event:   { label: "事件", color: "#e8846a", angleDeg:  54 }, // 右下
  hobby:   { label: "爱好", color: "#c19aea", angleDeg: 126 }, // 左下
  project: { label: "项目", color: "#7fdea3", angleDeg: 198 }, // 左上
};
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

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

// 按 kind 分组，每组做种子化 sunflower spiral 摆位。同一实体每次刷新位置稳定。
function buildLayout(W, H, entities) {
  const cx = W / 2, cy = H / 2;
  const orbit = Math.min(W, H) * 0.33;
  const positions = new Map();
  const groups = {};
  for (const e of entities) {
    (groups[e.kind] || (groups[e.kind] = [])).push(e);
  }
  for (const kind of Object.keys(groups)) {
    const meta = KIND_META[kind] || KIND_META.person;
    const list = groups[kind].slice().sort(
      (a, b) => (b.fragmentCount || 0) - (a.fragmentCount || 0),
    );
    const ang = (meta.angleDeg * Math.PI) / 180;
    // 横屏适度拉长，避免星系挤在中间
    const gx = cx + Math.cos(ang) * orbit * (W > H ? 1.25 : 0.9);
    const gy = cy + Math.sin(ang) * orbit;
    const nebulaR = Math.min(W, H) * 0.17 + Math.sqrt(list.length + 1) * 6;
    const r = seededRng(hashStr(kind));
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const a = i * GOLDEN + r() * 0.4;
      const dist = nebulaR * 0.78 * Math.sqrt((i + 0.5) / Math.max(list.length, 1));
      const size = Math.min(9, 2.5 + Math.sqrt((e.fragmentCount || 0) + 1) * 1.8);
      positions.set(e.id, {
        entity: e,
        x: gx + Math.cos(a) * dist,
        y: gy + Math.sin(a) * dist,
        r: size,
        color: meta.color,
      });
    }
  }
  return { cx, cy, positions };
}

// 背景星尘（静态，按尺寸缓存）
let _bgCache = null;
function backgroundStars(W, H) {
  if (_bgCache && _bgCache.W === W && _bgCache.H === H) return _bgCache.list;
  const list = [];
  const r = seededRng(42);
  const n = Math.max(60, Math.floor((W * H) / 4500));
  for (let i = 0; i < n; i++) {
    list.push({
      x: r() * W,
      y: r() * H,
      r: r() * 0.9 + 0.2,
      alpha: r() * 0.55 + 0.15,
    });
  }
  _bgCache = { W, H, list };
  return list;
}

// 当前布局，暴露给 I.3 交互层做点击命中测试
window.starmapLayout = null;

function renderStarmap() {
  const canvas = document.getElementById("memoryCanvas");
  const graph = window.memoryGraph;
  if (!canvas || !graph) return;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW === 0 || cssH === 0) {
    // 视图刚打开，DOM 还没量出来，下一帧再来
    requestAnimationFrame(renderStarmap);
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // 底 + 星尘
  ctx.fillStyle = "#0d0f18";
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.fillStyle = "#e0d5b8";
  for (const s of backgroundStars(cssW, cssH)) {
    ctx.globalAlpha = s.alpha;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const entities = graph.entities || [];
  const links = graph.links || [];
  const layout = buildLayout(cssW, cssH, entities);
  window.starmapLayout = layout;

  // 桥线（先画，落在圆下）
  ctx.strokeStyle = "rgba(200, 190, 160, 0.22)";
  for (const link of links) {
    const a = layout.positions.get(link.a);
    const b = layout.positions.get(link.b);
    if (!a || !b) continue;
    ctx.lineWidth = Math.min(2.4, 0.4 + Math.log2(1 + link.weight) * 0.5);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // 实体
  ctx.font = '12px "Songti SC", "SimSun", serif';
  ctx.textAlign = "center";
  for (const p of layout.positions.values()) {
    // 光晕
    const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 3.2);
    glow.addColorStop(0, p.color + "b0");
    glow.addColorStop(1, p.color + "00");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * 3.2, 0, Math.PI * 2);
    ctx.fill();
    // 主圆
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
    // 名字
    ctx.fillStyle = "#f0e7d3";
    ctx.fillText(p.entity.name, p.x, p.y + p.r + 14);
  }

  // 中间双星（泽 + 麦穗）
  drawCore(ctx, layout.cx - 9, layout.cy, "#f5cf7a", "泽");
  drawCore(ctx, layout.cx + 9, layout.cy, "#e6a468", "麦穗");
}

function drawCore(ctx, x, y, color, label) {
  const glow = ctx.createRadialGradient(x, y, 0, x, y, 24);
  glow.addColorStop(0, color + "cc");
  glow.addColorStop(1, color + "00");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, 24, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = '11px "Songti SC", "SimSun", serif';
  ctx.textAlign = "center";
  ctx.fillStyle = "#f0e7d3";
  ctx.fillText(label, x, y + 24);
}

// 尺寸变化重画（旋转手机、桌面窗口拖动）
window.addEventListener("resize", () => {
  if (!document.getElementById("memoryView").hidden) renderStarmap();
});

window.renderStarmap = renderStarmap;
