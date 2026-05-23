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

// Charts State
let distChart = null;
let weeklyChart = null;

// ── Gamification State ───────────────────────────────────────────
let students = [
  { card_id: 'CARD-001', full_name: 'Ahmet Yılmaz', total_points: 45 },
  { card_id: 'CARD-002', full_name: 'Ayşe Demir', total_points: 20 },
  { card_id: 'CARD-003', full_name: 'Mehmet Kaya', total_points: 12 }
];
const POINTS_MAP = { metal: 10, glass: 7, plastic: 5, paper: 3, organic: 2 };


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
  initCharts();

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

// ── Gamification Leaderboard ──────────────────────────────────────
function renderLeaderboard() {
  const leaderboardList = document.getElementById('leaderboardList');
  if (!leaderboardList) return;
  leaderboardList.innerHTML = '';
  // Sort by points descending
  const sorted = [...students].sort((a, b) => b.total_points - a.total_points);

  sorted.forEach((stu, index) => {
    const item = document.createElement('div');
    item.className = 'student-item';
    let medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '👤';

    item.innerHTML = `
      <div>
        <div class="student-name">${medal} ${stu.full_name}</div>
        <div class="student-card">Gerçek Zamanlı Takip</div>
      </div>
      <div class="student-points">${stu.total_points} Puan</div>
    `;
    leaderboardList.appendChild(item);
  });
}

function addFeedItem(studentName, location, category, points) {
  const feedList = document.getElementById('feedList');
  if (!feedList) return;

  const empty = feedList.querySelector('.history-empty');
  if (empty) empty.remove();

  const item = document.createElement('div');
  item.className = 'history-item';
  const timeStr = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  item.innerHTML = `
    <div class="history-item-title" style="display:flex; justify-content:space-between;">
      <span>👤 ${studentName}</span>
      <span style="color:var(--primary); font-weight:800;">+${points}</span>
    </div>
    <div class="history-item-meta">${location} • ${category} • 🕒 ${timeStr}</div>
  `;
  feedList.prepend(item);

  // Keep only last 10
  while (feedList.children.length > 10) {
    feedList.removeChild(feedList.lastChild);
  }
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

  let maxAdded = 0;
  let feedBinName = "Bir çöp kovası";
  let feedCatName = "plastic"; // fallback

  for (const bin of targetBins) {
    const targetCats = catSel === 'all' ? bin.categories : bin.categories.filter(c => c.category === catSel);

    for (const cat of targetCats) {
      let actualDelta = delta;

      // Eşit artmaması için rastgeleleştirme (sadece atık eklenirken)
      if (delta > 0) {
        const multiplier = (Math.random() * 1.4) + 0.1; // 0.1x to 1.5x
        actualDelta = Math.floor(delta * multiplier);

        // "Tümü" seçiliyse %40 ihtimalle bazı kategorilere hiç atık atılmasın (daha organik)
        if (catSel === 'all' && Math.random() < 0.4) {
          actualDelta = 0;
        }
      }

      if (actualDelta === 0 && delta > 0) continue;

      let newLevel = Math.min(100, Math.max(0, parseFloat(cat.current_level) + actualDelta));

      if (actualDelta > maxAdded) {
        maxAdded = actualDelta;
        feedBinName = bin.location;
        feedCatName = cat.category;
      }

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

  const action = delta > 0 ? `Sisteme atıklar organik olarak eklendi` : delta < -50 ? 'boşaltıldı' : `${delta}% azaltıldı`;

  if (delta > 0 && maxAdded > 0) {
    // Gamification hook: Auto-simulate a student throwing waste
    const student = students[Math.floor(Math.random() * students.length)];
    const points = POINTS_MAP[feedCatName] || 5;

    const catLabels = { plastic: 'Plastik', paper: 'Kağıt', glass: 'Cam', metal: 'Metal', organic: 'Organik' };
    const catLabel = catLabels[feedCatName] || 'Atık';

    const wasBelow50 = student.total_points < 50;
    student.total_points += points;
    const isNowAbove50 = student.total_points >= 50;

    renderLeaderboard();

    // Add to live feed
    addFeedItem(student.full_name, feedBinName, catLabel, points);

    if (wasBelow50 && isNowAbove50) {
      setTimeout(() => {
        showToast(`${student.full_name.toUpperCase()}! 50 Puanı geçti, Kantinden 1 Çay Kazandı! `, 'success');
      }, 1500);
    }
  } else if (delta < 0) {
    showToast(`⚡ Simülasyon: ${action}`, delta < -50 ? 'success' : 'warning');
  }
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

// ── Charts Logic ─────────────────────────────────────────────────
function initCharts() {
  const ctxDist = document.getElementById('wasteDistributionChart');
  if (ctxDist) {
    distChart = new Chart(ctxDist, {
      type: 'doughnut',
      data: {
        labels: ['Plastik', 'Kağıt', 'Cam', 'Metal', 'Organik'],
        datasets: [{
          data: [25, 30, 15, 10, 20], // Initial mock data
          backgroundColor: ['#3B82F6', '#F59E0B', '#8B5CF6', '#6B7280', '#10B981'],
          borderWidth: 0,
          hoverOffset: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right', labels: { color: '#94a3b8', font: { family: "'Inter', sans-serif" } } }
        },
        cutout: '70%'
      }
    });
  }

  const ctxWeek = document.getElementById('weeklyRecyclingChart');
  if (ctxWeek) {
    weeklyChart = new Chart(ctxWeek, {
      type: 'line',
      data: {
        labels: ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'],
        datasets: [{
          label: 'Toplanan Atık (kg)',
          data: [45, 52, 38, 65, 48, 20, 15],
          borderColor: '#34d399',
          backgroundColor: 'rgba(52,211,153,0.1)',
          borderWidth: 3,
          pointBackgroundColor: '#34d399',
          pointBorderColor: '#fff',
          pointRadius: 4,
          tension: 0.4,
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8' }, beginAtZero: true },
          x: { grid: { display: false }, ticks: { color: '#94a3b8' } }
        }
      }
    });
  }
}

function updateChartsData() {
  if (!distChart) return;

  let totals = { plastic: 0, paper: 0, glass: 0, metal: 0, organic: 0 };
  bins.forEach(bin => {
    (bin.categories || []).forEach(cat => {
      if (totals[cat.category] !== undefined) {
        totals[cat.category] += parseFloat(cat.current_level || 0);
      }
    });
  });

  const sum = Object.values(totals).reduce((a, b) => a + b, 0);
  if (sum > 0) {
    distChart.data.datasets[0].data = [totals.plastic, totals.paper, totals.glass, totals.metal, totals.organic];
    distChart.update();
  }
}

// Override updateStats to also update charts
const originalUpdateStats = updateStats;
updateStats = function () {
  originalUpdateStats();
  updateChartsData();
};

// Render leaderboard on boot
setTimeout(renderLeaderboard, 500);

