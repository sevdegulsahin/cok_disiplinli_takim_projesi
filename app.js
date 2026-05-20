// ================================================================
// app.js – EcoRoute Smart Campus Waste Management
// ================================================================

let IS_DEMO = true;
let supabaseClient = null;

function connectSupabase() {
  const hasUrl = typeof SUPABASE_URL !== 'undefined' && !SUPABASE_URL.startsWith('YOUR_');
  const hasKey = typeof SUPABASE_ANON_KEY !== 'undefined' && !SUPABASE_ANON_KEY.startsWith('YOUR_');
  const hasLib = !!window.supabase;
  IS_DEMO = !(hasUrl && hasKey && hasLib);
  if (!IS_DEMO) {
    try {
      supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    } catch (e) {
      console.warn('Supabase başlatılamadı:', e.message);
      IS_DEMO = true;
    }
  }
}

// ── State ────────────────────────────────────────────────────────
let bins = [];
let collectionCount = 0;
let autoFillTimer = null;
let selectedBinId = null;
let currentRoute = [];
let routeAnimOffset = 0;
let routeAnimFrame = null;

// ── DOM refs ─────────────────────────────────────────────────────
const binsGrid = document.getElementById('binsGrid');
const valAvgFill = document.getElementById('valAvgFill');
const valCritical = document.getElementById('valCritical');
const valCollections = document.getElementById('valCollections');

const routeEmpty = document.getElementById('routeEmpty');
const routeList = document.getElementById('routeList');
const routeInfo = document.getElementById('routeInfo');
const routeTime = document.getElementById('routeTime');
const routeWaste = document.getElementById('routeWaste');

const historyList = document.getElementById('historyList');
const toast = document.getElementById('toast');

const simModal = document.getElementById('simModal');
const binModal = document.getElementById('binModal');
const binModalTitle = document.getElementById('binModalTitle');
const binModalContent = document.getElementById('binModalContent');
const mapAvgFill = document.getElementById('mapAvgFill');
const mapCritical = document.getElementById('mapCritical');
const mapHotspot = document.getElementById('mapHotspot');
const mapRouteStatus = document.getElementById('mapRouteStatus');

// ── Map Config ───────────────────────────────────────────────────
const DEPOT = { id: 'depot', x: 0.50, y: 0.87, label: 'Merkezi Depo', type: 'depot' };

// ── Road Network Graph ───────────────────────────────────────────
const NODES = {
  depot:     { x: 0.50, y: 0.87, label: 'Merkezi Depo', type: 'depot' },
  kutuphane:{ x: 0.14, y: 0.19, label: 'Kütüphane',      type: 'bin' },
  ders:      { x: 0.50, y: 0.41, label: 'Ders Binası',    type: 'bin' },
  yemekhane:{ x: 0.86, y: 0.23, label: 'Yemekhane',      type: 'bin' },
  nW:        { x: 0.28, y: 0.29, label: '',               type: 'junction' },
  nE:        { x: 0.72, y: 0.29, label: '',               type: 'junction' },
  nS:        { x: 0.50, y: 0.65, label: '',               type: 'junction' },
  nN:        { x: 0.50, y: 0.13, label: '',               type: 'junction' },
};
// bin location name → node key mapping
const BIN_NODE_MAP = {
  'Kütüphane':   'kutuphane',
  'Ders Binası': 'ders',
  'Yemekhane':   'yemekhane',
};

function getBinPosition(bin) {
  const key = BIN_NODE_MAP[bin.location];
  return key ? NODES[key] : { x: 0.5, y: 0.5 };
}

function getBinNodeKey(bin) {
  return BIN_NODE_MAP[bin.location] || null;
}

// Road edges: undirected graph with cost & type
const EDGES = [
  // ── Main ring (clockwise) ──
  { f:'depot', t:'nS', cost:11, type:'main' },
  { f:'nS', t:'nW', cost:17, type:'main' },
  { f:'nW', t:'kutuphane', cost:9, type:'main' },
  { f:'nW', t:'ders', cost:13, type:'main' },
  { f:'ders', t:'nE', cost:13, type:'main' },
  { f:'nE', t:'yemekhane', cost:9, type:'main' },
  { f:'nE', t:'nS', cost:21, type:'main' },
  { f:'nS', t:'depot', cost:7, type:'main' },

  // ── Inner ring / shortcuts ──
  { f:'kutuphane', t:'nN', cost:7, type:'main' },
  { f:'nN', t:'yemekhane', cost:16, type:'main' },
  { f:'nN', t:'ders', cost:14, type:'main' },
  { f:'ders', t:'nS', cost:14, type:'main' },

  // ── Side roads (alternate routes, higher cost) ──
  { f:'depot', t:'ders', cost:24, type:'side' },
  { f:'depot', t:'nS', cost:18, type:'side' },
  { f:'kutuphane', t:'ders', cost:26, type:'side' },
  { f:'ders', t:'yemekhane', cost:28, type:'side' },
  { f:'nW', t:'nE', cost:30, type:'side' },
  { f:'nN', t:'nW', cost:18, type:'side' },
  { f:'nN', t:'nE', cost:18, type:'side' },
];

let adjList = {};

function buildAdjList() {
  adjList = {};
  for (const e of EDGES) {
    if (!adjList[e.f]) adjList[e.f] = [];
    if (!adjList[e.t]) adjList[e.t] = [];
    adjList[e.f].push({ to: e.t, cost: e.cost, type: e.type });
    adjList[e.t].push({ to: e.f, cost: e.cost, type: e.type });
  }
}
buildAdjList();

let mapCanvas, mapCtx, mapW, mapH = 420;

// ── Bootstrap ────────────────────────────────────────────────────
async function init() {
  connectSupabase();
  renderBinsOffline();
  setupEventListeners();
  initMap();

  if (!IS_DEMO) {
    await loadBinsFromSupabase();
    setupRealtime();
    loadCollectionHistory();
    ensureHistoryTable();
    await loadHistoryData();
    startHistorySnapshot();
  } else {
    loadLocalHistory();
    startHistorySnapshot();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// ══════════════════════════════════════════════════════════════════
// MAP – road network canvas renderer
// ══════════════════════════════════════════════════════════════════

function initMap() {
  mapCanvas = document.getElementById('campusMap');
  if (!mapCanvas) return;
  resizeMapCanvas();
  drawMap();

  window.addEventListener('resize', () => {
    if (document.getElementById('panel-map').classList.contains('active')) {
      resizeMapCanvas(); drawMap();
    }
  });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`panel-${target}`).classList.add('active');
      if (target === 'map') setTimeout(() => { resizeMapCanvas(); drawMap(); }, 50);
      if (target === 'charts') setTimeout(renderCharts, 50);
    });
  });

  mapCanvas.addEventListener('click', e => {
    const rect = mapCanvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width * mapW;
    const my = (e.clientY - rect.top) / rect.height * mapH;
    for (const bin of bins) {
      const p = getBinPosition(bin);
      if (Math.hypot(mx - p.x * mapW, my - p.y * mapH) < 24) { openBinDetail(bin.id); return; }
    }
  });
  mapCanvas.addEventListener('mousemove', e => {
    if (!mapCanvas) return;
    const rect = mapCanvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width * mapW;
    const my = (e.clientY - rect.top) / rect.height * mapH;
    let over = false;
    for (const bin of bins) {
      const p = getBinPosition(bin);
      if (Math.hypot(mx - p.x * mapW, my - p.y * mapH) < 24) { over = true; break; }
    }
    mapCanvas.style.cursor = over ? 'pointer' : 'default';
  });
}

function resizeMapCanvas() {
  if (!mapCanvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cw = mapCanvas.parentElement.getBoundingClientRect().width;
  const compact = window.matchMedia('(max-width: 680px)').matches;
  mapW = cw;
  mapH = compact
    ? Math.min(440, Math.max(340, Math.round(cw * 0.88)))
    : Math.min(560, Math.max(420, Math.round(cw * 0.52)));
  mapCanvas.width = cw * dpr; mapCanvas.height = mapH * dpr;
  mapCanvas.style.width = cw + 'px'; mapCanvas.style.height = mapH + 'px';
  mapCtx = mapCanvas.getContext('2d');
  mapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ── Bezier control point for a curved road between two nodes ──
function roadControlPoint(a, b, curvature = 0.35) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const dx = b.x - a.x, dy = b.y - a.y;
  // perpendicular offset
  const px = -dy * curvature, py = dx * curvature;
  return { x: mx + px, y: my + py };
}

function drawRoad(ctx, nA, nB, style) {
  const ax = nA.x * mapW, ay = nA.y * mapH;
  const bx = nB.x * mapW, by = nB.y * mapH;
  const cp = roadControlPoint(nA, nB, style.type === 'main' ? 0.25 : 0.4);

  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.quadraticCurveTo(cp.x * mapW, cp.y * mapH, bx, by);
  ctx.strokeStyle = style.color;
  ctx.lineWidth = style.width;
  ctx.lineCap = 'round';
  if (style.dash) ctx.setLineDash(style.dash);
  else ctx.setLineDash([]);
  ctx.lineDashOffset = style.dashOffset || 0;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
}

function routeNodeOrder(binRoute) {
  return ['depot', ...binRoute.map(b => getBinNodeKey(b)).filter(Boolean), 'depot'];
}

function buildShortestEdgePath(nodeKeys) {
  const edges = [];
  for (let i = 0; i < nodeKeys.length - 1; i++) {
    const graphPath = shortestGraphPath(nodeKeys[i], nodeKeys[i + 1]);
    if (!graphPath) continue;
    edges.push(...buildEdgePathFromNodes(graphPath));
  }
  return edges;
}

// ── Full map render ──
function drawMap() {
  if (!mapCtx) return;
  const ctx = mapCtx, W = mapW, H = mapH;

  // ── Background layers ──
  ctx.clearRect(0, 0, W, H);

  // Base dark
  ctx.fillStyle = '#0c0a09';
  ctx.fillRect(0, 0, W, H);

  // Subtle grass/terrain patches
  [
    { x: 0.12, y: 0.12, r: 0.13 },
    { x: 0.82, y: 0.15, r: 0.11 },
    { x: 0.30, y: 0.70, r: 0.10 },
    { x: 0.70, y: 0.72, r: 0.09 },
    { x: 0.50, y: 0.28, r: 0.08 },
  ].forEach(g => {
    const grd = ctx.createRadialGradient(g.x * W, g.y * H, 0, g.x * W, g.y * H, g.r * Math.min(W, H));
    grd.addColorStop(0, 'rgba(34,60,34,0.07)');
    grd.addColorStop(1, 'rgba(12,10,9,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, W, H);
  });

  // Paved area hint (lighter around roads)
  ctx.fillStyle = 'rgba(180,160,130,0.03)';
  ctx.fillRect(W * 0.06, H * 0.06, W * 0.88, H * 0.86);

  // Fine grid
  ctx.strokeStyle = 'rgba(255,245,220,0.02)';
  ctx.lineWidth = 0.5;
  for (let x = 0; x < W; x += 24) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 24) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // ── Draw ALL road edges first (underneath everything) ──
  const drawnEdges = new Set();
  for (const e of EDGES) {
    const key = [e.f, e.t].sort().join('|');
    if (drawnEdges.has(key)) continue;
    drawnEdges.add(key);

    const nA = NODES[e.f], nB = NODES[e.t];
    const isMain = e.type === 'main';

    // Road "bed" (slightly wider, darker underneath)
    drawRoad(ctx, nA, nB, {
      color: isMain ? 'rgba(140,110,70,0.18)' : 'rgba(100,80,55,0.12)',
      width: isMain ? 9 : 5,
      type: e.type,
    });
    // Road surface
    drawRoad(ctx, nA, nB, {
      color: isMain ? '#b8956a' : '#8a7356',
      width: isMain ? 5 : 3,
      type: e.type,
    });
    // Center line (dashed white)
    if (isMain) {
      drawRoad(ctx, nA, nB, {
        color: 'rgba(255,250,240,0.12)',
        width: 1,
        dash: [6, 8],
        type: e.type,
      });
    }
  }

  // ── Junction nodes (small circles at intersections) ──
  Object.entries(NODES).forEach(([key, node]) => {
    if (node.type === 'junction') {
      const cx = node.x * W, cy = node.y * H;
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#a08560';
      ctx.fill();
    }
  });

  // ── Buildings ──
  bins.forEach(bin => {
    const p = getBinPosition(bin);
    const cx = p.x * W, cy = p.y * H;
    const bw = Math.min(118, W * 0.16), bh = 48;

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    roundedRect(ctx, cx - bw / 2 + 3, cy - bh / 2 + 3, bw, bh, 8);
    ctx.fill();

    // Building body
    ctx.fillStyle = '#1c1916';
    ctx.strokeStyle = 'rgba(200,175,135,0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    roundedRect(ctx, cx - bw / 2, cy - bh / 2, bw, bh, 8);
    ctx.fill(); ctx.stroke();

    // Roof accent line
    ctx.strokeStyle = 'rgba(184,149,106,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - bw / 2 + 6, cy - bh / 2 + 3);
    ctx.lineTo(cx + bw / 2 - 6, cy - bh / 2 + 3);
    ctx.stroke();

    // Label above building
    ctx.fillStyle = '#9a8b7a';
    ctx.font = '600 11px Sora, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(bin.location, cx, cy - bh / 2 - 5);
  });

  // ── Alternative routes (faded, shown when route exists) ──
  if (currentRoute.length > 0 && altRoutes.length > 0) {
    altRoutes.forEach((alt, idx) => {
      alt.path.forEach((seg, si) => {
        const nA = NODES[seg.from], nB = NODES[seg.to];
        drawRoad(ctx, nA, nB, {
          color: idx === 0 ? 'rgba(250,204,21,0.22)' : 'rgba(96,165,250,0.18)',
          width: 2.5,
          dash: [4, 5],
          type: seg.type,
        });
      });
    });
  }

  // ── Active route (animated green dashed on top) ──
  if (currentRoute.length > 0) {
    const rpNodes = routeNodeOrder(currentRoute);
    const routeEdges = buildShortestEdgePath(rpNodes);
    routeEdges.forEach(seg => {
      const nA = NODES[seg.from], nB = NODES[seg.to];
      drawRoad(ctx, nA, nB, {
        color: '#22c55e',
        width: 4,
        dash: [10, 6],
        dashOffset: -routeAnimOffset,
        type: seg.type,
      });
    });

    for (let i = 0; i < rpNodes.length - 1; i++) {
      const graphPath = shortestGraphPath(rpNodes[i], rpNodes[i + 1]);
      if (!graphPath || graphPath.length < 2) continue;
      const first = NODES[graphPath[0]], last = NODES[graphPath[graphPath.length - 1]];
      const cp = roadControlPoint(first, last, 0.28);
      const legCost = graphPathCost(graphPath);

      // Direction dot with leg number
      ctx.beginPath();
      ctx.arc(cp.x * W, cp.y * H, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#22c55e';
      ctx.fill();
      ctx.font = 'bold 9px Sora, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#0c0a09';
      ctx.fillText(String(i + 1), cp.x * W, cp.y * H);

      ctx.font = '600 9px Figtree, sans-serif';
      ctx.fillStyle = 'rgba(196,240,196,0.78)';
      ctx.fillText(`${legCost}m`, cp.x * W, cp.y * H + 15);
    }

    currentRoute.forEach((bin, i) => {
      const p = getBinPosition(bin);
      const bx = p.x * W + 20, by = p.y * H - 23;
      ctx.beginPath();
      ctx.arc(bx, by, 10, 0, Math.PI * 2);
      ctx.fillStyle = '#22c55e';
      ctx.fill();
      ctx.strokeStyle = '#0c0a09';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#0c0a09';
      ctx.font = '800 10px Sora, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), bx, by);
    });
  }

  // ── Bin markers (on top of everything) ──
  bins.forEach(bin => {
    const p = getBinPosition(bin);
    const cx = p.x * W, cy = p.y * H;
    const fill = avgFill(bin), status = binStatus(fill);
    const color = status === 'critical' ? '#ef4444' : status === 'warning' ? '#f59e0b' : '#22c55e';

    // Outer glow
    ctx.beginPath(); ctx.arc(cx, cy, 24, 0, Math.PI * 2);
    ctx.fillStyle = color + '14'; ctx.fill();

    // Ring
    ctx.beginPath(); ctx.arc(cx, cy, 19, 0, Math.PI * 2);
    ctx.fillStyle = '#12100e'; ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.stroke();

    // Fill % text
    ctx.fillStyle = color;
    ctx.font = 'bold 12px Sora, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(fill + '%', cx, cy);
  });

  // ── Depot marker ──
  const dx = DEPOT.x * W, dy = DEPOT.y * H, dw = 96, dh = 38;
  ctx.fillStyle = '#181614';
  ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 2;
  ctx.beginPath();
  roundedRect(ctx, dx - dw / 2, dy - dh / 2, dw, dh, 7);
  ctx.fill(); ctx.stroke();
  // Depot icon stripe
  ctx.fillStyle = '#22c55e';
  ctx.fillRect(dx - dw / 2 + 4, dy - dh / 2 + 4, dw - 8, 4);
  ctx.fillStyle = '#c4f0c4';
  ctx.font = 'bold 10px Sora, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('DEPO', dx, dy + 3);

  // ── Legend ──
  drawLegend(ctx, W);
}

function drawLegend(ctx, W) {
  const lx = W - 148, ly = 12, lw = 138, lh = 114;

  // Panel bg
  ctx.fillStyle = 'rgba(14,12,10,0.92)';
  ctx.beginPath();
  roundedRect(ctx, lx, ly, lw, lh, 7);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,245,220,0.06)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.font = '600 9px Sora, sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';

  const items = [
    { color: '#22c55e', label: 'Normal (<%55)',   type: 'dot' },
    { color: '#f59e0b', label: 'Uyarı (%55–80)',  type: 'dot' },
    { color: '#ef4444', label: 'Kritik (%80+)',   type: 'dot' },
    { color: '#b8956a', label: 'Ana Yol',       type: 'road-main' },
    { color: '#8a7356', label: 'Yan Yol',       type: 'road-side' },
    { color: '#22c55e', label: 'Rota (en kısa)',  type: 'route' },
    { color: '#fac832', label: 'Alternatif rota',type: 'route-alt' },
  ];

  items.forEach((it, i) => {
    const iy = ly + 15 + i * 13;
    if (it.type === 'dot') {
      ctx.beginPath(); ctx.arc(lx + 14, iy, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = it.color + '28'; ctx.fill();
      ctx.strokeStyle = it.color; ctx.lineWidth = 1.5; ctx.stroke();
    } else if (it.type === 'road-main') {
      ctx.strokeStyle = it.color; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(lx + 7, iy); ctx.lineTo(lx + 27, iy); ctx.stroke();
    } else if (it.type === 'road-side') {
      ctx.strokeStyle = it.color; ctx.lineWidth = 2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(lx + 7, iy); ctx.lineTo(lx + 27, iy); ctx.stroke();
    } else if (it.type === 'route') {
      ctx.strokeStyle = it.color; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(lx + 7, iy); ctx.lineTo(lx + 27, iy); ctx.stroke();
      ctx.setLineDash([]);
    } else if (it.type === 'route-alt') {
      ctx.strokeStyle = it.color; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(lx + 7, iy); ctx.lineTo(lx + 27, iy); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = '#8a8578';
    ctx.fillText(it.label, lx + 36, iy);
  });
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
}

// ── Route animation ──
let altRoutes = [];

function startRouteAnimation() {
  if (routeAnimFrame) cancelAnimationFrame(routeAnimFrame);
  routeAnimOffset = 0;
  (function animate() {
    routeAnimOffset += 0.45;
    if (routeAnimOffset > 16) routeAnimOffset = 0;
    drawMap();
    routeAnimFrame = requestAnimationFrame(animate);
  })();
}

function stopRouteAnimation() {
  if (routeAnimFrame) { cancelAnimationFrame(routeAnimFrame); routeAnimFrame = null; }
  currentRoute = []; altRoutes = [];
  routeAnimOffset = 0;
  updateMapSummary();
}

// ══════════════════════════════════════════════════════════════════
// SHORTEST ROUTE — Dijkstra on road network + TSP permutations
// ══════════════════════════════════════════════════════════════════

function graphPathCost(nodePath) {
  let total = 0;
  for (let i = 0; i < nodePath.length - 1; i++) {
    const edges = adjList[nodePath[i]] || [];
    const edge = edges.find(e => e.to === nodePath[i + 1]);
    total += edge ? edge.cost : 999;
  }
  return total;
}

// Dijkstra: single-source shortest paths from `startNode`
function dijkstra(startNode) {
  const dist = {}, prev = {};
  const Q = new Set(Object.keys(NODES));
  for (const k of Q) { dist[k] = Infinity; }
  dist[startNode] = 0;

  while (Q.size > 0) {
    let u = null, minD = Infinity;
    for (const k of Q) { if (dist[k] < minD) { minD = dist[k]; u = k; } }
    if (u === null || dist[u] === Infinity) break;
    Q.delete(u);

    for (const e of (adjList[u] || [])) {
      if (!Q.has(e.to)) continue;
      const alt = dist[u] + e.cost;
      if (alt < dist[e.to]) { dist[e.to] = alt; prev[e.to] = u; }
    }
  }
  return { dist, prev };
}

// Reconstruct path from Dijkstra results
function reconstructPath(prev, start, end) {
  const path = [end];
  let cur = end;
  while (cur !== start && cur !== undefined) {
    cur = prev[cur]; if (cur) path.unshift(cur);
  }
  return path[0] === start ? path : null;
}

// Find shortest path between two nodes on the road network
function shortestGraphPath(fromKey, toKey) {
  const { dist, prev } = dijkstra(fromKey);
  return reconstructPath(prev, fromKey, toKey);
}

// Total cost of visiting bins in order via road network
function graphRouteTotalCost(nodeOrder) {
  const nodes = nodeOrder.filter(Boolean);
  if (nodes.length === 0) return 0;
  const routeNodes = nodes[0] === 'depot' ? [...nodes] : ['depot', ...nodes];
  if (routeNodes[routeNodes.length - 1] !== 'depot') routeNodes.push('depot');

  let total = 0;
  for (let i = 0; i < routeNodes.length - 1; i++) {
    const path = shortestGraphPath(routeNodes[i], routeNodes[i + 1]);
    if (!path) return Infinity;
    total += graphPathCost(path);
  }
  return total;
}

function calculateShortestRoute() {
  const targetBins = bins.filter(b => avgFill(b) > 10);
  if (targetBins.length === 0) return [];

  const targetKeys = targetBins.map(b => getBinNodeKey(b)).filter(Boolean);

  // Brute-force TSP over bin orderings, using graph costs
  if (targetKeys.length <= 8) {
    let best = null, bestCost = Infinity;
    for (const perm of getPermutations(targetKeys)) {
      const c = graphRouteTotalCost(['depot', ...perm]);
      if (c < bestCost) { bestCost = c; best = perm; }
    }
    // Map back to bin objects
    return best.map(k => bins.find(b => getBinNodeKey(b) === k)).filter(Boolean);
  }

  // Fallback nearest-neighbor
  let unvisited = [...targetKeys], route = [], cur = 'depot';
  while (unvisited.length > 0) {
    const { dist } = dijkstra(cur);
    let best = null, bd = Infinity;
    for (const uk of unvisited) { if (dist[uk] < bd) { bd = dist[uk]; best = uk; } }
    route.push(best); cur = best;
    unvisited = unvisited.filter(u => u !== best);
  }
  return route.map(k => bins.find(b => getBinNodeKey(b) === k)).filter(Boolean);
}

// Find alternative routes (2nd and 3rd best)
function findAlternativeRoutes(bestBinRoute) {
  if (bestBinRoute.length === 0) return [];

  const targetKeys = bestBinRoute.map(b => getBinNodeKey(b)).filter(Boolean);
  const alternatives = [];

  // Collect all reasonable permutations with their costs
  const results = [];
  for (const perm of getPermutations(targetKeys)) {
    const cost = graphRouteTotalCost(['depot', ...perm]);
    results.push({ perm, cost });
  }
  results.sort((a, b) => a.cost - b.cost);

  // Take up to 2 alternatives that are meaningfully different (>10% cost difference)
  for (let i = 1; i < Math.min(results.length, 6); i++) {
    if (results[i].cost > results[0].cost * 1.08) {
      alternatives.push({
        cost: results[i].cost,
        path: buildShortestEdgePath(['depot', ...results[i].perm, 'depot']),
      });
    }
    if (alternatives.length >= 2) break;
  }
  return alternatives;
}

// Convert a sequence of node keys into a list of edge objects for drawing
function buildEdgePathFromNodes(nodeKeys) {
  const edges = [];
  for (let i = 0; i < nodeKeys.length - 1; i++) {
    const from = nodeKeys[i], to = nodeKeys[i + 1];
    // Find the cheapest direct edge
    const candidates = (adjList[from] || []).filter(e => e.to === to);
    if (candidates.length > 0) {
      candidates.sort((a, b) => a.cost - b.cost);
      edges.push({ from, to, cost: candidates[0].cost, type: candidates[0].type });
    }
  }
  return edges;
}

// Permutation helper
function getPermutations(arr) {
  if (arr.length <= 1) return [arr];
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const perm of getPermutations(rest)) result.push([arr[i], ...perm]);
  }
  return result;
}

// ══════════════════════════════════════════════════════════════════
// SUPABASE
// ══════════════════════════════════════════════════════════════════

async function loadBinsFromSupabase() {
  try {
    const { data: binData, error: binErr } = await supabaseClient
      .from('bins').select('*').order('name');
    if (binErr || !binData || binData.length === 0) {
      console.warn('Bins yuklenemedi, demo mod devam ediyor:', binErr?.message);
      return;
    }
    const { data: catData, error: catErr } = await supabaseClient
      .from('waste_categories').select('*');
    if (catErr || !catData) {
      console.warn('Kategoriler yuklenemedi:', catErr?.message);
      return;
    }
    bins = binData.map(b => ({ ...b, categories: catData.filter(c => c.bin_id === b.id) }));
    renderBins();
    updateStats();
    drawMap();
    showToast('✅ Supabase verisi yüklendi', 'success');
  } catch (e) {
    console.warn('Supabase hatasi, demo mod devam ediyor:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════════
// RENDER
// ══════════════════════════════════════════════════════════════════

function renderBins() {
  binsGrid.innerHTML = '';
  bins.forEach(bin => binsGrid.appendChild(createBinCard(bin)));
  drawMap();
}

function avgFill(bin) {
  if (!bin.categories || bin.categories.length === 0) return 0;
  const sum = bin.categories.reduce((acc, c) => acc + parseFloat(c.current_level), 0);
  return Math.round(sum / bin.categories.length);
}

function binStatus(fill) {
  if (fill >= 80) return 'critical';
  if (fill >= 55) return 'warning';
  return 'ok';
}

function createBinCard(bin) {
  const fill = avgFill(bin);
  const status = binStatus(fill);
  const card = document.createElement('div');
  card.className = `bin-card status-${status}`;
  card.dataset.binId = bin.id;
  const badgeText = status === 'critical' ? 'Kritik' : status === 'warning' ? 'Uyarı' : 'Normal';
  const badgeClass = `badge-${status}`;
  const gaugeClass = fill >= 80 ? 'critical' : fill >= 55 ? 'warning' : '';
  const catNames = { plastic: 'Plastik', paper: 'Kağıt', organic: 'Organik', glass: 'Cam', metal: 'Metal' };
  const catIcons = { plastic: '♳', paper: '📄', organic: '🌿', glass: '🍶', metal: '🥫' };

  const catsHtml = (bin.categories || []).map(cat => {
    const lvl = Math.round(parseFloat(cat.current_level));
    return `
      <div class="cat-row">
        <span class="cat-icon">${catIcons[cat.category] || '•'}</span>
        <span class="cat-name">${catNames[cat.category] || cat.category}</span>
        <div class="cat-track">
          <div class="cat-fill" style="width:${lvl}%;background:${cat.color_hex}"></div>
        </div>
        <span class="cat-pct" style="color:${cat.color_hex}">${lvl}%</span>
      </div>`;
  }).join('');

  card.innerHTML = `
    <div class="bin-card-top">
      <span class="bin-location-icon">${bin.location_icon}</span>
      <span class="bin-status-badge ${badgeClass}">${badgeText}</span>
    </div>
    <div class="bin-name">${bin.name}</div>
    <div class="bin-location">${bin.location}</div>
    <div class="overall-gauge">
      <div class="gauge-label"><span>Genel Doluluk</span><span>${fill}%</span></div>
      <div class="gauge-track">
        <div class="gauge-fill ${gaugeClass}" id="gf-${bin.id}" style="width:${fill}%"></div>
      </div>
    </div>
    <div class="categories-title">Atık Ayrıştırma</div>
    <div class="categories-list">${catsHtml}</div>
    <div class="bin-card-footer">
      <span>🏛️ ${bin.location}</span>
      <span>Detay için tıkla →</span>
    </div>`;

  card.addEventListener('click', () => openBinDetail(bin.id));
  return card;
}

function updateStats() {
  if (!bins.length) {
    updateMapSummary();
    return;
  }
  const fills = bins.map(avgFill);
  const avg = Math.round(fills.reduce((a, b) => a + b, 0) / fills.length);
  const critical = fills.filter(f => f >= 80).length;
  valAvgFill.textContent = avg + '%';
  valCritical.textContent = critical;
  valCollections.textContent = collectionCount;
  valAvgFill.style.color = avg >= 80 ? 'var(--danger)' : avg >= 55 ? 'var(--warning)' : 'var(--primary)';
  valCritical.style.color = critical > 0 ? 'var(--danger)' : 'var(--primary)';
  updateMapSummary();
}

function updateMapSummary() {
  if (!mapAvgFill || !mapCritical || !mapHotspot || !mapRouteStatus) return;
  if (!bins.length) {
    mapAvgFill.textContent = '–';
    mapCritical.textContent = '–';
    mapHotspot.textContent = '–';
    mapRouteStatus.textContent = 'Hazır';
    return;
  }

  const ranked = [...bins].sort((a, b) => avgFill(b) - avgFill(a));
  const fills = bins.map(avgFill);
  const avg = Math.round(fills.reduce((a, b) => a + b, 0) / fills.length);
  const critical = fills.filter(f => f >= 80).length;
  const hotspot = ranked[0];
  const routeCost = currentRoute.length
    ? graphRouteTotalCost(routeNodeOrder(currentRoute))
    : 0;

  mapAvgFill.textContent = avg + '%';
  mapCritical.textContent = String(critical);
  mapHotspot.textContent = hotspot ? `${hotspot.location_icon} ${hotspot.location} ${avgFill(hotspot)}%` : '–';
  mapRouteStatus.textContent = currentRoute.length
    ? `${currentRoute.length} durak / ${routeCost}m`
    : 'Hazır';
  mapAvgFill.style.color = avg >= 80 ? 'var(--danger)' : avg >= 55 ? 'var(--warning)' : 'var(--primary)';
  mapCritical.style.color = critical > 0 ? 'var(--danger)' : 'var(--primary)';
  mapRouteStatus.style.color = currentRoute.length ? 'var(--primary)' : 'var(--text-primary)';
}

// ══════════════════════════════════════════════════════════════════
// REALTIME
// ══════════════════════════════════════════════════════════════════

function setupRealtime() {
  supabaseClient
    .channel('waste_categories_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'waste_categories' }, async (payload) => {
      const changedCat = payload.new || payload.old;
      if (!changedCat) return;
      const binIndex = bins.findIndex(b => b.id === changedCat.bin_id);
      if (binIndex === -1) return;
      const { data } = await supabaseClient.from('waste_categories').select('*').eq('bin_id', changedCat.bin_id);
      if (data) {
        bins[binIndex].categories = data;
        const existing = binsGrid.querySelector(`[data-bin-id="${changedCat.bin_id}"]`);
        if (existing) binsGrid.replaceChild(createBinCard(bins[binIndex]), existing);
        updateStats();
        drawMap();
      }
    })
    .subscribe();
}

// ══════════════════════════════════════════════════════════════════
// BIN DETAIL MODAL
// ══════════════════════════════════════════════════════════════════

function openBinDetail(binId) {
  const bin = bins.find(b => b.id === binId);
  if (!bin) return;
  selectedBinId = binId;
  binModalTitle.textContent = bin.name;
  const fill = avgFill(bin);
  const fillColor = fill >= 80 ? 'var(--danger)' : fill >= 55 ? 'var(--warning)' : 'var(--primary)';
  const catNames = { plastic: 'Plastik', paper: 'Kağıt', organic: 'Organik', glass: 'Cam', metal: 'Metal' };
  const catIcons = { plastic: '♳', paper: '📄', organic: '🌿', glass: '🍶', metal: '🥫' };

  const catsHtml = (bin.categories || []).map(cat => {
    const lvl = Math.round(parseFloat(cat.current_level));
    return `
      <div class="detail-cat-card">
        <div class="detail-cat-top">
          <span class="detail-cat-name">${catIcons[cat.category]} ${catNames[cat.category]}</span>
          <span class="detail-cat-pct" style="color:${cat.color_hex}">${lvl}%</span>
        </div>
        <div class="detail-cat-bar">
          <div class="detail-cat-fill" style="width:${lvl}%;background:${cat.color_hex}"></div>
        </div>
      </div>`;
  }).join('');

  binModalContent.innerHTML = `
    <div class="detail-overview">
      <div class="detail-loc-icon">${bin.location_icon}</div>
      <div class="detail-info">
        <div class="detail-name">${bin.name}</div>
        <div class="detail-sub">📍 ${bin.location} • Kapasite: ${bin.capacity_liters}L</div>
      </div>
      <div style="text-align:right">
        <div class="detail-fill-val" style="color:${fillColor}">${fill}%</div>
        <div class="detail-fill-lbl">Doluluk</div>
      </div>
    </div>
    <div class="detail-categories">${catsHtml}</div>
    <p style="font-size:.75rem;color:var(--text-muted);margin-top:.4rem">
      Atık türü dolulukları bağımsız olarak izlenmektedir.
      Genel doluluk, tüm kategorilerin ortalamasıdır.
    </p>`;
  binModal.classList.remove('hidden');
}

document.getElementById('closeBinModal').addEventListener('click', () => {
  binModal.classList.add('hidden'); selectedBinId = null;
});
binModal.addEventListener('click', e => {
  if (e.target === binModal) { binModal.classList.add('hidden'); selectedBinId = null; }
});
document.getElementById('binCollectBtn').addEventListener('click', async () => {
  if (!selectedBinId) return;
  await collectBin(selectedBinId);
  binModal.classList.add('hidden'); selectedBinId = null;
});

// ══════════════════════════════════════════════════════════════════
// ROUTE GENERATION (shortest path)
// ══════════════════════════════════════════════════════════════════

document.getElementById('btnGenerateRoute').addEventListener('click', generateRoute);
const btnMapGenerateRoute = document.getElementById('btnMapGenerateRoute');
if (btnMapGenerateRoute) btnMapGenerateRoute.addEventListener('click', generateRoute);

function generateRoute() {
  if (!bins.length) return;

  const sorted = calculateShortestRoute();
  if (sorted.length === 0) {
    showToast('Tüm kovalar zaten boş (%10 altı).', 'warning');
    return;
  }

  currentRoute = sorted;
  altRoutes = findAlternativeRoutes(sorted);
  const totalFill = sorted.reduce((s, b) => s + avgFill(b), 0);

  routeEmpty.classList.add('hidden');
  routeList.classList.remove('hidden');
  routeInfo.classList.remove('hidden');

  routeList.innerHTML = '';
  sorted.forEach((bin, i) => {
    const fill = avgFill(bin), status = binStatus(fill);
    const pClass = status === 'critical' ? 'badge-critical' : status === 'warning' ? 'badge-warning' : 'badge-ok';
    const pText = status === 'critical' ? 'Kritik' : status === 'warning' ? 'Orta' : 'Düşük';

    // Find graph cost for this leg
    const fromKey = i === 0 ? 'depot' : getBinNodeKey(sorted[i - 1]);
    const toKey = getBinNodeKey(bin);
    const { dist } = dijkstra(fromKey);
    const legCost = Math.round(dist[toKey] || 0);

    const stop = document.createElement('div');
    stop.className = 'route-stop';
    stop.innerHTML = `
      <div class="stop-num">${i + 1}</div>
      <div class="stop-body">
        <div class="stop-name">${bin.location_icon} ${bin.location}</div>
        <div class="stop-fill">Doluluk: ${fill}% · ${legCost}m</div>
      </div>
      <span class="stop-priority ${pClass}">${pText}</span>`;
    routeList.appendChild(stop);
  });

  const totalGraphCost = graphRouteTotalCost(['depot', ...sorted.map(b => getBinNodeKey(b))]);
  const minutes = Math.max(5, Math.round(totalGraphCost / 7) + sorted.length * 4);
  routeTime.textContent = `~${minutes} dk (${totalGraphCost}m toplam)`;
  routeWaste.textContent = `~${Math.round(totalFill * 1.2)} L`;
  updateMapSummary();

  startRouteAnimation();
  showToast(`✅ En kısa rota (${totalGraphCost}m) bulundu${altRoutes.length > 0 ? ` — ${altRoutes.length} alternatif` : ''}!`, 'success');
  saveRoutePlan(sorted, totalFill);
}

async function saveRoutePlan(sorted, totalFill) {
  if (IS_DEMO || !supabase) return;
  try {
    await supabaseClient.from('route_plans').insert({
      route_order: sorted.map(b => ({ id: b.id, location: b.location, fill: avgFill(b) })),
      total_fill_score: totalFill,
      status: 'pending'
    });
  } catch (e) { console.warn('Rota kaydedilemedi:', e.message); }
}

// ── Start Route ──────────────────────────────────────────────────
document.getElementById('btnStartRoute').addEventListener('click', async () => {
  if (!currentRoute.length) return;
  for (const bin of currentRoute) {
    if (avgFill(bin) > 10) await collectBin(bin.id, false);
  }
  showToast('🚛 Rota tamamlandı! Tüm kovalar boşaltıldı.', 'success');
  addHistoryItem('Rota Tamamlandı', `${currentRoute.length} kova toplandı`);
  stopRouteAnimation();
  drawMap();
  routeList.classList.add('hidden');
  routeInfo.classList.add('hidden');
  routeEmpty.classList.remove('hidden');
});

// ══════════════════════════════════════════════════════════════════
// COLLECT
// ══════════════════════════════════════════════════════════════════

async function collectBin(binId, showMsg = true) {
  const bin = bins.find(b => b.id === binId);
  if (!bin) return;
  const levelsBefore = {};
  (bin.categories || []).forEach(c => { levelsBefore[c.category] = c.current_level; });

  if (IS_DEMO) {
    bin.categories.forEach(c => { c.current_level = 0; });
    if (showMsg) {
      collectionCount++;
      showToast(`🚛 ${bin.name} başarıyla toplandı!`, 'success');
      addHistoryItem(bin.name, 'Tüm kategoriler sıfırlandı');
    }
    renderBins(); updateStats();
    return;
  }

  await supabaseClient.from('collection_events').insert({
    bin_id: binId, collected_by: 'Sistem', levels_before: levelsBefore
  });
  for (const cat of (bin.categories || [])) {
    await supabaseClient.from('waste_categories')
      .update({ current_level: 0, updated_at: new Date().toISOString() })
      .eq('id', cat.id);
  }
  if (showMsg) {
    collectionCount++;
    showToast(`🚛 ${bin.name} başarıyla toplandı!`, 'success');
    addHistoryItem(bin.name, 'Tüm kategoriler sıfırlandı');
    updateStats();
  }
}

// ══════════════════════════════════════════════════════════════════
// HISTORY
// ══════════════════════════════════════════════════════════════════

async function loadCollectionHistory() {
  const { data } = await supabaseClient
    .from('collection_events').select('*, bins(name,location_icon)')
    .order('collected_at', { ascending: false }).limit(20);
  if (!data || data.length === 0) return;
  collectionCount = data.length;
  valCollections.textContent = collectionCount;
  historyList.innerHTML = '';
  data.forEach(ev => {
    const binName = ev.bins ? `${ev.bins.location_icon} ${ev.bins.name}` : 'Bilinmeyen';
    const time = new Date(ev.collected_at).toLocaleString('tr-TR');
    addHistoryItem(binName, time, false);
  });
}

function addHistoryItem(title, meta, prepend = true) {
  const p = historyList.querySelector('.history-empty');
  if (p) p.remove();
  const item = document.createElement('div');
  item.className = 'history-item';
  item.innerHTML = `
    <div class="history-item-title">🚛 ${title}</div>
    <div class="history-item-meta">${meta}</div>`;
  if (prepend) historyList.prepend(item);
  else historyList.appendChild(item);
}

// ══════════════════════════════════════════════════════════════════
// SIMULATION (per-bin controls)
// ══════════════════════════════════════════════════════════════════

function setupEventListeners() {
  document.getElementById('btnSimulate').addEventListener('click', () => {
    buildSimBinControls();
    simModal.classList.remove('hidden');
  });
  document.getElementById('closeSimModal').addEventListener('click', () => {
    simModal.classList.add('hidden');
  });
  simModal.addEventListener('click', e => {
    if (e.target === simModal) simModal.classList.add('hidden');
  });

  document.getElementById('simRandom').addEventListener('click', () => {
    const delta = Math.floor(Math.random() * 40) + 5;
    applySimulationAll(delta);
  });

  document.getElementById('autoFillToggle').addEventListener('change', e => {
    const status = document.getElementById('autoFillStatus');
    if (e.target.checked) {
      status.textContent = 'Açık';
      autoFillTimer = setInterval(() => {
        const delta = Math.floor(Math.random() * 8) + 2;
        applySimulationAll(delta);
      }, 5000);
    } else {
      status.textContent = 'Kapalı';
      clearInterval(autoFillTimer);
      autoFillTimer = null;
    }
  });
}

function buildSimBinControls() {
  const container = document.getElementById('simBinControls');
  container.innerHTML = '';

  bins.forEach(bin => {
    const fill = avgFill(bin);
    const status = binStatus(fill);
    const sClass = `badge-${status}`;
    const sText = status === 'critical' ? 'Kritik' : status === 'warning' ? 'Uyarı' : 'Normal';

    const card = document.createElement('div');
    card.className = 'sim-bin-card';
    card.dataset.binId = bin.id;
    card.innerHTML = `
      <div class="sim-bin-header">
        <span class="sim-bin-icon">${bin.location_icon}</span>
        <div class="sim-bin-info">
          <div class="sim-bin-name">${bin.name}</div>
          <div class="sim-bin-fill">Doluluk: <strong id="sim-fill-${bin.id}">${fill}%</strong></div>
        </div>
        <span class="bin-status-badge ${sClass}">${sText}</span>
      </div>
      <div class="sim-bin-actions">
        <button class="btn-sim-action fill" data-bin="${bin.id}" data-delta="10">+10%</button>
        <button class="btn-sim-action fill" data-bin="${bin.id}" data-delta="25">+25%</button>
        <button class="btn-sim-action fill" data-bin="${bin.id}" data-delta="50">+50%</button>
        <button class="btn-sim-action drain" data-bin="${bin.id}" data-delta="-100">Boşalt</button>
      </div>`;
    container.appendChild(card);
  });

  container.querySelectorAll('.btn-sim-action[data-bin]').forEach(btn => {
    btn.addEventListener('click', () => {
      applySimulationForBin(btn.dataset.bin, parseInt(btn.dataset.delta));
    });
  });
}

async function applySimulationForBin(binId, delta) {
  const catSel = document.getElementById('simCatSelect').value;
  const bin = bins.find(b => b.id === binId);
  if (!bin) return;

  const targetCats = catSel === 'all' ? bin.categories : bin.categories.filter(c => c.category === catSel);
  for (const cat of targetCats) {
    let newLevel = Math.min(100, Math.max(0, parseFloat(cat.current_level) + delta));
    if (!IS_DEMO) {
      await supabaseClient
        .from('waste_categories')
        .update({ current_level: newLevel, updated_at: new Date().toISOString() })
        .eq('id', cat.id);
    }
    cat.current_level = newLevel;
  }

  renderBins();
  updateStats();

  const fillEl = document.getElementById(`sim-fill-${binId}`);
  if (fillEl) fillEl.textContent = avgFill(bin) + '%';

  const action = delta > 0 ? `+${delta}%` : 'boşaltıldı';
  showToast(`⚡ ${bin.location}: ${action}`, delta < 0 ? 'warning' : 'success');
}

async function applySimulationAll(delta) {
  const catSel = document.getElementById('simCatSelect').value;
  for (const bin of bins) {
    const targetCats = catSel === 'all' ? bin.categories : bin.categories.filter(c => c.category === catSel);
    for (const cat of targetCats) {
      let d = Math.floor(Math.random() * delta) + 1;
      let newLevel = Math.min(100, Math.max(0, parseFloat(cat.current_level) + d));
      if (!IS_DEMO) {
        await supabaseClient
          .from('waste_categories')
          .update({ current_level: newLevel, updated_at: new Date().toISOString() })
          .eq('id', cat.id);
      }
      cat.current_level = newLevel;
    }
  }
  renderBins(); updateStats();
  buildSimBinControls();
  showToast(`⚡ Rastgele: +${delta}% dolduruldu`, 'success');
}

// ══════════════════════════════════════════════════════════════════
// DEMO FALLBACK
// ══════════════════════════════════════════════════════════════════

function renderBinsOffline() {
  collectionCount = 0;
  const CATS = [
    { category: 'plastic', current_level: 1, color_hex: '#3B82F6', icon: '♳' },
    { category: 'paper',   current_level: 1, color_hex: '#F59E0B', icon: '📄' },
    { category: 'organic', current_level: 1, color_hex: '#10B981', icon: '🌿' },
    { category: 'glass',   current_level: 1, color_hex: '#8B5CF6', icon: '🍶' },
    { category: 'metal',   current_level: 1, color_hex: '#6B7280', icon: '🥫' }
  ];
  bins = [
    { id: 'demo-1', name: 'Kütüphane Çöp Kovası', location: 'Kütüphane', location_icon: '📚', capacity_liters: 120, categories: CATS.map(c => ({ ...c, id: `d1-${c.category}`, bin_id: 'demo-1' })) },
    { id: 'demo-2', name: 'Ders Binası Çöp Kovası', location: 'Ders Binası', location_icon: '🏫', capacity_liters: 120, categories: CATS.map(c => ({ ...c, id: `d2-${c.category}`, bin_id: 'demo-2' })) },
    { id: 'demo-3', name: 'Yemekhane Çöp Kovası', location: 'Yemekhane', location_icon: '🍽️', capacity_liters: 120, categories: CATS.map(c => ({ ...c, id: `d3-${c.category}`, bin_id: 'demo-3' })) }
  ];
  renderBins();
  updateStats();
}

// ══════════════════════════════════════════════════════════════════
// TOAST
// ══════════════════════════════════════════════════════════════════

let toastTimer = null;
function showToast(msg, type = 'success') {
  toast.textContent = msg;
  toast.className = `toast ${type}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.classList.add('hidden'); }, 3500);
}

// ══════════════════════════════════════════════════════════════════
// HISTORY SNAPSHOTS + CHARTS
// ══════════════════════════════════════════════════════════════════

let historyData = [];
let snapshotTimer = null;
let chartOverall, chartBins, chartCategories;
const HISTORY_KEY = 'ecoroute_history';
const SNAPSHOT_INTERVAL = 60000;

function buildSnapshot() {
  return bins.map(b => ({
    id: b.id,
    name: b.name,
    avgFill: avgFill(b),
    categories: (b.categories || []).map(c => ({
      category: c.category,
      level: parseFloat(c.current_level),
      color: c.color_hex,
      icon: c.icon
    }))
  }));
}

async function ensureHistoryTable() {
  if (IS_DEMO || !supabaseClient) return;
  try {
    await supabaseClient.from('bin_level_history').select('id', { count: 'exact', head: true }).limit(1);
  } catch (e) {
    console.warn('bin_level_history tablosu bulunamadı, localStorage kullanılacak');
    IS_DEMO = true;
  }
}

async function saveSnapshot() {
  const snap = { t: Date.now(), data: buildSnapshot() };
  historyData.push(snap);
  if (historyData.length > 200) historyData = historyData.slice(-200);
  try {
    if (!IS_DEMO && supabaseClient) {
      await supabaseClient.from('bin_level_history').insert({ recorded_at: new Date().toISOString(), snapshot: snap.data });
    }
  } catch (e) {
    console.warn('Snapshot kaydedilemedi:', e.message);
  }
  saveLocalHistory();
}

function saveLocalHistory() {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(historyData.slice(-200))); } catch (_) {}
}

function loadLocalHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    historyData = raw ? JSON.parse(raw) : [];
  } catch (_) { historyData = []; }
  if (historyData.length === 0) {
    const snap = { t: Date.now() - 3600000, data: buildSnapshot() };
    historyData.push(snap);
    for (let i = 5; i >= 1; i--) {
      const s = { t: snap.t - i * 600000, data: JSON.parse(JSON.stringify(snap.data)) };
      s.data.forEach(b => {
        b.avgFill = Math.max(1, b.avgFill - Math.floor(Math.random() * 15));
        (b.categories || []).forEach(c => { c.level = Math.max(1, c.level - Math.floor(Math.random() * 12)); });
      });
      historyData.push(s);
    }
    historyData.push({ t: Date.now() - 1800000, data: JSON.parse(JSON.stringify(buildSnapshot())) });
    historyData.push({ t: Date.now() - 600000, data: JSON.parse(JSON.stringify(buildSnapshot())) });
    saveLocalHistory();
  }
}

async function loadHistoryData() {
  if (IS_DEMO) { loadLocalHistory(); return; }
  try {
    const { data, error } = await supabaseClient
      .from('bin_level_history')
      .select('recorded_at,snapshot')
      .order('recorded_at', { ascending: false })
      .limit(100);
    if (error || !data) { loadLocalHistory(); return; }
    historyData = data.reverse().map(row => ({ t: new Date(row.recorded_at).getTime(), data: row.snapshot }));
    if (historyData.length === 0) loadLocalHistory();
  } catch (_) { loadLocalHistory(); }
}

function startHistorySnapshot() {
  if (snapshotTimer) clearInterval(snapshotTimer);
  saveSnapshot();
  snapshotTimer = setInterval(saveSnapshot, SNAPSHOT_INTERVAL);
}

const CHART_COLORS = ['#22c55e','#3b82f6','#f59e0b','#ef4444','#8b5cf6'];
const CAT_LABELS = { plastic:'Plastik', paper:'Kağıt', organic:'Organik', glass:'Cam', metal:'Metal' };

function renderCharts() {
  if (typeof Chart === 'undefined') { console.warn('Chart.js yuklenmedi'); return; }
  const ctxO = document.getElementById('chartOverall')?.getContext('2d');
  const ctxB = document.getElementById('chartBins')?.getContext('2d');
  const ctxC = document.getElementById('chartCategories')?.getContext('2d');
  if (!ctxO || !ctxB || !ctxC) return;

  if (chartOverall) chartOverall.destroy();
  if (chartBins) chartBins.destroy();
  if (chartCategories) chartCategories.destroy();

  const sorted = [...historyData].sort((a,b) => a.t - b.t);
  const labels = sorted.map(s => new Date(s.t).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'}));
  const binNames = sorted.length ? sorted[sorted.length-1].data.map(b=>b.name) : [];

  const binDatasets = binNames.map((name, i) => ({
    label: name.replace(' Çöp Kovası',''),
    data: sorted.map(s => { const b = s.data.find(d=>d.name===name); return b ? b.avgFill : 0; }),
    borderColor: CHART_COLORS[i % CHART_COLORS.length],
    backgroundColor: CHART_COLORS[i % CHART_COLORS.length] + '18',
    fill: false,
    tension: 0.35,
    pointRadius: 3,
    pointHoverRadius: 6
  }));

  chartOverall = new Chart(ctxO, {
    type: 'line',
    data: { labels, datasets: [{ label:'Ortalama Doluluk (%)', data: sorted.map(s => { const avg = s.data.reduce((a,b)=>a+b.avgFill,0)/s.data.length; return Math.round(avg); }), borderColor:'#22c55e', backgroundColor:'#22c55e18', fill:true, tension:0.35, pointRadius:3 }] },
    options: {
      responsive:true,maintainAspectRatio:false,
      plugins:{ legend:{labels:{color:'#9ca3af',font:{family:'Figtree',size:11}}} },
      scales:{ x:{ticks:{color:'#6b7280',font:{size:10}},grid:{color:'#ffffff08'}}, y:{min:0,max:100,ticks:{color:'#6b7280'},grid:{color:'#ffffff08'}} }
    }
  });

  chartBins = new Chart(ctxB, {
    type: 'line',
    data: { labels, datasets: binDatasets },
    options: {
      responsive:true,maintainAspectRatio:false,
      plugins:{ legend:{labels:{color:'#9ca3af',font:{family:'Figtree',size:10}}} },
      scales:{ x:{ticks:{color:'#6b7280',font:{size:10},maxTicksLimit:8},grid:{color:'#ffffff08'}}, y:{min:0,max:100,ticks:{color:'#6b7280'},grid:{color:'#ffffff08'}} }
    }
  });

  const latest = sorted[sorted.length - 1];
  const catTotals = {};
  if (latest) latest.data.forEach(b => (b.categories||[]).forEach(c => { catTotals[c.category] = (catTotals[c.category]||0) + c.level; }));

  chartCategories = new Chart(ctxC, {
    type: 'bar',
    data: {
      labels: Object.keys(catTotals).map(k => CAT_LABELS[k]||k),
      datasets: [{
        label: 'Toplam Doluluk (%)',
        data: Object.values(catTotals).map(v => Math.round(v)),
        backgroundColor: ['#3B82F6','#F59E0B','#10B981','#8B5CF6','#6B7280'],
        borderRadius: 8,
        barThickness: 40
      }]
    },
    options: {
      responsive:true,maintainAspectRatio:false,indexAxis:'y',
      plugins:{ legend:{display:false} },
      scales:{ x:{min:0,ticks:{color:'#6b7280'},grid:{color:'#ffffff08'}}, y:{ticks:{color:'#9ca3af',font:{size:12}},grid:{display:false}} }
    }
  });
}
