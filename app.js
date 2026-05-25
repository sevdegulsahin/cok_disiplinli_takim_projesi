// ================================================================
// app.js – EcoRoute Smart Campus Waste Management
// ================================================================

let IS_DEMO = true;
let supabaseClient = null;
let DATA_MODE = 'demo';
let remoteHistoryAvailable = true;

function getSupabaseConfig() {
  return {
    url: window.SUPABASE_URL || (typeof SUPABASE_URL !== 'undefined' ? SUPABASE_URL : ''),
    key: window.SUPABASE_ANON_KEY || (typeof SUPABASE_ANON_KEY !== 'undefined' ? SUPABASE_ANON_KEY : ''),
  };
}

function connectSupabase() {
  const { url, key } = getSupabaseConfig();
  const hasUrl = !!url && !url.startsWith('YOUR_');
  const hasKey = !!key && !key.startsWith('YOUR_');

  if (!hasUrl || !hasKey) {
    IS_DEMO = true;
    DATA_MODE = 'demo';
    return;
  }

  try {
    const isLocal = ['127.0.0.1', 'localhost'].includes(window.location.hostname);
    if (isLocal) {
      supabaseClient = createSupabaseRestClient('/api/supabase', '');
      DATA_MODE = 'proxy';
    } else if (window.supabase?.createClient) {
      supabaseClient = window.supabase.createClient(url, key);
      DATA_MODE = 'supabase-js';
    } else {
      supabaseClient = createSupabaseRestClient(url, key);
      DATA_MODE = 'rest';
      console.warn('Supabase JS yüklenmedi; REST fallback kullanılacak.');
    }
    IS_DEMO = false;
  } catch (e) {
    console.warn('Supabase başlatılamadı:', e.message);
    supabaseClient = null;
    IS_DEMO = true;
    DATA_MODE = 'demo';
  }
}

function createSupabaseRestClient(baseUrl, anonKey) {
  const restUrl = baseUrl.startsWith('/')
    ? baseUrl.replace(/\/$/, '')
    : `${baseUrl.replace(/\/$/, '')}/rest/v1`;
  const baseHeaders = { 'Content-Type': 'application/json' };
  if (anonKey) {
    baseHeaders.apikey = anonKey;
    baseHeaders.Authorization = `Bearer ${anonKey}`;
  }

  class RestQuery {
    constructor(table) {
      this.table = table;
      this.method = 'GET';
      this.columns = '*';
      this.body = null;
      this.filters = [];
      this.sort = null;
      this.rowLimit = null;
      this.head = false;
      this.count = null;
    }

    select(columns = '*', opts = {}) {
      this.method = opts.head ? 'HEAD' : 'GET';
      this.columns = columns;
      this.head = !!opts.head;
      this.count = opts.count || null;
      return this;
    }

    insert(payload) {
      this.method = 'POST';
      this.body = payload;
      return this;
    }

    update(payload) {
      this.method = 'PATCH';
      this.body = payload;
      return this;
    }

    eq(column, value) {
      this.filters.push([column, `eq.${value}`]);
      return this;
    }

    order(column, opts = {}) {
      const dir = opts.ascending === false ? 'desc' : 'asc';
      this.sort = `${column}.${dir}`;
      return this;
    }

    limit(count) {
      this.rowLimit = count;
      return this;
    }

    then(resolve, reject) {
      return this.execute().then(resolve, reject);
    }

    async execute() {
      const params = new URLSearchParams();
      params.set('select', this.columns);
      this.filters.forEach(([key, val]) => params.append(key, val));
      if (this.sort) params.set('order', this.sort);
      if (this.rowLimit !== null) params.set('limit', String(this.rowLimit));

      const headers = { ...baseHeaders };
      if (this.count) headers.Prefer = `count=${this.count}`;
      if (this.method === 'POST' || this.method === 'PATCH') {
        headers.Prefer = 'return=representation';
      }

      const res = await fetch(`${restUrl}/${this.table}?${params.toString()}`, {
        method: this.method,
        headers,
        body: this.body ? JSON.stringify(this.body) : undefined,
      });

      if (!res.ok) {
        const message = await res.text().catch(() => res.statusText);
        return { data: null, error: { message: message || res.statusText, status: res.status } };
      }

      if (this.head) {
        return { data: null, error: null, count: res.headers.get('content-range') };
      }

      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      return { data, error: null };
    }
  }

  return {
    from(table) { return new RestQuery(table); },
  };
}

// ── State ────────────────────────────────────────────────────────
let bins = [];
let collectionCount = 0;
let autoFillTimer = null;
let autoFillInFlight = false;
let autoFillRunId = 0;
let selectedBinId = null;
let currentRoute = [];
let altRoutes = [];
let routeAnimOffset = 0;
let routeAnimFrame = null;
let gamificationRemoteAvailable = false;
const DEFAULT_STUDENTS = [
  { id: 'demo-student-1', card_id: 'CARD-001', full_name: 'Ahmet Yılmaz', total_points: 45 },
  { id: 'demo-student-2', card_id: 'CARD-002', full_name: 'Ayşe Demir', total_points: 20 },
  { id: 'demo-student-3', card_id: 'CARD-003', full_name: 'Mehmet Kaya', total_points: 12 },
];
let students = DEFAULT_STUDENTS.map(student => ({ ...student }));
const POINTS_MAP = { metal: 10, glass: 7, plastic: 5, paper: 3, organic: 2 };
const AUTO_FILL_ENABLED_KEY = 'ecoroute_auto_fill_enabled';
const AUTO_FILL_DETAIL_KEY = 'ecoroute_auto_fill_detail';
const COLLECTION_METERS_PER_MINUTE = 7;
const COLLECTION_SERVICE_MINUTES_PER_STOP = 4;
const COLLECTION_FIXED_MINUTES = 5;
const ALT_ROUTE_STRATEGIES = [
  { label: 'Dengeli servis hattı', extraDistanceM: 12, timePenaltyMin: 2 },
  { label: 'Doğu çevre yolu', extraDistanceM: 24, timePenaltyMin: 4 },
  { label: 'Yoğunluk öncelikli sıra', extraDistanceM: 8, timePenaltyMin: 3 },
  { label: 'Yan yol denemesi', extraDistanceM: 18, timePenaltyMin: 3 },
];

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
const routeDailyTime = document.getElementById('routeDailyTime');
const mapRouteEmpty = document.getElementById('mapRouteEmpty');
const mapRouteList = document.getElementById('mapRouteList');
const mapRouteInfo = document.getElementById('mapRouteInfo');
const mapRouteTime = document.getElementById('mapRouteTime');
const mapRouteWaste = document.getElementById('mapRouteWaste');
const mapRouteDailyTime = document.getElementById('mapRouteDailyTime');
const mapRouteCompletion = document.getElementById('mapRouteCompletion');
const mapRouteCompletionDetail = document.getElementById('mapRouteCompletionDetail');
const mapAltSummary = document.getElementById('mapAltSummary');
const ROUTE_EMPTY_DEFAULT_HTML = 'Doluluk verilerine göre<br/>otomatik rota oluşturmak için<br/>butona tıklayın.';

const historyList = document.getElementById('historyList');
const mapHistoryList = document.getElementById('mapHistoryList');
const toast = document.getElementById('toast');

const simModal = document.getElementById('simModal');
const binModal = document.getElementById('binModal');
const binModalTitle = document.getElementById('binModalTitle');
const binModalContent = document.getElementById('binModalContent');
const dataSourceStatus = document.getElementById('dataSourceStatus');
const autoFillStatus = document.getElementById('autoFillStatus');
const autoFillLastSaved = document.getElementById('autoFillLastSaved');
const leaderboardList = document.getElementById('leaderboardList');
const mapLeaderboardList = document.getElementById('mapLeaderboardList');
const feedList = document.getElementById('feedList');
const mapFeedList = document.getElementById('mapFeedList');
const gamificationStatus = document.getElementById('gamificationStatus');
const mapGamificationStatus = document.getElementById('mapGamificationStatus');
const mapAvgFill = document.getElementById('mapAvgFill');
const mapCritical = document.getElementById('mapCritical');
const mapHotspot = document.getElementById('mapHotspot');
const mapRouteStatus = document.getElementById('mapRouteStatus');

// ── Map Config ───────────────────────────────────────────────────
// DEPOT alias kept in sync with NODES.depot below
const DEPOT = { id: 'depot', x: 0.50, y: 0.88, label: 'Merkezi Depo', type: 'depot' };

// ── Road Network Graph ───────────────────────────────────────────
const NODES = {
  depot:     { x: 0.50, y: 0.88, label: 'Merkezi Depo', type: 'depot' },
  kutuphane:{ x: 0.16, y: 0.22, label: 'Kütüphane',      type: 'bin' },
  ders:      { x: 0.50, y: 0.46, label: 'Ders Binası',    type: 'bin' },
  yemekhane:{ x: 0.84, y: 0.22, label: 'Yemekhane',      type: 'bin' },
  nW:        { x: 0.28, y: 0.46, label: '',               type: 'junction' },
  nE:        { x: 0.72, y: 0.46, label: '',               type: 'junction' },
  nS:        { x: 0.50, y: 0.68, label: '',               type: 'junction' },
  nN:        { x: 0.50, y: 0.22, label: '',               type: 'junction' },
};
function normalizeLocationText(value) {
  return String(value || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getBinPosition(bin) {
  const key = getBinNodeKey(bin);
  if (key) return NODES[key];

  const source = `${bin.id || ''}${bin.location || ''}${bin.name || ''}`;
  let hash = 0;
  for (let i = 0; i < source.length; i++) hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  const angle = (hash % 360) * Math.PI / 180;
  return {
    x: 0.50 + Math.cos(angle) * 0.28,
    y: 0.50 + Math.sin(angle) * 0.22,
  };
}

function getBinNodeKey(bin) {
  const text = normalizeLocationText(`${bin.location || ''} ${bin.name || ''}`);
  if (text.includes('kutuphane')) return 'kutuphane';
  if (text.includes('ders')) return 'ders';
  if (text.includes('yemekhane')) return 'yemekhane';
  return null;
}

// Road edges: undirected graph (cleaner, grid-like)
const EDGES = [
  // Central spine (depot → south → center → north)
  { f:'depot', t:'nS',   cost: 8,  type:'main' },
  { f:'nS',    t:'ders', cost: 9,  type:'main' },
  { f:'ders',  t:'nN',   cost: 10, type:'main' },

  // West arm
  { f:'nS', t:'nW',         cost: 8,  type:'main' },
  { f:'nW', t:'ders',       cost: 7,  type:'main' },
  { f:'nW', t:'kutuphane',  cost: 11, type:'main' },
  { f:'nN', t:'kutuphane',  cost: 10, type:'side' },

  // East arm
  { f:'nS', t:'nE',         cost: 8,  type:'main' },
  { f:'nE', t:'ders',       cost: 7,  type:'main' },
  { f:'nE', t:'yemekhane',  cost: 11, type:'main' },
  { f:'nN', t:'yemekhane',  cost: 10, type:'side' },

  // Bypass: outer side road around campus (alternate route)
  { f:'depot', t:'nW',  cost: 18, type:'side' },
  { f:'depot', t:'nE',  cost: 18, type:'side' },
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
  updateDataSourceStatus('loading', 'DB kontrol ediliyor');
  renderLeaderboard();
  renderFeedItems([]);
  updateGamificationStatus('demo', 'Demo puan verisi');
  setupEventListeners();
  initMap();

  if (!IS_DEMO) {
    const loaded = await loadBinsFromSupabase();
    if (!loaded) {
      IS_DEMO = true;
      DATA_MODE = 'demo';
      updateDataSourceStatus('demo', 'Demo veri');
      loadLocalHistory();
      startHistorySnapshot();
      restoreAutoFillSetting();
      return;
    }
    setupRealtime();
    await loadCollectionHistory();
    await loadGamificationData();
    await ensureHistoryTable();
    await loadHistoryData();
    startHistorySnapshot();
    restoreAutoFillSetting();
  } else {
    updateDataSourceStatus('demo', 'Demo veri');
    loadLocalHistory();
    startHistorySnapshot();
    restoreAutoFillSetting();
  }
}

function updateDataSourceStatus(kind, text) {
  if (!dataSourceStatus) return;
  dataSourceStatus.textContent = text;
  dataSourceStatus.className = `data-source-status ${kind}`;
}

function updateGamificationStatus(kind, text) {
  [gamificationStatus, mapGamificationStatus].filter(Boolean).forEach(el => {
    el.textContent = text;
    el.className = `gamification-status ${kind}`;
  });
}

function updateAutoFillStatus(kind, detail = '') {
  if (autoFillStatus) {
    autoFillStatus.textContent = kind === 'running'
      ? 'Açık'
      : kind === 'saving'
        ? 'Kaydediliyor'
        : kind === 'error'
          ? 'Hata'
          : 'Kapalı';
    autoFillStatus.className = `auto-fill-status ${kind}`;
  }
  if (autoFillLastSaved) {
    autoFillLastSaved.textContent = detail;
    autoFillLastSaved.className = `auto-fill-meta ${kind}`;
  }
}

function readStoredAutoFillEnabled() {
  try {
    return localStorage.getItem(AUTO_FILL_ENABLED_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function writeStoredAutoFillEnabled(enabled) {
  try {
    localStorage.setItem(AUTO_FILL_ENABLED_KEY, enabled ? '1' : '0');
  } catch (_) {}
}

function readStoredAutoFillDetail() {
  try {
    return localStorage.getItem(AUTO_FILL_DETAIL_KEY) || '';
  } catch (_) {
    return '';
  }
}

function writeStoredAutoFillDetail(detail) {
  try {
    localStorage.setItem(AUTO_FILL_DETAIL_KEY, detail || '');
  } catch (_) {}
}

function restoreAutoFillSetting() {
  const toggle = document.getElementById('autoFillToggle');
  const storedDetail = readStoredAutoFillDetail();
  if (readStoredAutoFillEnabled()) {
    if (toggle) toggle.checked = true;
    startAutoFill({ persist: false });
  } else {
    if (toggle) toggle.checked = false;
    updateAutoFillStatus('off', storedDetail || 'Otomatik artış durdu.');
  }
}

function startAppWhenReady() {
  setTimeout(() => {
    init().catch(e => {
      console.error('Uygulama başlatılamadı:', e);
      updateDataSourceStatus('demo', 'Başlatma hatası');
      showToast(`Başlatma hatası: ${e.message}`, 'error');
    });
  }, 0);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startAppWhenReady, { once: true });
} else {
  startAppWhenReady();
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

  function hitTestBin(mx, my) {
    for (const bin of bins) {
      const p = getBinPosition(bin);
      const cx = p.x * mapW, cy = p.y * mapH;
      // Building hit area (~70 wide x 58 tall)
      if (Math.abs(mx - cx) < 62 && Math.abs(my - cy) < 30) return bin;
      // Marker hit area (above building)
      const my2 = cy - 58 / 2 - 22;
      if (Math.hypot(mx - cx, my - my2) < 22) return bin;
    }
    return null;
  }
  mapCanvas.addEventListener('click', e => {
    const rect = mapCanvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width * mapW;
    const my = (e.clientY - rect.top) / rect.height * mapH;
    const bin = hitTestBin(mx, my);
    if (bin) openBinDetail(bin.id);
  });
  mapCanvas.addEventListener('mousemove', e => {
    if (!mapCanvas) return;
    const rect = mapCanvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width * mapW;
    const my = (e.clientY - rect.top) / rect.height * mapH;
    mapCanvas.style.cursor = hitTestBin(mx, my) ? 'pointer' : 'default';
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
// Direction-independent: same control point regardless of edge orientation
function roadControlPoint(a, b, curvature = 0.12) {
  // Normalize endpoint order so curvature direction is deterministic
  let p1 = a, p2 = b;
  if (p1.x > p2.x || (p1.x === p2.x && p1.y > p2.y)) { p1 = b; p2 = a; }
  const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const px = -dy * curvature, py = dx * curvature;
  return { x: mx + px, y: my + py };
}

// Returns perpendicular unit vector in pixel-space for an edge
function edgePerpPx(nA, nB) {
  const dx = (nB.x - nA.x) * mapW;
  const dy = (nB.y - nA.y) * mapH;
  const len = Math.hypot(dx, dy) || 1;
  return { x: -dy / len, y: dx / len };
}

function drawRoad(ctx, nA, nB, style) {
  drawRoadOffset(ctx, nA, nB, 0, style);
}

// Draw a curved line between two nodes with an optional perpendicular offset (px)
function drawRoadOffset(ctx, nA, nB, offsetPx, style) {
  const ax = nA.x * mapW, ay = nA.y * mapH;
  const bx = nB.x * mapW, by = nB.y * mapH;
  const cp = roadControlPoint(nA, nB, style.curvature ?? (style.type === 'main' ? 0.10 : 0.18));
  let ox = 0, oy = 0;
  if (offsetPx) {
    const perp = edgePerpPx(nA, nB);
    ox = perp.x * offsetPx; oy = perp.y * offsetPx;
  }

  ctx.beginPath();
  ctx.moveTo(ax + ox, ay + oy);
  ctx.quadraticCurveTo(cp.x * mapW + ox, cp.y * mapH + oy, bx + ox, by + oy);
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

// ── Route palettes ──────────────────────────────────────────────
// Per-leg colors (depot→bin1 = leg 0, etc.)
const LEG_COLORS = [
  '#22c55e', // green
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#a855f7', // purple
  '#ec4899', // pink
  '#f97316', // orange
  '#facc15', // yellow
];
// Alternative route styles (color, lateral offset px, dash pattern)
const ALT_STYLES = [
  { color: '#facc15', offset:  12, dash: [7, 5] },   // yellow, right
  { color: '#06b6d4', offset: -12, dash: [5, 6] },   // cyan,   left
  { color: '#ec4899', offset:  22, dash: [3, 4] },   // pink,   far right
  { color: '#a855f7', offset: -22, dash: [9, 4] },   // purple, far left
];

function hexToRgba(hex, alpha = 1) {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Edge cost labels ──
function drawEdgeCostLabels(ctx) {
  const seen = new Set();
  for (const e of EDGES) {
    const key = [e.f, e.t].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const nA = NODES[e.f], nB = NODES[e.t];
    const cp = roadControlPoint(nA, nB, e.type === 'main' ? 0.10 : 0.18);
    const cx = cp.x * mapW, cy = cp.y * mapH;
    const label = `${e.cost}m`;

    ctx.font = '700 9px Sora, sans-serif';
    const tw = Math.ceil(ctx.measureText(label).width);
    const padX = 5, padY = 3;
    const w = tw + padX * 2;
    const h = 9 + padY * 2;

    // Pill background
    ctx.fillStyle = 'rgba(14,12,10,0.85)';
    ctx.strokeStyle = 'rgba(255,240,220,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    roundedRect(ctx, cx - w / 2, cy - h / 2, w, h, 4);
    ctx.fill(); ctx.stroke();

    // Text
    ctx.fillStyle = '#c9b896';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy + 0.5);
  }
}

// ── Full map render ──
function drawMap() {
  if (!mapCtx) return;
  const ctx = mapCtx, W = mapW, H = mapH;

  // ── Background layers ──
  ctx.clearRect(0, 0, W, H);

  // Base earth tone
  const baseGrad = ctx.createLinearGradient(0, 0, 0, H);
  baseGrad.addColorStop(0, '#0d0c0a');
  baseGrad.addColorStop(1, '#100e0c');
  ctx.fillStyle = baseGrad;
  ctx.fillRect(0, 0, W, H);

  // Grass / park patches (organic blobs) with subtle texture
  const parks = [
    { x: 0.10, y: 0.10, rx: 0.14, ry: 0.10 },
    { x: 0.90, y: 0.10, rx: 0.12, ry: 0.10 },
    { x: 0.20, y: 0.78, rx: 0.16, ry: 0.10 },
    { x: 0.80, y: 0.78, rx: 0.16, ry: 0.10 },
    { x: 0.50, y: 0.08, rx: 0.20, ry: 0.06 },
  ];
  parks.forEach(g => {
    const grd = ctx.createRadialGradient(g.x * W, g.y * H, 0, g.x * W, g.y * H, g.rx * W);
    grd.addColorStop(0, 'rgba(38,72,42,0.20)');
    grd.addColorStop(0.6, 'rgba(38,72,42,0.08)');
    grd.addColorStop(1, 'rgba(38,72,42,0)');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.ellipse(g.x * W, g.y * H, g.rx * W, g.ry * H, 0, 0, Math.PI * 2);
    ctx.fill();
  });

  // Small "trees" dots inside park areas (deterministic — no jitter on redraw)
  ctx.fillStyle = 'rgba(80,140,80,0.18)';
  const treeSpots = [
    [0.06,0.10,3.4],[0.10,0.16,3.0],[0.14,0.07,3.8],[0.04,0.18,3.2],
    [0.94,0.10,3.6],[0.90,0.17,3.2],[0.96,0.16,3.0],
    [0.16,0.80,3.5],[0.20,0.74,3.1],[0.24,0.82,3.7],[0.12,0.78,3.3],
    [0.80,0.80,3.5],[0.84,0.74,3.1],[0.78,0.84,3.4],[0.88,0.78,3.3],
    [0.42,0.06,2.8],[0.58,0.06,3.0],[0.50,0.04,3.4],
  ];
  treeSpots.forEach(([tx, ty, r]) => {
    ctx.beginPath();
    ctx.arc(tx * W, ty * H, r, 0, Math.PI * 2);
    ctx.fill();
  });

  // Subtle paving texture
  ctx.fillStyle = 'rgba(255,245,220,0.012)';
  ctx.fillRect(W * 0.06, H * 0.06, W * 0.88, H * 0.86);

  // ── Draw ALL road edges first (underneath everything) ──
  const drawnEdges = new Set();
  for (const e of EDGES) {
    const key = [e.f, e.t].sort().join('|');
    if (drawnEdges.has(key)) continue;
    drawnEdges.add(key);

    const nA = NODES[e.f], nB = NODES[e.t];
    const isMain = e.type === 'main';

    // Road "bed" / shoulder
    drawRoad(ctx, nA, nB, {
      color: isMain ? 'rgba(120,95,60,0.22)' : 'rgba(90,72,52,0.16)',
      width: isMain ? 12 : 7,
      type: e.type,
    });
    // Road surface
    drawRoad(ctx, nA, nB, {
      color: isMain ? '#9c7e58' : '#7a6450',
      width: isMain ? 6 : 3.5,
      type: e.type,
    });
    // Center dashed line (only on main roads)
    if (isMain) {
      drawRoad(ctx, nA, nB, {
        color: 'rgba(255,250,235,0.18)',
        width: 1,
        dash: [8, 10],
        type: e.type,
      });
    }
  }

  // ── Junction nodes (small circles at intersections) ──
  Object.entries(NODES).forEach(([_, node]) => {
    if (node.type === 'junction') {
      const cx = node.x * W, cy = node.y * H;
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#8a7050';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,240,220,0.1)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  });

  // ── Buildings (more detailed, campus-like) ──
  bins.forEach(bin => {
    const p = getBinPosition(bin);
    const cx = p.x * W, cy = p.y * H;
    const bw = Math.min(124, W * 0.17), bh = 58;

    // Drop shadow
    ctx.fillStyle = 'rgba(0,0,0,0.40)';
    ctx.beginPath();
    roundedRect(ctx, cx - bw / 2 + 3, cy - bh / 2 + 4, bw, bh, 9);
    ctx.fill();

    // Building body
    ctx.fillStyle = '#22201c';
    ctx.strokeStyle = 'rgba(200,175,135,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    roundedRect(ctx, cx - bw / 2, cy - bh / 2, bw, bh, 9);
    ctx.fill(); ctx.stroke();

    // Roof strip (slightly lighter)
    ctx.fillStyle = 'rgba(184,149,106,0.18)';
    ctx.beginPath();
    roundedRect(ctx, cx - bw / 2 + 3, cy - bh / 2 + 3, bw - 6, 8, 4);
    ctx.fill();

    // Windows grid
    const winRows = 2, winCols = 4;
    const padX = 10, padY = 18;
    const winAreaW = bw - padX * 2, winAreaH = bh - padY - 8;
    const winW = (winAreaW - (winCols - 1) * 4) / winCols;
    const winH = (winAreaH - (winRows - 1) * 4) / winRows;
    for (let r = 0; r < winRows; r++) {
      for (let c = 0; c < winCols; c++) {
        const wx = cx - bw/2 + padX + c * (winW + 4);
        const wy = cy - bh/2 + padY + r * (winH + 4);
        ctx.fillStyle = (r + c) % 3 === 0 ? 'rgba(255,210,140,0.22)' : 'rgba(140,150,170,0.12)';
        ctx.fillRect(wx, wy, winW, winH);
      }
    }

    // Label below building (clearer)
    ctx.fillStyle = '#c4b9a8';
    ctx.font = '700 11px Sora, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(bin.location, cx, cy + bh / 2 + 5);
  });

  // ── Edge cost labels (rendered above the road, below routes) ──
  drawEdgeCostLabels(ctx);

  // ── Alternative routes (drawn with lateral offset to avoid overlap) ──
  if (currentRoute.length > 0 && altRoutes.length > 0) {
    altRoutes.forEach((alt, idx) => {
      const meta = ALT_STYLES[idx % ALT_STYLES.length];
      alt.path.forEach(seg => {
        const nA = NODES[seg.from], nB = NODES[seg.to];
        // Outline for legibility
        drawRoadOffset(ctx, nA, nB, meta.offset, {
          color: 'rgba(0,0,0,0.4)', width: 4.5,
          dash: meta.dash, type: seg.type, curvature: 0.05,
        });
        drawRoadOffset(ctx, nA, nB, meta.offset, {
          color: meta.color, width: 2.6, dash: meta.dash,
          type: seg.type, curvature: 0.05,
        });
      });
    });
  }

  // ── Active route (per-leg colored, on top of road) ──
  if (currentRoute.length > 0) {
    const rpNodes = routeNodeOrder(currentRoute); // [depot, b1, b2, ..., depot]

    // Draw each leg with its own color
    for (let legIdx = 0; legIdx < rpNodes.length - 1; legIdx++) {
      const graphPath = shortestGraphPath(rpNodes[legIdx], rpNodes[legIdx + 1]);
      if (!graphPath || graphPath.length < 2) continue;
      const legColor = LEG_COLORS[legIdx % LEG_COLORS.length];

      for (let i = 0; i < graphPath.length - 1; i++) {
        const nA = NODES[graphPath[i]], nB = NODES[graphPath[i + 1]];
        // Glow halo (leg color, transparent)
        drawRoad(ctx, nA, nB, { color: hexToRgba(legColor, 0.22), width: 9 });
        // Solid base
        drawRoad(ctx, nA, nB, { color: legColor, width: 4.6 });
        // Animated dashes for direction (dark on top of solid)
        drawRoad(ctx, nA, nB, {
          color: 'rgba(0,0,0,0.55)', width: 4.6,
          dash: [10, 10], dashOffset: -routeAnimOffset,
        });
      }
    }

    // Leg badge with cost — at curve apex of each leg
    for (let i = 0; i < rpNodes.length - 1; i++) {
      const graphPath = shortestGraphPath(rpNodes[i], rpNodes[i + 1]);
      if (!graphPath || graphPath.length < 2) continue;
      const first = NODES[graphPath[0]], last = NODES[graphPath[graphPath.length - 1]];
      const cp = roadControlPoint(first, last, 0.10);
      const legCost = graphPathCost(graphPath);
      const legColor = LEG_COLORS[i % LEG_COLORS.length];

      // Pill: number badge + cost label
      const cx2 = cp.x * W, cy2 = cp.y * H;
      const cntLabel = String(i + 1);
      const costLabel = `${legCost}m`;

      ctx.font = '800 9.5px Sora, sans-serif';
      const costW = Math.ceil(ctx.measureText(costLabel).width);
      const pillW = 18 + costW + 12;
      const pillH = 18;

      // Pill background
      ctx.fillStyle = '#0c0a09';
      ctx.strokeStyle = legColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      roundedRect(ctx, cx2 - pillW / 2, cy2 - pillH / 2, pillW, pillH, 9);
      ctx.fill(); ctx.stroke();

      // Number circle
      ctx.beginPath();
      ctx.arc(cx2 - pillW / 2 + 9, cy2, 7, 0, Math.PI * 2);
      ctx.fillStyle = legColor;
      ctx.fill();
      ctx.fillStyle = '#0c0a09';
      ctx.font = '800 9px Sora, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(cntLabel, cx2 - pillW / 2 + 9, cy2 + 0.5);

      // Cost label
      ctx.fillStyle = legColor;
      ctx.font = '700 9.5px Sora, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(costLabel, cx2 - pillW / 2 + 19, cy2 + 0.5);
    }

    // Stop badges next to each bin in the route — colored by which leg STARTS at this bin (leg i+1 starts at stop i+1)
    currentRoute.forEach((bin, i) => {
      const p = getBinPosition(bin);
      const bx = p.x * W + 26, by = p.y * H - 22;
      // Color of leg arriving at this stop = leg i (depot→bin1 is leg 0)
      const inboundColor = LEG_COLORS[i % LEG_COLORS.length];
      ctx.beginPath();
      ctx.arc(bx, by, 11, 0, Math.PI * 2);
      ctx.fillStyle = inboundColor;
      ctx.fill();
      ctx.strokeStyle = '#0c0a09';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#0c0a09';
      ctx.font = '800 11px Sora, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), bx, by);
    });
  }

  // ── Bin markers (positioned above building like a sign) ──
  bins.forEach(bin => {
    const p = getBinPosition(bin);
    const cx = p.x * W, cy = p.y * H;
    const fill = avgFill(bin), status = binStatus(fill);
    const color = status === 'critical' ? '#ef4444' : status === 'warning' ? '#f59e0b' : '#22c55e';

    // Marker sits just above the building
    const my = cy - 58 / 2 - 22;
    const mx = cx;

    // Outer glow
    ctx.beginPath(); ctx.arc(mx, my, 22, 0, Math.PI * 2);
    ctx.fillStyle = color + '18'; ctx.fill();

    // Ring
    ctx.beginPath(); ctx.arc(mx, my, 17, 0, Math.PI * 2);
    ctx.fillStyle = '#12100e'; ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.stroke();

    // Pointer triangle connecting marker to building
    ctx.beginPath();
    ctx.moveTo(mx - 5, my + 14);
    ctx.lineTo(mx + 5, my + 14);
    ctx.lineTo(mx, my + 21);
    ctx.closePath();
    ctx.fillStyle = '#12100e';
    ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(mx - 5, my + 14);
    ctx.lineTo(mx, my + 21);
    ctx.lineTo(mx + 5, my + 14);
    ctx.stroke();

    // Fill % text
    ctx.fillStyle = color;
    ctx.font = 'bold 11px Sora, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(fill + '%', mx, my);
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
  // Items rows: status (3) + roads (2) + best route (1) + alts (up to 3) + legs (1)
  const altCount = Math.min(altRoutes.length, ALT_STYLES.length);
  const baseRows = 7;  // 3 status + 2 road + 1 best route + 1 leg-color sample
  const rows = baseRows + altCount;
  const lw = 168;
  const lh = 18 + rows * 13;
  const lx = W - lw - 10, ly = 12;

  // Panel bg
  ctx.fillStyle = 'rgba(14,12,10,0.92)';
  ctx.beginPath();
  roundedRect(ctx, lx, ly, lw, lh, 7);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,245,220,0.08)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.font = '700 9.5px Sora, sans-serif';
  ctx.fillStyle = '#c9b896';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('Lejant', lx + 8, ly + 10);

  ctx.font = '600 9px Sora, sans-serif';

  const items = [
    { color: '#22c55e', label: 'Normal (<%55)',     type: 'dot' },
    { color: '#f59e0b', label: 'Uyarı (%55–80)',   type: 'dot' },
    { color: '#ef4444', label: 'Kritik (%80+)',     type: 'dot' },
    { color: '#9c7e58', label: 'Ana Yol',          type: 'road-main' },
    { color: '#7a6450', label: 'Yan Yol',          type: 'road-side' },
    { color: '#22c55e', label: 'En kısa rota',     type: 'route' },
    { color: '#22c55e', label: 'Bacak renkleri (1,2,3)', type: 'legs' },
  ];
  // Append alternative rows
  for (let i = 0; i < altCount; i++) {
    const meta = ALT_STYLES[i];
    items.push({ color: meta.color, label: `Alternatif ${i + 1}`, type: 'route-alt', dash: meta.dash });
  }

  items.forEach((it, i) => {
    const iy = ly + 22 + i * 13;
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
      ctx.strokeStyle = it.color; ctx.lineWidth = 2.5; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(lx + 7, iy); ctx.lineTo(lx + 27, iy); ctx.stroke();
    } else if (it.type === 'legs') {
      // Render 3 short colored segments
      for (let li = 0; li < 3; li++) {
        ctx.strokeStyle = LEG_COLORS[li];
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(lx + 7 + li * 7, iy);
        ctx.lineTo(lx + 7 + li * 7 + 6, iy);
        ctx.stroke();
      }
    } else if (it.type === 'route-alt') {
      ctx.strokeStyle = it.color; ctx.lineWidth = 1.8;
      ctx.setLineDash(it.dash || [3, 3]);
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
  const summary = document.getElementById('altSummary');
  if (summary) summary.remove();
  updateMapSummary();
}

function resetRoutePanel(messageHtml) {
  stopRouteAnimation();
  routeList.innerHTML = '';
  routeList.classList.add('hidden');
  routeInfo.classList.add('hidden');
  if (routeDailyTime) routeDailyTime.textContent = '–';
  if (mapRouteList) {
    mapRouteList.innerHTML = '';
    mapRouteList.classList.add('hidden');
  }
  if (mapRouteInfo) mapRouteInfo.classList.add('hidden');
  if (mapRouteTime) mapRouteTime.textContent = '–';
  if (mapRouteWaste) mapRouteWaste.textContent = '–';
  if (mapRouteDailyTime) mapRouteDailyTime.textContent = '–';
  if (mapRouteCompletion) mapRouteCompletion.classList.add('hidden');
  if (mapRouteCompletionDetail) mapRouteCompletionDetail.textContent = 'Kovalar toplandı ve kayıt güncellendi.';
  if (mapRouteEmpty) mapRouteEmpty.classList.remove('hidden');
  if (mapAltSummary) {
    mapAltSummary.innerHTML = '<p class="history-empty">Rota oluşturulduğunda alternatifler burada görünür.</p>';
  }
  routeEmpty.classList.remove('hidden');
  const emptyText = routeEmpty.querySelector('p');
  if (emptyText && messageHtml) emptyText.innerHTML = messageHtml;
  drawMap();
}

function showMapRouteCompletion(routeCount, metric) {
  if (!mapRouteCompletion) return;
  const time = new Date().toLocaleTimeString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (mapRouteEmpty) mapRouteEmpty.classList.add('hidden');
  if (mapRouteCompletionDetail) {
    mapRouteCompletionDetail.textContent =
      `${routeCount} kova toplandı · ${metric.total_minutes} dk/gün · ${time}`;
  }
  mapRouteCompletion.classList.remove('hidden');
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

function calculateCollectionTimeMetric(routeBins, totalFillScore = 0, source = 'planned', distanceOverride = null, timePenaltyMin = 0) {
  const routeDistance = distanceOverride ?? graphRouteTotalCost(routeNodeOrder(routeBins));
  const stopCount = routeBins.length;
  const driveMinutes = Math.ceil(routeDistance / COLLECTION_METERS_PER_MINUTE) + timePenaltyMin;
  const serviceMinutes = stopCount * COLLECTION_SERVICE_MINUTES_PER_STOP;
  const totalMinutes = Math.max(
    0,
    Math.round(driveMinutes + serviceMinutes + COLLECTION_FIXED_MINUTES)
  );
  // Detaylı kırılımlar
  const catTotals = { plastic: 0, paper: 0, glass: 0, metal: 0, organic: 0 };
  routeBins.forEach(b => {
    (b.categories || []).forEach(c => {
       if (catTotals[c.category] !== undefined) catTotals[c.category] += Math.round(c.current_level);
    });
  });

  const allBinsKeys = bins.map(b => getBinNodeKey(b)).filter(Boolean);
  const tradCost = graphRouteTotalCost(['depot', ...allBinsKeys]);
  const tradMins = Math.round((tradCost / COLLECTION_METERS_PER_MINUTE) + bins.length * COLLECTION_SERVICE_MINUTES_PER_STOP + COLLECTION_FIXED_MINUTES);

  return {
    metric_date: new Date().toISOString().slice(0, 10),
    source,
    route_order: routeBins.map(bin => ({
      id: bin.id,
      location: bin.location,
      fill: avgFill(bin),
    })),
    stop_count: stopCount,
    route_distance_m: Math.round(routeDistance),
    drive_minutes: Math.round(driveMinutes),
    service_minutes: serviceMinutes,
    fixed_minutes: COLLECTION_FIXED_MINUTES,
    total_minutes: totalMinutes,
    total_fill_score: Math.round(totalFillScore),
    
    // YENI EKLENEN DETAYLAR (Local CSV Export icin)
    collected_plastic: catTotals.plastic,
    collected_paper: catTotals.paper,
    collected_glass: catTotals.glass,
    collected_metal: catTotals.metal,
    collected_organic: catTotals.organic,
    traditional_distance_m: tradCost,
    traditional_minutes: tradMins,
    saved_minutes: tradMins - totalMinutes,
    saved_pct: tradMins > 0 ? Math.round(((tradMins - totalMinutes)/tradMins)*100) : 0,

    algorithm: {
      meters_per_minute: COLLECTION_METERS_PER_MINUTE,
      service_minutes_per_stop: COLLECTION_SERVICE_MINUTES_PER_STOP,
      fixed_minutes: COLLECTION_FIXED_MINUTES,
      time_penalty_min: timePenaltyMin,
      formula: 'ceil(distance_m / meters_per_minute) + stop_count * service_minutes_per_stop + fixed_minutes + time_penalty_min',
    },
  };
}

function formatCollectionTimeMetric(metric) {
  if (!metric) return '–';
  return `${metric.total_minutes} dk/gün (sürüş ${metric.drive_minutes} + servis ${metric.service_minutes})`;
}
let sessionMetrics = []; // Kullanıcının o oturumda denediği senaryoları tutar

async function saveDailyCollectionTimeMetric(routeBins, totalFillScore, source = 'planned', metric = null) {
  if (!routeBins.length) return;
  const payload = metric
    ? { ...metric, source }
    : calculateCollectionTimeMetric(routeBins, totalFillScore, source);
  
  // Her halükarda kullanıcının senaryo denemeleri için lokale yaz
  payload.created_at = new Date().toISOString();
  sessionMetrics.push(payload);

  if (IS_DEMO || !supabaseClient) return;
  try {
    const { error } = await supabaseClient.from('daily_collection_time_metrics').insert(payload);
    if (error) console.warn('Günlük toplama süresi kaydedilemedi:', error.message);
  } catch (e) {
    console.warn('Günlük toplama süresi kaydedilemedi:', e.message);
  }
}

function calculateShortestRoute() {
  const targetBins = bins.filter(b => avgFill(b) > 10);
  if (targetBins.length === 0) return [];

  const targetKeys = targetBins.map(b => getBinNodeKey(b)).filter(Boolean);
  const fillByKey = Object.fromEntries(targetBins.map(b => [getBinNodeKey(b), avgFill(b)]).filter(([key]) => key));

  // Brute-force TSP over bin orderings, using graph costs
  if (targetKeys.length <= 8) {
    let best = null, bestCost = Infinity, bestPriority = -Infinity;
    for (const perm of getPermutations(targetKeys)) {
      const c = graphRouteTotalCost(['depot', ...perm]);
      const priority = routePriorityScore(perm, fillByKey);
      if (isBetterRoute(c, priority, bestCost, bestPriority)) {
        bestCost = c; bestPriority = priority; best = perm;
      }
    }
    // Map back to bin objects
    return best.map(k => bins.find(b => getBinNodeKey(b) === k)).filter(Boolean);
  }

  // Fallback nearest-neighbor
  let unvisited = [...targetKeys], route = [], cur = 'depot';
  while (unvisited.length > 0) {
    const { dist } = dijkstra(cur);
    let best = null, bd = Infinity, bp = -Infinity;
    for (const uk of unvisited) {
      const priority = fillByKey[uk] || 0;
      if (dist[uk] < bd || (Math.abs(dist[uk] - bd) < 0.001 && priority > bp)) {
        bd = dist[uk]; bp = priority; best = uk;
      }
    }
    route.push(best); cur = best;
    unvisited = unvisited.filter(u => u !== best);
  }
  return route.map(k => bins.find(b => getBinNodeKey(b) === k)).filter(Boolean);
}

// Find up to MAX_ALTS alternative routes (sorted by total cost)
const MAX_ALTS = 3;
function findAlternativeRoutes(bestBinRoute) {
  if (bestBinRoute.length === 0) return [];

  const targetKeys = bestBinRoute.map(b => getBinNodeKey(b)).filter(Boolean);
  const fillByKey = Object.fromEntries(bestBinRoute.map(b => [getBinNodeKey(b), avgFill(b)]).filter(([key]) => key));
  const alternatives = [];
  const bestKey = targetKeys.join('|');

  // Collect all permutations with their costs
  const results = [];
  for (const perm of getPermutations(targetKeys)) {
    const cost = graphRouteTotalCost(['depot', ...perm]);
    const priority = routePriorityScore(perm, fillByKey);
    results.push({ perm, cost, priority });
  }
  results.sort((a, b) => (a.cost - b.cost) || (b.priority - a.priority));

  const seen = new Set([bestKey]);
  function pushAlternative(perm, baseCost, strategy) {
    const key = `${perm.join('|')}|${strategy.label}`;
    if (seen.has(key) || alternatives.length >= MAX_ALTS) return;
    seen.add(key);
    const adjustedCost = Math.round(baseCost + strategy.extraDistanceM);
    const routeBins = perm.map(k => bins.find(b => getBinNodeKey(b) === k)).filter(Boolean);
    const metric = calculateCollectionTimeMetric(
      routeBins,
      routeBins.reduce((sum, bin) => sum + avgFill(bin), 0),
      'planned',
      adjustedCost,
      strategy.timePenaltyMin
    );
    alternatives.push({
      cost: adjustedCost,
      baseCost,
      strategy: strategy.label,
      metric,
      path: buildShortestEdgePath(['depot', ...perm, 'depot']),
      binOrder: perm,
    });
  }

  // Take distinct permutations first, then add operational variants so the simulation
  // can compare routes even when the graph has equal shortest-path costs.
  let strategyIndex = 0;
  for (let i = 1; i < results.length && alternatives.length < MAX_ALTS; i++) {
    const permKey = results[i].perm.join('|');
    if (permKey === bestKey) continue;
    pushAlternative(results[i].perm, results[i].cost, ALT_ROUTE_STRATEGIES[strategyIndex % ALT_ROUTE_STRATEGIES.length]);
    strategyIndex++;
  }

  for (let i = 0; alternatives.length < MAX_ALTS && i < ALT_ROUTE_STRATEGIES.length; i++) {
    const route = results[(i + 1) % results.length] || results[0];
    const perm = route?.perm || targetKeys;
    const rotated = perm.length > 1
      ? [...perm.slice(i % perm.length), ...perm.slice(0, i % perm.length)]
      : perm;
    pushAlternative(rotated, graphRouteTotalCost(['depot', ...rotated]), ALT_ROUTE_STRATEGIES[i]);
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

function routePriorityScore(nodeOrder, fillByKey) {
  const len = nodeOrder.length;
  return nodeOrder.reduce((score, key, idx) => {
    const fill = fillByKey[key] || 0;
    return score + fill * (len - idx);
  }, 0);
}

function isBetterRoute(cost, priority, bestCost, bestPriority) {
  if (cost < bestCost) return true;
  return Math.abs(cost - bestCost) < 0.001 && priority > bestPriority;
}

// ══════════════════════════════════════════════════════════════════
// SUPABASE
// ══════════════════════════════════════════════════════════════════

async function fetchRemoteBins(client) {
  const { data: binData, error: binErr } = await client
    .from('bins').select('*').order('name');
  if (binErr || !binData || binData.length === 0) {
    return { ok: false, message: binErr?.message || 'bins tablosu boş veya okunamadı' };
  }

  const { data: catData, error: catErr } = await client
    .from('waste_categories').select('*');
  if (catErr || !catData) {
    return { ok: false, message: catErr?.message || 'waste_categories okunamadı' };
  }

  return {
    ok: true,
    bins: binData.map(b => ({ ...b, categories: catData.filter(c => c.bin_id === b.id) })),
  };
}

async function tryLoadRemoteBinsWithCurrentClient() {
  const result = await fetchRemoteBins(supabaseClient);
  if (!result.ok) return result;

  bins = result.bins;
  renderBins();
  updateStats();
  drawMap();
  updateDataSourceStatus('connected', DATA_MODE === 'proxy' ? 'DB: yerel proxy' : DATA_MODE === 'rest' ? 'DB: REST' : 'DB: canlı');
  showToast(DATA_MODE === 'proxy'
    ? '✅ Supabase verisi yerel proxy ile yüklendi'
    : DATA_MODE === 'rest'
      ? '✅ Supabase REST verisi yüklendi'
      : '✅ Supabase verisi yüklendi', 'success');
  return result;
}

async function switchToDirectRestClient() {
  const { url, key } = getSupabaseConfig();
  if (!url || !key || url.startsWith('YOUR_') || key.startsWith('YOUR_')) return false;
  supabaseClient = createSupabaseRestClient(url, key);
  DATA_MODE = 'rest';
  updateDataSourceStatus('loading', 'DB: REST deneniyor');
  return true;
}

function switchToProxyRestClient() {
  supabaseClient = createSupabaseRestClient('/api/supabase', '');
  DATA_MODE = 'proxy';
  updateDataSourceStatus('loading', 'DB: proxy deneniyor');
}

async function loadBinsFromSupabase() {
  try {
    let result = await tryLoadRemoteBinsWithCurrentClient();
    if (result.ok) return true;
    console.warn(`${DATA_MODE} veri yolu başarısız:`, result.message);

    if (DATA_MODE !== 'rest' && await switchToDirectRestClient()) {
      result = await tryLoadRemoteBinsWithCurrentClient();
      if (result.ok) return true;
      console.warn('REST veri yolu başarısız:', result.message);
    }

    switchToProxyRestClient();
    result = await tryLoadRemoteBinsWithCurrentClient();
    if (result.ok) return true;
    console.warn('Yerel proxy veri yolu başarısız:', result.message);
    return false;
  } catch (e) {
    console.warn('Supabase hatasi, demo mod devam ediyor:', e.message);

    try {
      if (DATA_MODE !== 'rest' && await switchToDirectRestClient()) {
        const restResult = await tryLoadRemoteBinsWithCurrentClient();
        if (restResult.ok) return true;
        console.warn('REST veri yolu başarısız:', restResult.message);
      }
      switchToProxyRestClient();
      const proxyResult = await tryLoadRemoteBinsWithCurrentClient();
      if (proxyResult.ok) return true;
      console.warn('Yerel proxy veri yolu başarısız:', proxyResult.message);
    } catch (fallbackError) {
      console.warn('Tüm DB fallback yolları başarısız:', fallbackError.message);
    }

    return false;
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
  if (!supabaseClient?.channel) {
    console.warn('Realtime kullanılamıyor; REST veri modu aktif.');
    return;
  }
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
        refreshRouteFromCurrentData();
        // If simulation modal is open, refresh that bin's controls live
        if (simModal && !simModal.classList.contains('hidden')) {
          renderSimBinCard(bins[binIndex]);
        }
      }
    })
    .subscribe();

  supabaseClient
    .channel('gamification_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'students' }, loadStudents)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'waste_transactions' }, loadWasteTransactionFeed)
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

function buildRouteStopsHtml(sorted) {
  return sorted.map((bin, i) => {
    const fill = avgFill(bin), status = binStatus(fill);
    const pClass = status === 'critical' ? 'badge-critical' : status === 'warning' ? 'badge-warning' : 'badge-ok';
    const pText = status === 'critical' ? 'Kritik' : status === 'warning' ? 'Orta' : 'Düşük';

    const fromKey = i === 0 ? 'depot' : getBinNodeKey(sorted[i - 1]);
    const toKey = getBinNodeKey(bin);
    const { dist } = dijkstra(fromKey);
    const legCost = Math.round(dist[toKey] || 0);
    const legColor = LEG_COLORS[i % LEG_COLORS.length];

    return `
      <div class="route-stop">
        <div class="stop-num" style="background:${legColor};color:#0c0a09">${i + 1}</div>
        <div class="stop-body">
          <div class="stop-name">${escapeHtml(bin.location_icon)} ${escapeHtml(bin.location)}</div>
          <div class="stop-fill">Doluluk: ${fill}% · <span style="color:${legColor};font-weight:700">${legCost}m</span></div>
        </div>
        <span class="stop-priority ${pClass}">${pText}</span>
      </div>`;
  }).join('');
}

function generateRoute(options = {}) {
  const { silent = false, save = true } = options;
  if (!bins.length) return null;

  const sorted = calculateShortestRoute();
  if (sorted.length === 0) {
    resetRoutePanel('Toplanacak kova yok.<br/>Tüm kovalar %10 eşiğinin altında.');
    if (!silent) showToast('Tüm kovalar zaten boş (%10 altı).', 'warning');
    return null;
  }

  currentRoute = sorted;
  altRoutes = findAlternativeRoutes(sorted);
  const totalFill = sorted.reduce((s, b) => s + avgFill(b), 0);

  routeEmpty.classList.add('hidden');
  routeList.classList.remove('hidden');
  routeInfo.classList.remove('hidden');
  if (mapRouteEmpty) mapRouteEmpty.classList.add('hidden');
  if (mapRouteList) mapRouteList.classList.remove('hidden');
  if (mapRouteInfo) mapRouteInfo.classList.remove('hidden');
  if (mapRouteCompletion) mapRouteCompletion.classList.add('hidden');

  const routeStopsHtml = buildRouteStopsHtml(sorted);
  routeList.innerHTML = routeStopsHtml;
  if (mapRouteList) mapRouteList.innerHTML = routeStopsHtml;

  const totalGraphCost = graphRouteTotalCost(['depot', ...sorted.map(b => getBinNodeKey(b))]);
  const routeMetric = calculateCollectionTimeMetric(sorted, totalFill, 'planned', totalGraphCost);

  // Show alternatives summary in route panel
  renderAltSummary(altRoutes, totalGraphCost);

  routeTime.textContent = `~${routeMetric.total_minutes} dk (${totalGraphCost}m toplam)`;
  routeWaste.textContent = `~${Math.round(totalFill * 1.2)} L`;
  if (routeDailyTime) routeDailyTime.textContent = formatCollectionTimeMetric(routeMetric);
  if (mapRouteTime) mapRouteTime.textContent = `~${routeMetric.total_minutes} dk (${totalGraphCost}m toplam)`;
  if (mapRouteWaste) mapRouteWaste.textContent = `~${Math.round(totalFill * 1.2)} L`;
  if (mapRouteDailyTime) mapRouteDailyTime.textContent = formatCollectionTimeMetric(routeMetric);
  updateMapSummary();

  startRouteAnimation();
  if (!silent) {
    showToast(`✅ En kısa rota (${totalGraphCost}m) bulundu${altRoutes.length > 0 ? ` — ${altRoutes.length} alternatif` : ''}!`, 'success');
  }
  if (save) saveRoutePlan(sorted, totalFill, routeMetric);
  return { sorted, totalFill, routeMetric, totalGraphCost, altRoutes };
}

function buildAltSummaryContent(alts, bestCost) {
  return `
    <div class="alt-summary-title">Alternatif Rotalar (${alts.length})</div>
    ${alts.map((alt, idx) => {
      const meta = ALT_STYLES[idx % ALT_STYLES.length];
      const order = (alt.binOrder || []).map(k => {
        const bin = bins.find(b => getBinNodeKey(b) === k);
        return bin ? `${bin.location_icon} ${bin.location}` : k;
      }).join(' → ');
      const diff = Math.round(((alt.cost - bestCost) / bestCost) * 100);
      const diffLabel = diff <= 0 ? 'aynı mesafe' : `+%${diff} daha uzun`;
      return `
        <div class="alt-item">
          <span class="alt-dot" style="background:${meta.color}"></span>
          <div class="alt-body">
            <div class="alt-order">${order}</div>
            <div class="alt-meta">
              ${escapeHtml(alt.strategy || 'Alternatif')} · ${Math.round(alt.cost)}m · ${alt.metric?.total_minutes || '–'} dk/gün ·
              <span style="color:${meta.color}">${diffLabel}</span>
            </div>
          </div>
        </div>`;
    }).join('')}
  `;
}

// ── Render alt routes summary into route panels ──
function renderAltSummary(alts, bestCost) {
  // Remove existing summary if any
  const old = document.getElementById('altSummary');
  if (old) old.remove();
  if (!alts || alts.length === 0) {
    if (mapAltSummary) mapAltSummary.innerHTML = '<p class="history-empty">Bu rota için alternatif bulunamadı.</p>';
    return;
  }

  const content = buildAltSummaryContent(alts, bestCost);
  const wrap = document.createElement('div');
  wrap.id = 'altSummary';
  wrap.className = 'alt-summary';
  wrap.innerHTML = content;
  // Insert after route list
  routeList.insertAdjacentElement('afterend', wrap);
  if (mapAltSummary) mapAltSummary.innerHTML = content;
}

async function saveRoutePlan(sorted, totalFill, routeMetric = null) {
  if (IS_DEMO || !supabaseClient) return;
  try {
    await supabaseClient.from('route_plans').insert({
      route_order: sorted.map(b => ({ id: b.id, location: b.location, fill: avgFill(b) })),
      total_fill_score: totalFill,
      status: 'pending'
    });
    await saveDailyCollectionTimeMetric(sorted, totalFill, 'planned', routeMetric);
  } catch (e) { console.warn('Rota kaydedilemedi:', e.message); }
}

// ── Start Route ──────────────────────────────────────────────────
async function startCurrentRoute() {
  if (!currentRoute.length) return;
  const routeBeforeCollection = [...currentRoute];
  const totalFillBeforeCollection = routeBeforeCollection.reduce((sum, bin) => sum + avgFill(bin), 0);
  const completedMetric = calculateCollectionTimeMetric(routeBeforeCollection, totalFillBeforeCollection, 'completed');
  for (const bin of routeBeforeCollection) {
    if (avgFill(bin) > 10) await collectBin(bin.id, false);
  }
  await saveDailyCollectionTimeMetric(routeBeforeCollection, totalFillBeforeCollection, 'completed', completedMetric);
  showToast('🚛 Rota tamamlandı! Tüm kovalar boşaltıldı.', 'success');
  addHistoryItem('Rota Tamamlandı', `${routeBeforeCollection.length} kova toplandı · ${completedMetric.total_minutes} dk/gün`);
  resetRoutePanel(ROUTE_EMPTY_DEFAULT_HTML);
  showMapRouteCompletion(routeBeforeCollection.length, completedMetric);
}

document.getElementById('btnStartRoute')?.addEventListener('click', startCurrentRoute);
document.getElementById('btnMapStartRoute')?.addEventListener('click', startCurrentRoute);

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
    recordHistorySnapshotNow();
    return;
  }

  const { error: eventErr } = await supabaseClient.from('collection_events').insert({
    bin_id: binId, collected_by: 'Sistem', levels_before: levelsBefore
  });
  if (eventErr) console.warn('Toplama geçmişi kaydedilemedi:', eventErr.message);
  for (const cat of (bin.categories || [])) {
    cat.current_level = 0;
    const { error } = await supabaseClient.from('waste_categories')
      .update({ current_level: 0, updated_at: new Date().toISOString() })
      .eq('id', cat.id);
    if (error) console.warn('Kategori sıfırlanamadı:', error.message);
  }
  if (showMsg) {
    collectionCount++;
    showToast(`🚛 ${bin.name} başarıyla toplandı!`, 'success');
    addHistoryItem(bin.name, 'Tüm kategoriler sıfırlandı');
  }
  renderBins();
  updateStats();
  drawMap();
  if (simModal && !simModal.classList.contains('hidden')) {
    renderSimBinCard(bin);
  }
  recordHistorySnapshotNow();
}

// ══════════════════════════════════════════════════════════════════
// HISTORY
// ══════════════════════════════════════════════════════════════════

async function loadCollectionHistory() {
  try {
    const { data, error } = await supabaseClient
      .from('collection_events').select('*, bins(name,location_icon)')
      .order('collected_at', { ascending: false }).limit(20);
    if (error || !data || data.length === 0) return;
    collectionCount = data.length;
    valCollections.textContent = collectionCount;
    getHistoryLists().forEach(list => { list.innerHTML = ''; });
    data.forEach(ev => {
      const binName = ev.bins ? `${ev.bins.location_icon} ${ev.bins.name}` : 'Bilinmeyen';
      const time = new Date(ev.collected_at).toLocaleString('tr-TR');
      addHistoryItem(binName, time, false);
    });
  } catch (e) {
    console.warn('Toplama geçmişi yüklenemedi:', e.message);
  }
}

function getHistoryLists() {
  return [historyList, mapHistoryList].filter(Boolean);
}

function addHistoryItem(title, meta, prepend = true) {
  getHistoryLists().forEach(list => {
    const p = list.querySelector('.history-empty');
    if (p) p.remove();
    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
      <div class="history-item-title">🚛 ${escapeHtml(title)}</div>
      <div class="history-item-meta">${escapeHtml(meta)}</div>`;
    if (prepend) list.prepend(item);
    else list.appendChild(item);
  });
}

// ══════════════════════════════════════════════════════════════════
// GAMIFICATION
// ══════════════════════════════════════════════════════════════════

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resetDemoStudents() {
  students = DEFAULT_STUDENTS.map(student => ({ ...student }));
  gamificationRemoteAvailable = false;
}

function getLeaderboardLists() {
  return [leaderboardList, mapLeaderboardList].filter(Boolean);
}

function getFeedLists() {
  return [feedList, mapFeedList].filter(Boolean);
}

function renderLeaderboard() {
  const lists = getLeaderboardLists();
  if (!lists.length) return;
  if (!students.length) {
    lists.forEach(list => {
      list.innerHTML = '<p class="history-empty">Öğrenci verisi bulunamadı.</p>';
    });
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  const html = [...students]
    .sort((a, b) => Number(b.total_points || 0) - Number(a.total_points || 0))
    .map((student, index) => {
      const rank = medals[index] || `#${index + 1}`;
      return `
        <div class="student-item">
          <div class="student-main">
            <div class="student-name"><span class="student-rank">${rank}</span>${escapeHtml(student.full_name)}</div>
            <div class="student-card">${escapeHtml(student.card_id || 'Kart yok')}</div>
          </div>
          <div class="student-points">${Number(student.total_points || 0)} puan</div>
        </div>`;
    }).join('');
  lists.forEach(list => { list.innerHTML = html; });
}

function renderFeedItems(rows) {
  const lists = getFeedLists();
  if (!lists.length) return;
  if (!rows || rows.length === 0) {
    lists.forEach(list => {
      list.innerHTML = '<p class="history-empty">Henüz puan hareketi yok.</p>';
    });
    return;
  }
  lists.forEach(list => { list.innerHTML = ''; });
  rows.forEach(row => addFeedItem(row, false));
}

function addFeedItem(row, prepend = true) {
  const lists = getFeedLists();
  if (!lists.length) return;
  const categoryLabel = CAT_NAMES[row.waste_category] || row.waste_category || 'Atık';
  const place = row.location_icon
    ? `${row.location_icon} ${row.location || 'Kampüs'}`
    : (row.location || 'Kampüs');
  const time = row.created_at
    ? new Date(row.created_at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
    : new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

  const html = `
    <div class="feed-item-title">
      <div class="feed-main">
        <div class="feed-name">${escapeHtml(row.full_name || 'Öğrenci')}</div>
        <div class="feed-meta">${escapeHtml(place)} · ${escapeHtml(categoryLabel)} · ${time}</div>
      </div>
      <div class="feed-score">+${Number(row.points_awarded || 0)}</div>
    </div>`;

  lists.forEach(list => {
    const empty = list.querySelector('.history-empty');
    if (empty) empty.remove();
    const item = document.createElement('div');
    item.className = 'feed-item';
    item.innerHTML = html;
    if (prepend) list.prepend(item);
    else list.appendChild(item);

    while (list.children.length > 10) {
      list.removeChild(list.lastChild);
    }
  });
}

function normalizeTransaction(row) {
  return {
    created_at: row.created_at,
    waste_category: row.waste_category,
    points_awarded: row.points_awarded,
    full_name: row.students?.full_name || row.student_name || 'Öğrenci',
    location: row.bins?.location || row.location || 'Kampüs',
    location_icon: row.bins?.location_icon || row.location_icon || '',
  };
}

async function loadGamificationData() {
  if (IS_DEMO || !supabaseClient) {
    resetDemoStudents();
    renderLeaderboard();
    renderFeedItems([]);
    updateGamificationStatus('demo', 'Demo puan verisi');
    return;
  }

  const loaded = await loadStudents();
  if (!loaded) {
    resetDemoStudents();
    renderLeaderboard();
    renderFeedItems([]);
    updateGamificationStatus('error', 'Puan tabloları okunamadı');
    return;
  }

  await loadWasteTransactionFeed();
}

async function loadStudents() {
  if (IS_DEMO || !supabaseClient) return false;
  try {
    const { data, error } = await supabaseClient
      .from('students')
      .select('id,card_id,full_name,total_points')
      .order('total_points', { ascending: false });
    if (error || !data) {
      gamificationRemoteAvailable = false;
      console.warn('Öğrenci puanları yüklenemedi:', error?.message);
      return false;
    }
    students = data.map(student => ({
      ...student,
      total_points: Number(student.total_points || 0),
    }));
    gamificationRemoteAvailable = true;
    updateGamificationStatus('connected', `DB: ${students.length} öğrenci`);
    renderLeaderboard();
    return true;
  } catch (e) {
    gamificationRemoteAvailable = false;
    console.warn('Öğrenci puanları yüklenemedi:', e.message);
    return false;
  }
}

async function loadWasteTransactionFeed() {
  if (!gamificationRemoteAvailable || !supabaseClient) {
    renderFeedItems([]);
    return;
  }

  try {
    const { data, error } = await supabaseClient
      .from('waste_transactions')
      .select('created_at,waste_category,points_awarded,students(full_name),bins(location,location_icon)')
      .order('created_at', { ascending: false })
      .limit(10);
    if (error || !data) {
      console.warn('Puan hareketleri yüklenemedi:', error?.message);
      renderFeedItems([]);
      return;
    }
    renderFeedItems(data.map(normalizeTransaction));
  } catch (e) {
    console.warn('Puan hareketleri yüklenemedi:', e.message);
    renderFeedItems([]);
  }
}

function addGamificationCandidate(candidates, bin, cat, previousLevel, nextLevel) {
  const delta = Math.round(Number(nextLevel) - Number(previousLevel));
  if (delta <= 0) return;
  candidates.push({ bin, category: cat.category, delta });
}

function selectGamificationCandidate(candidates) {
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => b.delta - a.delta)[0];
}

async function recordTopGamificationCandidate(candidates) {
  const candidate = selectGamificationCandidate(candidates);
  if (!candidate) return;
  await recordGamificationEvent(candidate.bin, candidate.category);
}

async function recordGamificationEvent(bin, category) {
  if (!students.length) {
    resetDemoStudents();
  }

  const student = students[Math.floor(Math.random() * students.length)];
  if (!student) return;

  const points = POINTS_MAP[category] || 3;
  const previousPoints = Number(student.total_points || 0);
  const nextPoints = previousPoints + points;
  student.total_points = nextPoints;

  const feedRow = {
    created_at: new Date().toISOString(),
    waste_category: category,
    points_awarded: points,
    full_name: student.full_name,
    location: bin.location,
    location_icon: bin.location_icon,
  };

  renderLeaderboard();
  addFeedItem(feedRow);

  if (!gamificationRemoteAvailable || !supabaseClient || String(student.id || '').startsWith('demo-')) {
    updateGamificationStatus('demo', 'Demo puan verisi');
    return;
  }

  try {
    const { error: updateErr } = await supabaseClient
      .from('students')
      .update({ total_points: nextPoints })
      .eq('id', student.id);
    if (updateErr) throw new Error(updateErr.message);

    const { error: insertErr } = await supabaseClient
      .from('waste_transactions')
      .insert({
        student_id: student.id,
        bin_id: bin.id,
        waste_category: category,
        points_awarded: points,
      });
    if (insertErr) throw new Error(insertErr.message);

    updateGamificationStatus('connected', `DB: ${students.length} öğrenci`);
    if (previousPoints < 50 && nextPoints >= 50) {
      showToast(`${student.full_name} 50 puanı geçti; ödül kazandı.`, 'success');
    }
  } catch (e) {
    gamificationRemoteAvailable = false;
    updateGamificationStatus('error', 'Puan DB yazımı başarısız');
    console.warn('Puan hareketi kaydedilemedi:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════════
// SIMULATION (per-bin controls)
// ══════════════════════════════════════════════════════════════════

const SIMULATION_SCENARIOS = [
  {
    id: 'scenario-ders',
    icon: '🏫',
    name: 'Ders binası çıkışı',
    desc: 'Ders binası kritik, diğerleri orta seviyede.',
    route: 'Öncelik: Ders → Kütüphane → Yemekhane',
    levels: { ders: 96, kutuphane: 55, yemekhane: 33 },
  },
  {
    id: 'scenario-kutuphane',
    icon: '📚',
    name: 'Kütüphane yoğun',
    desc: 'Kütüphane kritik, kampüsün kalanında orta doluluk.',
    route: 'Öncelik: Kütüphane → Yemekhane → Ders',
    levels: { kutuphane: 94, yemekhane: 38, ders: 62 },
  },
  {
    id: 'scenario-yemekhane',
    icon: '🍽️',
    name: 'Yemekhane saati',
    desc: 'Yemekhane kritik, rota doğu kanadından başlar.',
    route: 'Öncelik: Yemekhane → Kütüphane → Ders',
    levels: { yemekhane: 95, ders: 60, kutuphane: 36 },
  },
  {
    id: 'scenario-top-road',
    icon: '🧭',
    name: 'Üst hat toplama',
    desc: 'Yalnızca kütüphane ve yemekhane eşik üstünde.',
    route: 'Hedef: Yemekhane → Kütüphane',
    levels: { yemekhane: 88, kutuphane: 84, ders: 8 },
  },
  {
    id: 'scenario-all-critical',
    icon: '🚨',
    name: 'Tüm kampüs kritik',
    desc: 'Üç kova da toplama eşiğinin belirgin üstünde.',
    route: 'Hedef: 3 duraklı tam rota',
    levels: { ders: 86, kutuphane: 82, yemekhane: 78 },
  },
  {
    id: 'scenario-clear',
    icon: '🧹',
    name: 'Temiz başlangıç',
    desc: 'Tüm kovalar %10 eşiğinin altında kalır.',
    route: 'Beklenen: rota oluşmaz',
    levels: { ders: 7, kutuphane: 6, yemekhane: 8 },
  },
];

const SCENARIO_CATEGORY_OFFSETS = { plastic: 0, paper: -4, organic: 6, glass: -7, metal: 3 };

function setupEventListeners() {
  buildScenarioControls();

  document.getElementById('btnSimulate').addEventListener('click', () => {
    buildScenarioControls();
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
    if (e.target.checked) {
      startAutoFill();
    } else {
      stopAutoFill();
    }
  });
}

function startAutoFill(options = {}) {
  const { persist = true } = options;
  stopAutoFill(false, { persist: false });
  if (persist) writeStoredAutoFillEnabled(true);
  autoFillRunId += 1;
  const runId = autoFillRunId;
  updateAutoFillStatus('running', 'İlk artış kaydediliyor...');
  runAutoFillTick(runId);
  autoFillTimer = setInterval(() => runAutoFillTick(runId), 5000);
}

function stopAutoFill(updateStatus = true, options = {}) {
  const { persist = true } = options;
  autoFillRunId += 1;
  if (autoFillTimer) clearInterval(autoFillTimer);
  autoFillTimer = null;
  autoFillInFlight = false;
  if (persist) {
    writeStoredAutoFillEnabled(false);
    writeStoredAutoFillDetail('Otomatik artış durdu.');
  }
  if (updateStatus) updateAutoFillStatus('off', 'Otomatik artış durdu.');
}

async function runAutoFillTick(runId = autoFillRunId) {
  const toggle = document.getElementById('autoFillToggle');
  if (runId !== autoFillRunId || !toggle?.checked || autoFillInFlight) return;

  autoFillInFlight = true;
  const delta = Math.floor(Math.random() * 8) + 2;
  updateAutoFillStatus('saving', `+${delta}% artış DB'ye yazılıyor...`);

  try {
    await applySimulationAll(delta, { silent: true, source: 'auto' });
    const time = new Date().toLocaleTimeString('tr-TR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    if (runId === autoFillRunId && toggle.checked) {
      const detail = `Son kayıt: ${time} · +${delta}%`;
      writeStoredAutoFillDetail(detail);
      updateAutoFillStatus('running', detail);
    }
  } catch (e) {
    console.warn('Otomatik artış kaydedilemedi:', e.message);
    if (runId === autoFillRunId && toggle.checked) {
      const detail = `Son kayıt başarısız: ${e.message}`;
      writeStoredAutoFillDetail(detail);
      updateAutoFillStatus('error', detail);
    }
  } finally {
    if (runId === autoFillRunId) {
      autoFillInFlight = false;
    }
  }
}

function buildScenarioControls() {
  const grid = document.getElementById('simScenarioGrid');
  if (!grid || grid.dataset.ready === 'true') return;

  grid.innerHTML = SIMULATION_SCENARIOS.map(scenario => `
    <button type="button" class="sim-scenario-card" data-scenario="${scenario.id}">
      <div class="sim-scenario-top">
        <span class="sim-scenario-icon">${scenario.icon}</span>
        <span class="sim-scenario-name">${scenario.name}</span>
      </div>
      <div class="sim-scenario-desc">${scenario.desc}</div>
      <div class="sim-scenario-route">${scenario.route}</div>
    </button>
  `).join('');

  grid.querySelectorAll('.sim-scenario-card').forEach(card => {
    card.addEventListener('click', () => applySimulationScenario(card.dataset.scenario));
  });
  grid.dataset.ready = 'true';
}

function setActiveScenario(scenarioId) {
  document.querySelectorAll('.sim-scenario-card').forEach(card => {
    card.classList.toggle('active', card.dataset.scenario === scenarioId);
  });
}

function scenarioCategoryLevel(baseLevel, category) {
  if (baseLevel <= 10) return Math.max(0, Math.min(100, baseLevel));
  const offset = SCENARIO_CATEGORY_OFFSETS[category] || 0;
  return Math.max(0, Math.min(100, Math.round(baseLevel + offset)));
}

async function applySimulationScenario(scenarioId) {
  const scenario = SIMULATION_SCENARIOS.find(item => item.id === scenarioId);
  if (!scenario || !bins.length) return;

  const cards = Array.from(document.querySelectorAll('.sim-scenario-card'));
  const gamificationCandidates = [];
  cards.forEach(card => { card.disabled = true; });
  try {
    resetRoutePanel(ROUTE_EMPTY_DEFAULT_HTML);
    for (const bin of bins) {
      const key = getBinNodeKey(bin);
      if (!key || scenario.levels[key] === undefined) continue;
      for (const cat of (bin.categories || [])) {
        const previousLevel = parseFloat(cat.current_level);
        const newLevel = scenarioCategoryLevel(scenario.levels[key], cat.category);
        await persistCategoryLevel(cat, newLevel);
        addGamificationCandidate(gamificationCandidates, bin, cat, previousLevel, newLevel);
      }
    }

    renderBins();
    updateStats();
    buildSimBinControls();
    setActiveScenario(scenarioId);
    recordHistorySnapshotNow();
    await recordTopGamificationCandidate(gamificationCandidates);
    generateRoute();
  } finally {
    cards.forEach(card => { card.disabled = false; });
  }
}

const CAT_NAMES = { plastic: 'Plastik', paper: 'Kağıt', organic: 'Organik', glass: 'Cam', metal: 'Metal' };
const CAT_ICONS = { plastic: '♳', paper: '📄', organic: '🌿', glass: '🍶', metal: '🥫' };

function buildSimBinControls() {
  const container = document.getElementById('simBinControls');
  container.innerHTML = '';

  bins.forEach(bin => {
    const card = document.createElement('div');
    card.className = 'sim-bin-card';
    card.dataset.binId = bin.id;
    container.appendChild(card);
    renderSimBinCard(bin);
  });
}

function renderSimBinCard(bin) {
  const card = document.querySelector(`.sim-bin-card[data-bin-id="${bin.id}"]`);
  if (!card) return;
  const fill = avgFill(bin);
  const status = binStatus(fill);
  const sClass = `badge-${status}`;
  const sText = status === 'critical' ? 'Kritik' : status === 'warning' ? 'Uyarı' : 'Normal';
  const fillColorVar = status === 'critical' ? 'var(--danger)' : status === 'warning' ? 'var(--warning)' : 'var(--primary)';

  const catRows = (bin.categories || []).map(cat => {
    const lvl = Math.round(parseFloat(cat.current_level));
    return `
      <div class="sim-cat-row" data-cat="${cat.category}">
        <span class="sim-cat-icon">${CAT_ICONS[cat.category] || '•'}</span>
        <span class="sim-cat-name">${CAT_NAMES[cat.category] || cat.category}</span>
        <div class="sim-cat-bar">
          <div class="sim-cat-bar-fill" style="width:${lvl}%;background:${cat.color_hex}"></div>
        </div>
        <input type="range" min="0" max="100" step="1" value="${lvl}"
               class="sim-cat-slider"
               data-bin="${bin.id}" data-cat="${cat.category}"
               aria-label="${CAT_NAMES[cat.category]} doluluğu" />
        <span class="sim-cat-pct" style="color:${cat.color_hex}">${lvl}%</span>
        <div class="sim-cat-btns">
          <button class="sim-cat-btn minus" title="-10%" data-bin="${bin.id}" data-cat="${cat.category}" data-delta="-10">−</button>
          <button class="sim-cat-btn plus"  title="+10%" data-bin="${bin.id}" data-cat="${cat.category}" data-delta="10">+</button>
          <button class="sim-cat-btn zero"  title="Sıfırla" data-bin="${bin.id}" data-cat="${cat.category}" data-set="0">⟲</button>
        </div>
      </div>`;
  }).join('');

  card.innerHTML = `
    <div class="sim-bin-header">
      <span class="sim-bin-icon">${bin.location_icon}</span>
      <div class="sim-bin-info">
        <div class="sim-bin-name">${bin.name}</div>
        <div class="sim-bin-fill">Genel Doluluk: <strong style="color:${fillColorVar}">${fill}%</strong></div>
      </div>
      <span class="bin-status-badge ${sClass}">${sText}</span>
    </div>
    <div class="sim-bin-gauge">
      <div class="sim-bin-gauge-fill" style="width:${fill}%;background:${fillColorVar}"></div>
    </div>
    <div class="sim-cat-list">${catRows}</div>
    <div class="sim-bin-footer">
      <button class="btn-sim-action fill"  data-bin="${bin.id}" data-delta="10">Tümü +10%</button>
      <button class="btn-sim-action fill"  data-bin="${bin.id}" data-delta="25">Tümü +25%</button>
      <button class="btn-sim-action drain" data-bin="${bin.id}" data-delta="-100">Hepsini Boşalt</button>
    </div>`;

  // Per-category controls
  card.querySelectorAll('.sim-cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const binId = btn.dataset.bin;
      const cat = btn.dataset.cat;
      if (btn.dataset.set !== undefined) {
        applySimulationSetCategory(binId, cat, parseInt(btn.dataset.set));
      } else {
        applySimulationForCategory(binId, cat, parseInt(btn.dataset.delta));
      }
    });
  });
  // Slider: live preview + final commit
  card.querySelectorAll('.sim-cat-slider').forEach(slider => {
    slider.addEventListener('input', () => {
      const row = slider.closest('.sim-cat-row');
      const lvl = parseInt(slider.value);
      const fillBar = row.querySelector('.sim-cat-bar-fill');
      const pct = row.querySelector('.sim-cat-pct');
      if (fillBar) fillBar.style.width = lvl + '%';
      if (pct) pct.textContent = lvl + '%';
    });
    slider.addEventListener('change', () => {
      applySimulationSetCategory(slider.dataset.bin, slider.dataset.cat, parseInt(slider.value));
    });
  });
  // Per-bin bulk controls
  card.querySelectorAll('.btn-sim-action[data-bin]').forEach(btn => {
    btn.addEventListener('click', () => {
      applySimulationForBin(btn.dataset.bin, parseInt(btn.dataset.delta));
    });
  });
}

async function persistCategoryLevel(cat, newLevel) {
  cat.current_level = newLevel;
  if (!IS_DEMO && supabaseClient) {
    try {
      const { error } = await supabaseClient
        .from('waste_categories')
        .update({ current_level: newLevel, updated_at: new Date().toISOString() })
        .eq('id', cat.id);
      if (error) {
        console.warn('Kategori güncellenemedi:', error.message);
        return false;
      }
    } catch (e) {
      console.warn('Kategori güncellenemedi:', e.message);
      return false;
    }
  }
  return true;
}

function refreshAfterSim(bin, recordHistory = true) {
  renderBins();
  updateStats();
  drawMap();
  renderSimBinCard(bin);
  if (recordHistory) recordHistorySnapshotNow();
}

async function refreshRouteFromCurrentData(options = {}) {
  if (!currentRoute.length) return null;
  const result = generateRoute({ silent: true, save: false });
  if (options.saveMetric && result?.sorted?.length) {
    await saveDailyCollectionTimeMetric(
      result.sorted,
      result.totalFill,
      options.source || 'auto',
      result.routeMetric
    );
  }
  return result;
}

async function applySimulationForCategory(binId, catName, delta) {
  const bin = bins.find(b => b.id === binId);
  if (!bin) return;
  const cat = (bin.categories || []).find(c => c.category === catName);
  if (!cat) return;
  const previousLevel = parseFloat(cat.current_level);
  const newLevel = Math.min(100, Math.max(0, parseFloat(cat.current_level) + delta));
  await persistCategoryLevel(cat, newLevel);
  refreshAfterSim(bin);
  const gamificationCandidates = [];
  addGamificationCandidate(gamificationCandidates, bin, cat, previousLevel, newLevel);
  await recordTopGamificationCandidate(gamificationCandidates);
}

async function applySimulationSetCategory(binId, catName, value) {
  const bin = bins.find(b => b.id === binId);
  if (!bin) return;
  const cat = (bin.categories || []).find(c => c.category === catName);
  if (!cat) return;
  const previousLevel = parseFloat(cat.current_level);
  const newLevel = Math.min(100, Math.max(0, value));
  await persistCategoryLevel(cat, newLevel);
  refreshAfterSim(bin);
  const gamificationCandidates = [];
  addGamificationCandidate(gamificationCandidates, bin, cat, previousLevel, newLevel);
  await recordTopGamificationCandidate(gamificationCandidates);
}

async function applySimulationForBin(binId, delta) {
  const catSel = document.getElementById('simCatSelect').value;
  const bin = bins.find(b => b.id === binId);
  if (!bin) return;

  const gamificationCandidates = [];
  const targetCats = catSel === 'all' ? bin.categories : bin.categories.filter(c => c.category === catSel);
  for (const cat of targetCats) {
    const previousLevel = parseFloat(cat.current_level);
    const newLevel = Math.min(100, Math.max(0, parseFloat(cat.current_level) + delta));
    await persistCategoryLevel(cat, newLevel);
    addGamificationCandidate(gamificationCandidates, bin, cat, previousLevel, newLevel);
  }

  refreshAfterSim(bin);
  await recordTopGamificationCandidate(gamificationCandidates);

  const action = delta > 0 ? `+${delta}%` : 'boşaltıldı';
  showToast(`⚡ ${bin.location}: ${action}`, delta < 0 ? 'warning' : 'success');
}

async function applySimulationAll(delta, options = {}) {
  const catSel = document.getElementById('simCatSelect').value;
  const gamificationCandidates = [];
  let failedWrites = 0;
  for (const bin of bins) {
    const targetCats = catSel === 'all' ? bin.categories : bin.categories.filter(c => c.category === catSel);
    for (const cat of targetCats) {
      const d = Math.floor(Math.random() * delta) + 1;
      const previousLevel = parseFloat(cat.current_level);
      const newLevel = Math.min(100, Math.max(0, parseFloat(cat.current_level) + d));
      const saved = await persistCategoryLevel(cat, newLevel);
      if (!saved) failedWrites++;
      addGamificationCandidate(gamificationCandidates, bin, cat, previousLevel, newLevel);
    }
    renderSimBinCard(bin);
  }
  renderBins();
  updateStats();
  drawMap();
  await recordHistorySnapshotNow();
  await recordTopGamificationCandidate(gamificationCandidates);
  if (options.source === 'auto') {
    await refreshRouteFromCurrentData({ saveMetric: true, source: 'auto' });
  }
  if (options.source === 'auto' && failedWrites > 0) {
    throw new Error(`${failedWrites} kategori DB'ye yazılamadı`);
  }
  if (!options.silent) {
    showToast(`⚡ Rastgele: +${delta}% dolduruldu`, 'success');
  }
  return { failedWrites, updatedCategories: gamificationCandidates.length };
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
  remoteHistoryAvailable = true;
  try {
    const { error } = await supabaseClient.from('bin_level_history').select('id', { count: 'exact', head: true }).limit(1);
    if (error) {
      remoteHistoryAvailable = false;
      console.warn('bin_level_history erişilemedi, localStorage geçmişi kullanılacak:', error.message);
    }
  } catch (e) {
    remoteHistoryAvailable = false;
    console.warn('bin_level_history erişilemedi, localStorage geçmişi kullanılacak:', e.message);
  }
}

async function saveSnapshot() {
  const snap = { t: Date.now(), data: buildSnapshot() };
  historyData.push(snap);
  if (historyData.length > 200) historyData = historyData.slice(-200);
  try {
    if (!IS_DEMO && supabaseClient && remoteHistoryAvailable) {
      const { error } = await supabaseClient.from('bin_level_history').insert({ recorded_at: new Date().toISOString(), snapshot: snap.data });
      if (error) console.warn('Snapshot kaydedilemedi:', error.message);
    }
  } catch (e) {
    console.warn('Snapshot kaydedilemedi:', e.message);
  }
  saveLocalHistory();
}

async function recordHistorySnapshotNow() {
  await saveSnapshot();
  if (document.getElementById('panel-charts')?.classList.contains('active')) {
    renderCharts();
  }
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
  if (IS_DEMO || !remoteHistoryAvailable) { loadLocalHistory(); return; }
  try {
    const { data, error } = await supabaseClient
      .from('bin_level_history')
      .select('recorded_at,snapshot')
      .order('recorded_at', { ascending: false })
      .limit(100);
    if (error || !data) {
      console.warn('Doluluk geçmişi DBden yüklenemedi, localStorage kullanılacak:', error?.message);
      loadLocalHistory();
      return;
    }
    historyData = data.reverse().map(row => ({ t: new Date(row.recorded_at).getTime(), data: row.snapshot }));
    if (historyData.length === 0) loadLocalHistory();
  } catch (e) {
    console.warn('Doluluk geçmişi yüklenemedi, localStorage kullanılacak:', e.message);
    loadLocalHistory();
  }
}

function startHistorySnapshot() {
  if (snapshotTimer) clearInterval(snapshotTimer);
  saveSnapshot();
  snapshotTimer = setInterval(saveSnapshot, SNAPSHOT_INTERVAL);
}

const CHART_COLORS = ['#22c55e','#3b82f6','#f59e0b','#ef4444','#8b5cf6'];
const CAT_LABELS = { plastic:'Plastik', paper:'Kağıt', organic:'Organik', glass:'Cam', metal:'Metal' };
const CAT_PALETTE = { plastic:'#3B82F6', paper:'#F59E0B', organic:'#10B981', glass:'#8B5CF6', metal:'#9CA3AF' };

let perBinCharts = []; // [{ id, chart }]

const COMMON_LINE_OPTS = (extra={}) => ({
  responsive:true, maintainAspectRatio:false,
  interaction:{ mode:'nearest', intersect:false },
  plugins:{
    legend:{labels:{color:'#9ca3af',font:{family:'Figtree',size:10},boxWidth:12,boxHeight:8,padding:10}},
    tooltip:{ backgroundColor:'#1a1714', borderColor:'#332e29', borderWidth:1, titleColor:'#f5f0ea', bodyColor:'#cfc6ba', padding:10 },
    ...(extra.plugins||{})
  },
  scales:{
    x:{ticks:{color:'#6b7280',font:{size:10},maxTicksLimit:8},grid:{color:'#ffffff08'}},
    y:{min:0,max:100,ticks:{color:'#6b7280',callback:(v)=>v+'%'},grid:{color:'#ffffff08'}}
  },
  elements:{ line:{ borderWidth:2 }, point:{ radius:2.5, hoverRadius:5 } }
});

function ensurePerBinChartCards() {
  const grid = document.getElementById('chartsGrid');
  if (!grid) return;
  const existing = new Set(Array.from(grid.querySelectorAll('.chart-card.per-bin')).map(el => el.dataset.binId));
  const wanted = new Set(bins.map(b => b.id));

  // Remove obsolete
  grid.querySelectorAll('.chart-card.per-bin').forEach(el => {
    if (!wanted.has(el.dataset.binId)) el.remove();
  });

  // Add missing
  bins.forEach(bin => {
    if (existing.has(bin.id)) return;
    const card = document.createElement('div');
    card.className = 'chart-card per-bin';
    card.dataset.binId = bin.id;
    card.innerHTML = `
      <h3 class="chart-card-title">${bin.location_icon} ${bin.location} – Atık Türü Geçmişi</h3>
      <canvas id="chart-bin-${bin.id}"></canvas>`;
    grid.appendChild(card);
  });
}

function ensureHistoryHasCurrentSnapshot() {
  if (historyData.length === 0 && bins.length) {
    historyData.push({ t: Date.now(), data: buildSnapshot() });
  }
}

function prepareFallbackCanvas(canvas, height = 220) {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(280, Math.round(canvas.parentElement.getBoundingClientRect().width - 32));
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function drawFallbackLineChart(canvas, labels, datasets) {
  if (!canvas) return;
  const { ctx, width, height } = prepareFallbackCanvas(canvas, 220);
  const pad = { l: 34, r: 12, t: 12, b: 28 };
  const pw = width - pad.l - pad.r;
  const ph = height - pad.t - pad.b;
  ctx.clearRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.font = '10px Figtree, sans-serif';
  ctx.fillStyle = '#6b7280';
  [0, 25, 50, 75, 100].forEach(v => {
    const y = pad.t + ph - (v / 100) * ph;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(width - pad.r, y); ctx.stroke();
    ctx.fillText(`${v}%`, 2, y + 3);
  });

  datasets.forEach(ds => {
    const data = ds.data || [];
    if (!data.length) return;
    ctx.beginPath();
    data.forEach((value, i) => {
      const x = pad.l + (data.length === 1 ? pw : (i / (data.length - 1)) * pw);
      const y = pad.t + ph - (Math.max(0, Math.min(100, value)) / 100) * ph;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = ds.borderColor || '#22c55e';
    ctx.lineWidth = 2;
    ctx.stroke();
  });

  if (labels.length) {
    ctx.fillStyle = '#6b7280';
    ctx.textAlign = 'left';
    ctx.fillText(labels[0], pad.l, height - 8);
    ctx.textAlign = 'right';
    ctx.fillText(labels[labels.length - 1], width - pad.r, height - 8);
  }
}

function drawFallbackBarChart(canvas, labels, values, colors) {
  if (!canvas) return;
  const { ctx, width, height } = prepareFallbackCanvas(canvas, 220);
  const pad = { l: 78, r: 18, t: 12, b: 14 };
  const barH = Math.min(26, (height - pad.t - pad.b) / Math.max(1, labels.length) - 8);
  ctx.clearRect(0, 0, width, height);
  ctx.font = '11px Figtree, sans-serif';

  labels.forEach((label, i) => {
    const y = pad.t + i * (barH + 10);
    const value = Math.max(0, Number(values[i]) || 0);
    const barW = Math.min(1, value / 300) * (width - pad.l - pad.r);
    ctx.fillStyle = '#cfc6ba';
    ctx.textAlign = 'right';
    ctx.fillText(label, pad.l - 8, y + barH * 0.72);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(pad.l, y, width - pad.l - pad.r, barH);
    ctx.fillStyle = colors[i] || '#22c55e';
    ctx.fillRect(pad.l, y, barW, barH);
    ctx.fillStyle = '#9ca3af';
    ctx.textAlign = 'left';
    ctx.fillText(`${Math.round(value)}%`, pad.l + barW + 6, y + barH * 0.72);
  });
}

function renderFallbackCharts() {
  ensurePerBinChartCards();
  ensureHistoryHasCurrentSnapshot();
  const sorted = [...historyData].sort((a,b) => a.t - b.t);
  const labels = sorted.map(s => new Date(s.t).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'}));
  const binNames = sorted.length ? sorted[sorted.length-1].data.map(b=>b.name) : [];
  const overallData = sorted.map(s => {
    if (!s.data || s.data.length === 0) return 0;
    return Math.round(s.data.reduce((a,b)=>a+(b.avgFill||0),0) / s.data.length);
  });

  drawFallbackLineChart(document.getElementById('chartOverall'), labels, [{
    label: 'Ortalama Doluluk (%)',
    data: overallData,
    borderColor: '#22c55e'
  }]);

  drawFallbackLineChart(document.getElementById('chartBins'), labels, binNames.map((name, i) => ({
    label: name.replace(' Çöp Kovası',''),
    data: sorted.map(s => { const b = s.data.find(d=>d.name===name); return b ? b.avgFill : 0; }),
    borderColor: CHART_COLORS[i % CHART_COLORS.length],
  })));

  const latest = sorted[sorted.length - 1];
  const catTotals = {};
  if (latest) latest.data.forEach(b => (b.categories||[]).forEach(c => { catTotals[c.category] = (catTotals[c.category]||0) + c.level; }));
  const catKeys = Object.keys(catTotals);
  drawFallbackBarChart(
    document.getElementById('chartCategories'),
    catKeys.map(k => CAT_LABELS[k]||k),
    catKeys.map(k => catTotals[k]),
    catKeys.map(k => CAT_PALETTE[k] || '#6B7280')
  );

  bins.forEach(bin => {
    const canvas = document.getElementById(`chart-bin-${bin.id}`);
    const catNames = (bin.categories || []).map(c => c.category);
    drawFallbackLineChart(canvas, labels, catNames.map(catKey => ({
      label: CAT_LABELS[catKey] || catKey,
      data: sorted.map(s => {
        const sb = s.data.find(d => d.id === bin.id) || s.data.find(d => d.name === bin.name);
        const sc = sb?.categories?.find(c => c.category === catKey);
        return sc ? Math.round(sc.level) : 0;
      }),
      borderColor: CAT_PALETTE[catKey] || '#9CA3AF',
    })));
  });
}

function renderCharts() {
  if (typeof Chart === 'undefined') {
    console.warn('Chart.js yüklenmedi; native canvas grafik fallback kullanılacak.');
    renderFallbackCharts();
    return;
  }

  ensurePerBinChartCards();
  ensureHistoryHasCurrentSnapshot();

  const ctxO = document.getElementById('chartOverall')?.getContext('2d');
  const ctxB = document.getElementById('chartBins')?.getContext('2d');
  const ctxC = document.getElementById('chartCategories')?.getContext('2d');
  if (!ctxO || !ctxB || !ctxC) return;

  if (chartOverall) chartOverall.destroy();
  if (chartBins) chartBins.destroy();
  if (chartCategories) chartCategories.destroy();
  perBinCharts.forEach(p => p.chart.destroy());
  perBinCharts = [];

  const sorted = [...historyData].sort((a,b) => a.t - b.t);
  const labels = sorted.map(s => new Date(s.t).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'}));
  const binNames = sorted.length ? sorted[sorted.length-1].data.map(b=>b.name) : [];

  // ── Overall: average of all bins over time ──
  const overallData = sorted.map(s => {
    if (!s.data || s.data.length === 0) return 0;
    const avg = s.data.reduce((a,b)=>a+(b.avgFill||0),0) / s.data.length;
    return Math.round(avg);
  });
  chartOverall = new Chart(ctxO, {
    type: 'line',
    data: { labels, datasets: [{
      label:'Ortalama Doluluk (%)', data: overallData,
      borderColor:'#22c55e', backgroundColor:'#22c55e22',
      fill:true, tension:0.35
    }] },
    options: COMMON_LINE_OPTS()
  });

  // ── Multi-bin overview ──
  const binDatasets = binNames.map((name, i) => ({
    label: name.replace(' Çöp Kovası',''),
    data: sorted.map(s => { const b = s.data.find(d=>d.name===name); return b ? b.avgFill : 0; }),
    borderColor: CHART_COLORS[i % CHART_COLORS.length],
    backgroundColor: CHART_COLORS[i % CHART_COLORS.length] + '18',
    fill: false, tension: 0.35
  }));
  chartBins = new Chart(ctxB, {
    type: 'line',
    data: { labels, datasets: binDatasets },
    options: COMMON_LINE_OPTS()
  });

  // ── Category totals (snapshot) ──
  const latest = sorted[sorted.length - 1];
  const catTotals = {};
  if (latest) latest.data.forEach(b => (b.categories||[]).forEach(c => { catTotals[c.category] = (catTotals[c.category]||0) + c.level; }));
  const catKeys = Object.keys(catTotals);
  chartCategories = new Chart(ctxC, {
    type: 'bar',
    data: {
      labels: catKeys.map(k => CAT_LABELS[k]||k),
      datasets: [{
        label: 'Toplam Doluluk (%)',
        data: catKeys.map(k => Math.round(catTotals[k])),
        backgroundColor: catKeys.map(k => CAT_PALETTE[k] || '#6B7280'),
        borderRadius: 8, barThickness: 36
      }]
    },
    options: {
      responsive:true,maintainAspectRatio:false,indexAxis:'y',
      plugins:{ legend:{display:false}, tooltip:{ backgroundColor:'#1a1714', borderColor:'#332e29', borderWidth:1 } },
      scales:{ x:{min:0,ticks:{color:'#6b7280',callback:v=>v+'%'},grid:{color:'#ffffff08'}}, y:{ticks:{color:'#cfc6ba',font:{size:12}},grid:{display:false}} }
    }
  });

  // ── Per-bin category trend charts ──
  bins.forEach(bin => {
    const canvas = document.getElementById(`chart-bin-${bin.id}`);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // For each category, build a series across snapshots
    const catNames = (bin.categories || []).map(c => c.category);
    const datasets = catNames.map(catKey => ({
      label: `${CAT_ICONS[catKey] || ''} ${CAT_LABELS[catKey] || catKey}`,
      data: sorted.map(s => {
        const sb = s.data.find(d => d.id === bin.id) || s.data.find(d => d.name === bin.name);
        if (!sb || !sb.categories) return 0;
        const sc = sb.categories.find(c => c.category === catKey);
        return sc ? Math.round(sc.level) : 0;
      }),
      borderColor: CAT_PALETTE[catKey] || '#9CA3AF',
      backgroundColor: (CAT_PALETTE[catKey] || '#9CA3AF') + '18',
      fill: false, tension: 0.35
    }));

    const chart = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: COMMON_LINE_OPTS()
    });
    perBinCharts.push({ id: bin.id, chart });
  });
}

// ══════════════════════════════════════════════════════════════════
// EXPORT ANALYTICS DATA (CSV)
// ══════════════════════════════════════════════════════════════════
async function exportDataToCSV() {
  if (!bins || bins.length === 0) {
    showToast('Dışa aktarılacak veri bulunamadı.', 'warning');
    return;
  }

  showToast('Analiz verileri derleniyor...', 'info');

  try {
    let csvContent = "data:text/csv;charset=utf-8,\uFEFF"; // UTF-8 BOM for Excel
    
    // -- 0. GERÇEK ZAMANLI SİSTEM İŞLEMLERİ (Kullanıcının Supabase'e kaydettiği işlemler) --
    let dbMetrics = [...sessionMetrics].reverse();
    if (!IS_DEMO && supabaseClient) {
       const { data, error } = await supabaseClient
           .from('daily_collection_time_metrics')
           .select('*')
           .order('created_at', { ascending: false });
       if (!error && data) {
           const seen = new Set();
           const merged = [];
           [...sessionMetrics.reverse(), ...data].forEach(m => {
               const key = new Date(m.created_at).getTime() + '_' + m.source;
               if (!seen.has(key)) {
                   seen.add(key);
                   merged.push(m);
               }
           });
           dbMetrics = merged;
       }
    }

    if (dbMetrics.length > 0) {
        csvContent += "--- GERCEK ZAMANLI SISTEM ISLEM LOGLARI (Sizin Yaptiginiz Islemler) ---\n";
        csvContent += "Islem Zamani,Rota Turu,Geleneksel Mesafe (m),Geleneksel Sure (dk),Akilli Rota Mesafe (m),Akilli Rota Sure (dk),Kazanilan Sure (dk),Zaman Tasarrufu (%),Gidilen Kova Sayisi,Toplanan Plastik,Toplanan Kagit,Toplanan Cam,Toplanan Metal,Toplanan Organik\n";
        dbMetrics.forEach(m => {
             const dt = new Date(m.created_at).toLocaleString('tr-TR');
             const type = m.source === 'planned' ? 'Planlanan Rota' : 'Tamamlanan Rota';
             const tradDist = m.traditional_distance_m || Math.round((m.route_distance_m || 0) * 1.5) || 0; // fallback if missing
             const tradMin = m.traditional_minutes || Math.round((m.total_minutes || 0) * 1.5) || 0;
             const savedM = m.saved_minutes !== undefined ? m.saved_minutes : (tradMin - m.total_minutes);
             const savedP = m.saved_pct !== undefined ? m.saved_pct : (tradMin > 0 ? Math.round(((tradMin - m.total_minutes)/tradMin)*100) : 0);
             const p = m.collected_plastic || 0;
             const pa = m.collected_paper || 0;
             const g = m.collected_glass || 0;
             const met = m.collected_metal || 0;
             const org = m.collected_organic || 0;
             const stops = m.stop_count || 0;

             csvContent += `"${dt}",${type},${tradDist},${tradMin},${m.route_distance_m},${m.total_minutes},${savedM},%${savedP},${stops},${p},${pa},${g},${met},${org}\n`;
        });
        csvContent += "\n\n";
    }

    // -- 1. ÇOKLU VERİ SİMÜLASYONU (180 Günlük / 360 Vardiya) --
    csvContent += "--- SENTETIK 180 GUNLUK ROTA OPTIMIZASYONU ANALIZ RAPORU ---\n\n";
    csvContent += "Gun,Vardiya,Geleneksel Mesafe (m),Geleneksel Sure (dk),Akilli Rota Mesafe (m),Akilli Rota Sure (dk),Kazanilan Sure (dk),Zaman Tasarrufu (%),Gidilen Kova Sayisi,Toplanan Plastik,Toplanan Kagit,Toplanan Cam,Toplanan Metal,Toplanan Organik\n";

    const allBinsKeys = bins.map(b => getBinNodeKey(b)).filter(Boolean);
    const traditionalRoute = [...allBinsKeys];
    const traditionalCost = graphRouteTotalCost(['depot', ...traditionalRoute]);
    
    // Geleneksel Rota hep sabittir (Mesafe ve durak sayısı hep aynı, sadece toplanan çöp değişir, ama biz basitleştirip sabit diyelim)
    // baseDriveTimeMin = (distance / 1000) * 15. stopTimeMin = bins.length * 3. + 5 min base.
    const traditionalBaseDriveTime = (traditionalCost / 1000) * 15;
    const traditionalStopTime = bins.length * 3;
    const traditionalTotalMin = Math.round(traditionalBaseDriveTime + traditionalStopTime + 5);

    let totalSavedMinutes = 0;
    
    for (let day = 1; day <= 180; day++) {
      for (let shift of ['Sabah', 'Aksam']) {
        // Her vardiya için kovalara rastgele doluluk ata
        let shiftFillLevels = {};
        let smartRouteKeys = [];
        let collectedCats = { plastic: 0, paper: 0, glass: 0, metal: 0, organic: 0 };
        
        bins.forEach(b => {
          const key = getBinNodeKey(b);
          // Sabahları daha az, akşamları daha çok dolu olabilir. Rastgele:
          const p = Math.floor(Math.random() * 80) + (shift === 'Aksam' ? 20 : 0);
          const pa = Math.floor(Math.random() * 80) + (shift === 'Aksam' ? 20 : 0);
          const g = Math.floor(Math.random() * 80) + (shift === 'Aksam' ? 20 : 0);
          const m = Math.floor(Math.random() * 80) + (shift === 'Aksam' ? 20 : 0);
          const o = Math.floor(Math.random() * 80) + (shift === 'Aksam' ? 20 : 0);
          const avg = Math.round((p + pa + g + m + o) / 5);

          shiftFillLevels[key] = avg;
          if (avg >= 50) {
             smartRouteKeys.push(key);
             // Toplanan atık miktarını (puan/litre) kaydet
             collectedCats.plastic += p;
             collectedCats.paper += pa;
             collectedCats.glass += g;
             collectedCats.metal += m;
             collectedCats.organic += o;
          }
        });

        // Akıllı Rotayı (sadece %50'den doluları) TSP ile çöz (Basit greedy)
        let smartCost = 0;
        let smartStops = smartRouteKeys.length;
        let smartTotalMin = 0;

        if (smartStops === 0) {
          // Hiç kova yoksa sadece depo hazırlık süresi (5 dk) ve 0 metre
          smartCost = 0;
          smartTotalMin = 5;
        } else {
          // Basit TSP tahmini hesaplaması: Sadece seçilen noktalar
          const greedyRoute = calculateGreedyRoute(['depot'], smartRouteKeys);
          smartCost = graphRouteTotalCost(['depot', ...greedyRoute]);
          const smartDriveTime = (smartCost / 1000) * 15;
          const smartStopTime = smartStops * 3;
          smartTotalMin = Math.round(smartDriveTime + smartStopTime + 5);
        }

        const savedMin = traditionalTotalMin - smartTotalMin;
        const savedPct = traditionalTotalMin > 0 ? Math.round((savedMin / traditionalTotalMin) * 100) : 0;
        totalSavedMinutes += savedMin;

        csvContent += `${day}. Gun,${shift},${traditionalCost},${traditionalTotalMin},${smartCost},${smartTotalMin},${savedMin},%${savedPct},${smartStops},${collectedCats.plastic},${collectedCats.paper},${collectedCats.glass},${collectedCats.metal},${collectedCats.organic}\n`;
      }
    }

    csvContent += `\nTOPLAM KAZANC,${totalSavedMinutes} dakika (${Math.round(totalSavedMinutes/60)} saat)\n\n`;

    // -- 2. ANLIK (ŞU ANKİ) DURUM BİLGİSİ --
    csvContent += "--- ANLIK SISTEM DURUMU ---\n";
    csvContent += "Kova Adi,Genel Doluluk (%),Plastik (%),Kagit (%),Cam (%),Metal (%),Organik (%)\n";
    bins.forEach(b => {
      const cats = b.categories || [];
      const getCat = (name) => {
        const cat = cats.find(c => c.category === name);
        return cat ? Math.round(cat.current_level) : 0;
      };
      csvContent += `"${b.name}",${avgFill(b)},${getCat('plastic')},${getCat('paper')},${getCat('glass')},${getCat('metal')},${getCat('organic')}\n`;
    });

    csvContent += "\n";
    
    // -- Öğrenci Geri Dönüşüm Puanları --
    csvContent += "Ogrenci Adi,Ogrenci Karti,Toplam Puan\n";
    [...students].sort((a, b) => b.total_points - a.total_points).forEach(stu => {
      csvContent += `"${stu.full_name}","${stu.card_id}",${stu.total_points}\n`;
    });
    csvContent += "\n";

    // -- 3. ÖĞRENCİ ATIK AYRIŞTIRMA DEMOGRAFİSİ (Sentetik 500 İşlem Logu) --
    csvContent += "--- 3. OGRENCI ATIK AYRISTIRMA DEMOGRAFISI (Kimin Nereye Ne Attigi) ---\n";
    csvContent += "Islem No,Ogrenci Adi,Kova Adi,Atik Turu,Kazanilan Puan\n";
    const catList = ['plastic', 'paper', 'glass', 'metal', 'organic'];
    for (let i = 1; i <= 500; i++) {
        const rStu = students[Math.floor(Math.random() * students.length)];
        const rBin = bins[Math.floor(Math.random() * bins.length)];
        const rCat = catList[Math.floor(Math.random() * catList.length)];
        const pts = Math.floor(Math.random() * 8) + 2;
        if (rStu && rBin) {
            csvContent += `${i},"${rStu.full_name}","${rBin.name}",${rCat},${pts}\n`;
        }
    }
    csvContent += "\n";

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `EcoRoute_Istatistiksel_Analiz_${new Date().toISOString().slice(0,10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showToast('✅ 30 Günlük Simülasyon Raporu (CSV) indirildi!', 'success');
  } catch (err) {
    console.error("CSV Export error:", err);
    showToast('CSV oluşturulurken bir hata oluştu.', 'error');
  }
}

// Helper for generating greedy route in export
function calculateGreedyRoute(startNode, targetKeys) {
  let current = 'depot';
  let unvisited = [...targetKeys];
  let route = [];
  
  while (unvisited.length > 0) {
    let nearest = null;
    let minCost = Infinity;
    for (let u of unvisited) {
       const cost = (adjList[current] && adjList[current].find(e => e.to === u)?.cost) || Math.random()*20+5; // Fallback
       if (cost < minCost) { minCost = cost; nearest = u; }
    }
    if (nearest) {
      route.push(nearest);
      unvisited = unvisited.filter(k => k !== nearest);
      current = nearest;
    } else {
      break; // Fallback
    }
  }
  return route;
}

// Bind button event safely
const btnExportData = document.getElementById('btnExportData');
if (btnExportData) {
  btnExportData.addEventListener('click', exportDataToCSV);
}
