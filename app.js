// ================================================================
// app.js – EcoRoute Smart Campus Waste Management
// ================================================================

// ── Supabase init ────────────────────────────────────────────────
const IS_DEMO = typeof SUPABASE_URL === 'undefined' || SUPABASE_URL.startsWith('YOUR_') ||
  typeof SUPABASE_ANON_KEY === 'undefined' || SUPABASE_ANON_KEY.startsWith('YOUR_') ||
  !window.supabase; // CDN yüklenmediyse demo mod

let supabaseClient = null;
if (!IS_DEMO) {
  try {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (e) {
    console.warn('Supabase başlatılamadı:', e.message);
  }
}

// ── State ────────────────────────────────────────────────────────
let bins = [];          // [{id, name, location, location_icon, categories:[]}]
let collectionCount = 0;
let autoFillTimer = null;
let selectedBinId = null;        // for detail modal

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

// ── Bootstrap ────────────────────────────────────────────────────
async function init() {
  // 1. Her zaman anında demo veriyle göster (boş skeleton yok)
  renderBinsOffline();
  setupEventListeners();

  // 2. Supabase varsa arka planda yükle ve üzerine yaz
  if (!IS_DEMO) {
    await loadBinsFromSupabase();
    setupRealtime();
    loadCollectionHistory();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// ── Load bins + categories from Supabase ─────────────────────────
async function loadBinsFromSupabase() {
  try {
    const { data: binData, error: binErr } = await supabaseClient
      .from('bins')
      .select('*')
      .order('name');

    if (binErr || !binData || binData.length === 0) {
      console.warn('Bins yuklenemedi, demo mod devam ediyor:', binErr?.message);
      return;
    }

    const { data: catData, error: catErr } = await supabaseClient
      .from('waste_categories')
      .select('*');

    if (catErr || !catData) {
      console.warn('Kategoriler yuklenemedi:', catErr?.message);
      return;
    }

    bins = binData.map(b => ({
      ...b,
      categories: catData.filter(c => c.bin_id === b.id)
    }));

    // Sim select'i sıfırla (demo seçenekler yerine gerçek bin'ler)
    const sel = document.getElementById('simBinSelect');
    sel.innerHTML = '<option value="all">Tümü</option>';

    renderBins();
    updateStats();
    populateSimBinSelect();
    showToast('✅ Supabase verisi yüklendi', 'success');
  } catch (e) {
    console.warn('Supabase hatasi, demo mod devam ediyor:', e.message);
  }
}

// ── Render bins ──────────────────────────────────────────────────
function renderBins() {
  binsGrid.innerHTML = '';
  bins.forEach(bin => {
    binsGrid.appendChild(createBinCard(bin));
  });
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

  const badgeText = status === 'critical' ? '🔴 Kritik' : status === 'warning' ? '🟡 Uyarı' : '🟢 Normal';
  const badgeClass = `badge-${status}`;

  // Gauge color class
  const gaugeClass = fill >= 80 ? 'critical' : fill >= 55 ? 'warning' : '';

  // Categories HTML
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
      <div class="gauge-label">
        <span>Genel Doluluk</span>
        <span>${fill}%</span>
      </div>
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

// ── Update stat bar ──────────────────────────────────────────────
function updateStats() {
  if (!bins.length) return;
  const fills = bins.map(avgFill);
  const avg = Math.round(fills.reduce((a, b) => a + b, 0) / fills.length);
  const critical = fills.filter(f => f >= 80).length;

  valAvgFill.textContent = avg + '%';
  valCritical.textContent = critical;
  valCollections.textContent = collectionCount;

  // Color coding
  valAvgFill.style.color = avg >= 80 ? 'var(--danger)' : avg >= 55 ? 'var(--warning)' : 'var(--primary)';
  valCritical.style.color = critical > 0 ? 'var(--danger)' : 'var(--primary)';
}

// ── Realtime subscription ────────────────────────────────────────
function setupRealtime() {
  supabaseClient
    .channel('waste_categories_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'waste_categories' }, async (payload) => {
      // Reload a specific bin's categories
      const changedCat = payload.new || payload.old;
      if (!changedCat) return;

      const binIndex = bins.findIndex(b => b.id === changedCat.bin_id);
      if (binIndex === -1) return;

      const { data } = await supabaseClient
        .from('waste_categories')
        .select('*')
        .eq('bin_id', changedCat.bin_id);

      if (data) {
        bins[binIndex].categories = data;
        // Re-render only affected card
        const existing = binsGrid.querySelector(`[data-bin-id="${changedCat.bin_id}"]`);
        if (existing) {
          const updated = createBinCard(bins[binIndex]);
          binsGrid.replaceChild(updated, existing);
        }
        updateStats();
      }
    })
    .subscribe();
}

// ── Bin Detail Modal ─────────────────────────────────────────────
function openBinDetail(binId) {
  const bin = bins.find(b => b.id === binId);
  if (!bin) return;
  selectedBinId = binId;

  binModalTitle.textContent = bin.name;

  const fill = avgFill(bin);
  const status = binStatus(fill);
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
  binModal.classList.add('hidden');
  selectedBinId = null;
});
binModal.addEventListener('click', e => {
  if (e.target === binModal) { binModal.classList.add('hidden'); selectedBinId = null; }
});

// Collect (reset) a single bin
document.getElementById('binCollectBtn').addEventListener('click', async () => {
  if (!selectedBinId) return;
  await collectBin(selectedBinId);
  binModal.classList.add('hidden');
  selectedBinId = null;
});

// ── Route Generation ─────────────────────────────────────────────
document.getElementById('btnGenerateRoute').addEventListener('click', generateRoute);

function generateRoute() {
  if (!bins.length) return;

  // Sort bins by average fill descending
  const sorted = [...bins].sort((a, b) => avgFill(b) - avgFill(a));
  const totalFill = sorted.reduce((s, b) => s + avgFill(b), 0);

  // Show route list
  routeEmpty.classList.add('hidden');
  routeList.classList.remove('hidden');
  routeInfo.classList.remove('hidden');

  routeList.innerHTML = '';
  sorted.forEach((bin, i) => {
    const fill = avgFill(bin);
    const status = binStatus(fill);
    const priorityColor = status === 'critical' ? 'badge-critical' : status === 'warning' ? 'badge-warning' : 'badge-ok';
    const priorityText = status === 'critical' ? '🔴 Kritik' : status === 'warning' ? '🟡 Orta' : '🟢 Düşük';

    const stop = document.createElement('div');
    stop.className = 'route-stop';
    stop.innerHTML = `
      <div class="stop-num">${i + 1}</div>
      <div class="stop-body">
        <div class="stop-name">${bin.location_icon} ${bin.location}</div>
        <div class="stop-fill">Doluluk: ${fill}%</div>
      </div>
      <span class="stop-priority ${priorityColor}">${priorityText}</span>`;
    routeList.appendChild(stop);
  });

  // Estimated time: 5 min per stop + 3 min drive between
  const minutes = sorted.length * 5 + (sorted.length - 1) * 3;
  routeTime.textContent = `~${minutes} dk`;
  routeWaste.textContent = `~${Math.round(totalFill * 1.2)} L`;

  showToast('✅ Rota doluluk oranına göre oluşturuldu!', 'success');

  // Save to Supabase
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
  if (!bins.length) return;

  const sorted = [...bins].sort((a, b) => avgFill(b) - avgFill(a));
  for (const bin of sorted) {
    if (avgFill(bin) > 10) {
      await collectBin(bin.id, false);
    }
  }

  showToast('🚛 Rota tamamlandı! Tüm kovalar boşaltıldı.', 'success');
  addHistoryItem('Rota Tamamlandı', `${sorted.length} kova toplandı`);

  // Reset route UI
  routeList.classList.add('hidden');
  routeInfo.classList.add('hidden');
  routeEmpty.classList.remove('hidden');
});

// ── Collect single bin ───────────────────────────────────────────
async function collectBin(binId, showMsg = true) {
  const bin = bins.find(b => b.id === binId);
  if (!bin) return;

  // Save levels before collecting
  const levelsBefore = {};
  (bin.categories || []).forEach(c => { levelsBefore[c.category] = c.current_level; });

  if (IS_DEMO) {
    // Demo mode: reset locally
    bin.categories.forEach(c => { c.current_level = 0; });
    if (showMsg) {
      collectionCount++;
      showToast(`🚛 ${bin.name} başarıyla toplandı!`, 'success');
      addHistoryItem(bin.name, 'Tüm kategoriler sıfırlandı');
    }
    renderBins();
    updateStats();
    return;
  }

  // Insert collection event
  await supabaseClient.from('collection_events').insert({
    bin_id: binId,
    collected_by: 'Sistem',
    levels_before: levelsBefore
  });

  // Reset all categories to 0
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

// ── Collection History ────────────────────────────────────────────
async function loadCollectionHistory() {
  const { data } = await supabaseClient
    .from('collection_events')
    .select('*, bins(name,location_icon)')
    .order('collected_at', { ascending: false })
    .limit(20);

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

// ── Simulation Modal ──────────────────────────────────────────────
function setupEventListeners() {
  document.getElementById('btnSimulate').addEventListener('click', () => {
    simModal.classList.remove('hidden');
  });
  document.getElementById('closeSimModal').addEventListener('click', () => {
    simModal.classList.add('hidden');
  });
  simModal.addEventListener('click', e => {
    if (e.target === simModal) simModal.classList.add('hidden');
  });

  document.getElementById('simFill10').addEventListener('click', () => applySimulation(10));
  document.getElementById('simFill25').addEventListener('click', () => applySimulation(25));
  document.getElementById('simFill50').addEventListener('click', () => applySimulation(50));
  document.getElementById('simDrain').addEventListener('click', () => applySimulation(-100));
  document.getElementById('simRandom').addEventListener('click', () => {
    const delta = Math.floor(Math.random() * 60) - 10;
    applySimulation(delta);
  });

  // Auto fill toggle
  document.getElementById('autoFillToggle').addEventListener('change', e => {
    const status = document.getElementById('autoFillStatus');
    if (e.target.checked) {
      status.textContent = 'Açık';
      autoFillTimer = setInterval(() => {
        const delta = Math.floor(Math.random() * 8) + 2;
        applySimulation(delta);
      }, 5000);
    } else {
      status.textContent = 'Kapalı';
      clearInterval(autoFillTimer);
      autoFillTimer = null;
    }
  });
}

function populateSimBinSelect() {
  const sel = document.getElementById('simBinSelect');
  bins.forEach(bin => {
    const opt = document.createElement('option');
    opt.value = bin.id;
    opt.textContent = `${bin.location_icon} ${bin.location}`;
    sel.appendChild(opt);
  });
}

async function applySimulation(delta) {
  const binSel = document.getElementById('simBinSelect').value;
  const catSel = document.getElementById('simCatSelect').value;

  const targetBins = binSel === 'all' ? bins : bins.filter(b => b.id === binSel);

  for (const bin of targetBins) {
    const targetCats = catSel === 'all' ? bin.categories : bin.categories.filter(c => c.category === catSel);

    for (const cat of targetCats) {
      let newLevel = Math.min(100, Math.max(0, parseFloat(cat.current_level) + delta));

      if (!IS_DEMO) {
        await supabaseClient
          .from('waste_categories')
          .update({ current_level: newLevel, updated_at: new Date().toISOString() })
          .eq('id', cat.id);
      }

      // Update local state immediately for responsiveness
      cat.current_level = newLevel;
    }
  }

  renderBins();
  updateStats();

  const action = delta > 0 ? `+${delta}% dolduruldu` : delta < -50 ? 'boşaltıldı' : `${delta}% azaltıldı`;
  showToast(`⚡ Simülasyon: ${action}`, delta < 0 ? 'warning' : 'success');
}

// ── Offline / Demo fallback ───────────────────────────────────────
function renderBinsOffline() {
  collectionCount = 0;
  bins = [
    {
      id: 'demo-1', name: 'Kütüphane Çöp Kovası',
      location: 'Kütüphane', location_icon: '📚', capacity_liters: 120,
      categories: [
        { id: 'd1', bin_id: 'demo-1', category: 'plastic', current_level: 15, color_hex: '#3B82F6', icon: '♳' },
        { id: 'd2', bin_id: 'demo-1', category: 'paper', current_level: 45, color_hex: '#F59E0B', icon: '📄' },
        { id: 'd3', bin_id: 'demo-1', category: 'organic', current_level: 5, color_hex: '#10B981', icon: '🌿' },
        { id: 'd4', bin_id: 'demo-1', category: 'glass', current_level: 10, color_hex: '#8B5CF6', icon: '🍶' },
        { id: 'd5', bin_id: 'demo-1', category: 'metal', current_level: 8, color_hex: '#6B7280', icon: '🥫' }
      ]
    },
    {
      id: 'demo-2', name: 'Ders Binası Çöp Kovası',
      location: 'Ders Binası', location_icon: '🏫', capacity_liters: 120,
      categories: [
        { id: 'e1', bin_id: 'demo-2', category: 'plastic', current_level: 65, color_hex: '#3B82F6', icon: '♳' },
        { id: 'e2', bin_id: 'demo-2', category: 'paper', current_level: 78, color_hex: '#F59E0B', icon: '📄' },
        { id: 'e3', bin_id: 'demo-2', category: 'organic', current_level: 20, color_hex: '#10B981', icon: '🌿' },
        { id: 'e4', bin_id: 'demo-2', category: 'glass', current_level: 30, color_hex: '#8B5CF6', icon: '🍶' },
        { id: 'e5', bin_id: 'demo-2', category: 'metal', current_level: 55, color_hex: '#6B7280', icon: '🥫' }
      ]
    },
    {
      id: 'demo-3', name: 'Yemekhane Çöp Kovası',
      location: 'Yemekhane', location_icon: '🍽️', capacity_liters: 120,
      categories: [
        { id: 'f1', bin_id: 'demo-3', category: 'plastic', current_level: 40, color_hex: '#3B82F6', icon: '♳' },
        { id: 'f2', bin_id: 'demo-3', category: 'paper', current_level: 25, color_hex: '#F59E0B', icon: '📄' },
        { id: 'f3', bin_id: 'demo-3', category: 'organic', current_level: 92, color_hex: '#10B981', icon: '🌿' },
        { id: 'f4', bin_id: 'demo-3', category: 'glass', current_level: 60, color_hex: '#8B5CF6', icon: '🍶' },
        { id: 'f5', bin_id: 'demo-3', category: 'metal', current_level: 35, color_hex: '#6B7280', icon: '🥫' }
      ]
    }
  ];
  renderBins();
  updateStats();
  populateSimBinSelect();
  showToast('ℹ️ Demo mod aktif — Supabase bağlantısı yok', 'warning');
}

// ── Toast helper ─────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, type = 'success') {
  toast.textContent = msg;
  toast.className = `toast ${type}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.classList.add('hidden'); }, 3500);
}
