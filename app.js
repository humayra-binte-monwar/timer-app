// ─── GIST SYNC ───────────────────────────────────────────────────────────────

const GIST_FILE = 'timer-data.json';

const syncToken  = () => localStorage.getItem('syncToken')  || sessionStorage.getItem('syncToken')  || '';
const syncGistId = () => localStorage.getItem('syncGistId') || sessionStorage.getItem('syncGistId') || '';

function saveSyncCredentials(token, gistId) {
  if (token  !== undefined) { localStorage.setItem('syncToken',  token);  sessionStorage.setItem('syncToken',  token); }
  if (gistId !== undefined) { localStorage.setItem('syncGistId', gistId); sessionStorage.setItem('syncGistId', gistId); }
}

function clearSyncCredentials() {
  ['syncToken','syncGistId'].forEach(k => { localStorage.removeItem(k); sessionStorage.removeItem(k); });
}

async function gistRequest(method, path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch('https://api.github.com/gists' + path, {
      method,
      signal: controller.signal,
      headers: {
        'Authorization': 'token ' + syncToken(),
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error('GitHub API ' + res.status);
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function syncPayload() {
  return {
    tags:          state.tags,
    sessions:      state.sessions,
    nextTagId:     state.nextTagId,
    nextSessionId: state.nextSessionId,
  };
}

async function gistLoad() {
  const gist = await gistRequest('GET', '/' + syncGistId());
  const raw = gist.files[GIST_FILE]?.content;
  return raw ? JSON.parse(raw) : null;
}

let _gistTimer = null;
function scheduleGistWrite() {
  if (!syncToken()) return;
  clearTimeout(_gistTimer);
  _gistTimer = setTimeout(gistWrite, 1500);
}

async function gistWrite() {
  if (!syncToken() || !syncGistId()) return;
  setSyncStatus('syncing');
  try {
    await gistRequest('PATCH', '/' + syncGistId(), {
      files: { [GIST_FILE]: { content: JSON.stringify(syncPayload(), null, 2) } },
    });
    setSyncStatus('saved');
  } catch { setSyncStatus('error'); }
}

// Connect: finds an existing timer-data gist or creates a new one.
// On a new device this automatically pulls in all existing data.
async function connectSync() {
  const token = document.getElementById('sync-token').value.trim();
  const manualId = document.getElementById('sync-gist-id').value.trim();
  if (!token) return;
  const btn = document.getElementById('btn-sync-connect');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  saveSyncCredentials(token, undefined);
  setSyncStatus('syncing');
  try {
    let gistId = manualId;
    if (!gistId) {
      // Auto-search the user's gists for an existing timer-data.json
      const gists = await gistRequest('GET', '?per_page=100');
      const existing = gists.find(g => GIST_FILE in g.files);
      gistId = existing ? existing.id : null;
    }
    if (gistId) {
      saveSyncCredentials(undefined, gistId);
      const data = await gistLoad();
      if (data) {
        state.tags          = data.tags          ?? state.tags;
        state.sessions      = data.sessions      ?? state.sessions;
        state.nextTagId     = data.nextTagId     ?? state.nextTagId;
        state.nextSessionId = data.nextSessionId ?? state.nextSessionId;
        save();
        renderAll();
      }
    } else {
      const gist = await gistRequest('POST', '', {
        description: 'Timer App Data',
        public: false,
        files: { [GIST_FILE]: { content: JSON.stringify(syncPayload(), null, 2) } },
      });
      saveSyncCredentials(undefined, gist.id);
    }
    renderSyncUI();
    setSyncStatus('saved');
  } catch (e) {
    clearSyncCredentials();
    const msg = e.name === 'AbortError' ? 'Request timed out — check your internet connection.' : e.message;
    alert('Could not connect:\n' + msg);
    setSyncStatus('off');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
}

function disconnectSync() {
  if (!confirm('Disconnect sync? Your data stays in this browser.')) return;
  clearSyncCredentials();
  renderSyncUI();
}

function setSyncStatus(s) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  const map = {
    syncing: ['↻ Syncing…',   'syncing'],
    saved:   ['✓ Synced',     'saved'],
    error:   ['⚠ Sync error', 'error'],
    off:     ['',             ''],
  };
  const [text, cls] = map[s] || map.off;
  el.textContent = text;
  el.className = 'sync-status' + (cls ? ' ' + cls : '');
}

function renderSyncUI() {
  const setup     = document.getElementById('sync-setup');
  const connected = document.getElementById('sync-connected');
  if (syncToken()) {
    setup.hidden = false; // keep visible so user can re-enter if needed
    document.getElementById('sync-token').value = '';
    document.getElementById('sync-gist-id').value = '';
    setup.hidden = true;
    connected.hidden = false;
    const display = document.getElementById('sync-gist-display');
    if (display) display.textContent = syncGistId() ? 'Gist ID: ' + syncGistId() : '';
  } else {
    setup.hidden = false;
    connected.hidden = true;
  }
}

// ─── STATE ───────────────────────────────────────────────────────────────────

const _savedTimer = load('timer', {});

const state = {
  tags:     load('tags',     []),
  sessions: load('sessions', []),
  nextTagId:     load('nextTagId',     1),
  nextSessionId: load('nextSessionId', 1),
  timer: {
    running:       false,
    paused:        _savedTimer.paused        ?? false,
    startTime:     _savedTimer.startTime     ?? null,
    elapsed:       _savedTimer.elapsed       ?? 0,
    interval:      null,
    tagId:         _savedTimer.tagId         ?? null,
    mode:          _savedTimer.mode          ?? 'up',
    countdownSecs: _savedTimer.countdownSecs ?? 25 * 60,
  },
};

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

function save() {
  localStorage.setItem('tags',          JSON.stringify(state.tags));
  localStorage.setItem('sessions',      JSON.stringify(state.sessions));
  localStorage.setItem('nextTagId',     state.nextTagId);
  localStorage.setItem('nextSessionId', state.nextSessionId);
  scheduleGistWrite();
}

function saveTimer() {
  const { paused, startTime, elapsed, tagId, running, mode, countdownSecs } = state.timer;
  localStorage.setItem('timer', JSON.stringify({
    paused, startTime, elapsed, tagId, mode, countdownSecs,
    lastHeartbeat: running ? Date.now() : null,
  }));
}

function clearTimerStorage() {
  localStorage.setItem('timer', JSON.stringify({}));
}

// ─── TAG HELPERS ─────────────────────────────────────────────────────────────

function getTag(id) { return state.tags.find(t => t.id === id); }

function tagAncestors(id) {
  const parts = [];
  let cur = getTag(id);
  while (cur) {
    parts.unshift(cur.name);
    cur = getTag(cur.parentId);
  }
  return parts;
}

function tagPath(id) { return tagAncestors(id).join(' > '); }

function sortedTags() {
  const result = [];
  const visited = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const tag = getTag(id);
    if (tag.parentId != null) visit(tag.parentId);
    result.push(tag);
  }
  state.tags.forEach(t => visit(t.id));
  return result;
}

function addTag(name, parentId) {
  if (!name.trim()) return false;
  const dup = state.tags.some(t =>
    t.name.toLowerCase() === name.trim().toLowerCase() &&
    t.parentId === (parentId || null)
  );
  if (dup) { alert('A tag with that name already exists under the same parent.'); return false; }
  state.tags.push({ id: state.nextTagId++, name: name.trim(), parentId: parentId || null });
  save();
  return true;
}

function deleteTag(id) {
  if (state.tags.some(t => t.parentId === id)) {
    alert('Remove child tags first.'); return;
  }
  if (state.sessions.some(s => s.tagId === id)) {
    alert('Sessions exist for this tag.'); return;
  }
  state.tags = state.tags.filter(t => t.id !== id);
  if (state.timer.tagId === id) { stopTimer(false); state.timer.tagId = null; }
  save();
  renderAll();
}

// ─── TIMER ───────────────────────────────────────────────────────────────────

function currentMs() {
  if (state.timer.running) return state.timer.elapsed + (Date.now() - state.timer.startTime);
  return state.timer.elapsed;
}

function startTimer() {
  if (!state.timer.tagId) { alert('Select a tag before starting.'); return; }
  if (state.timer.running) return;
  state.timer.startTime = Date.now();
  state.timer.running = true;
  state.timer.paused = false;
  state.timer.interval = setInterval(tickClock, 100);
  saveTimer();
  renderTimerControls();
}

function pauseTimer() {
  if (!state.timer.running) return;
  clearInterval(state.timer.interval);
  state.timer.elapsed += Date.now() - state.timer.startTime;
  state.timer.running = false;
  state.timer.paused = true;
  saveTimer();
  renderTimerControls();
}

function stopTimer(save_ = true) {
  clearInterval(state.timer.interval);
  const ms = currentMs();
  if (save_ && ms >= 1000 && state.timer.tagId != null) {
    state.sessions.push({
      id:       state.nextSessionId++,
      tagId:    state.timer.tagId,
      date:     new Date().toISOString(),
      duration: Math.floor(ms / 1000),
    });
    save();
  }
  state.timer.running   = false;
  state.timer.paused    = false;
  state.timer.elapsed   = 0;
  state.timer.startTime = null;
  clearTimerStorage();
  renderAll();
}

function tickClock() { renderClock(); renderPip(); }

// ─── FORMAT ──────────────────────────────────────────────────────────────────

function fmt(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ─── RENDER ──────────────────────────────────────────────────────────────────

function renderAll() {
  renderTagSelect();
  renderParentSelect();
  renderTagTree();
  renderClock();
  renderTimerControls();
  renderHistory();
}

function renderClock() {
  const clock = document.getElementById('clock');
  if (state.timer.mode === 'down') {
    const remaining = state.timer.countdownSecs * 1000 - currentMs();
    if (remaining > 0) {
      clock.textContent = fmt(Math.ceil(remaining / 1000));
      clock.classList.remove('overtime');
    } else {
      clock.textContent = '+' + fmt(Math.floor(-remaining / 1000));
      clock.classList.add('overtime');
    }
  } else {
    clock.textContent = fmt(Math.floor(currentMs() / 1000));
    clock.classList.remove('overtime');
  }
}

function renderTimerControls() {
  const { running, paused } = state.timer;
  const btnStart = document.getElementById('btn-start');
  const btnPause = document.getElementById('btn-pause');
  const btnStop  = document.getElementById('btn-stop');
  btnStart.textContent = paused ? 'Resume' : 'Start';
  btnStart.disabled = running;
  btnPause.disabled = !running;
  btnStop.disabled  = !running && !paused;
  renderPip();
}

function renderTagSelect() {
  const sel = document.getElementById('tag-select');
  sel.innerHTML = '<option value="">— select a tag —</option>';
  sortedTags().forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = tagPath(t.id);
    sel.appendChild(opt);
  });
  if (state.timer.tagId != null) sel.value = state.timer.tagId;
}

function renderParentSelect() {
  const sel = document.getElementById('tag-parent');
  const prev = sel.value;
  sel.innerHTML = '<option value="">No parent (top level)</option>';
  sortedTags().forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = tagPath(t.id);
    sel.appendChild(opt);
  });
  if (prev) sel.value = prev;
}

function renderTagTree() {
  const ul = document.getElementById('tag-tree');
  ul.innerHTML = '';
  if (state.tags.length === 0) {
    ul.innerHTML = '<li style="color:var(--muted);font-size:13px;padding:8px 0">No tags yet.</li>';
    return;
  }
  sortedTags().forEach(tag => {
    const parts = tagAncestors(tag.id);
    const depth = parts.length - 1;
    const li = document.createElement('li');
    li.className = 'tag-node';
    li.style.paddingLeft = `${8 + depth * 16}px`;

    const pathSpan = document.createElement('span');
    pathSpan.className = 'path';
    if (depth > 0) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '╴';
      pathSpan.appendChild(sep);
    }
    pathSpan.appendChild(document.createTextNode(tag.name));

    const delBtn = document.createElement('button');
    delBtn.className = 'del';
    delBtn.textContent = '×';
    delBtn.title = 'Delete tag';
    delBtn.onclick = () => deleteTag(tag.id);

    li.appendChild(pathSpan);
    li.appendChild(delBtn);
    ul.appendChild(li);
  });
}

function renderHistory() {
  const container = document.getElementById('history-list');
  if (!container) return;
  if (state.sessions.length === 0) {
    container.innerHTML = '<div class="no-history">No sessions yet. Start a timer!</div>';
    return;
  }
  const groups = {};
  state.sessions.forEach(s => {
    if (!groups[s.tagId]) groups[s.tagId] = [];
    groups[s.tagId].push(s);
  });
  const sorted = Object.entries(groups).sort((a, b) => {
    const sumA = a[1].reduce((acc, s) => acc + s.duration, 0);
    const sumB = b[1].reduce((acc, s) => acc + s.duration, 0);
    return sumB - sumA;
  });
  container.innerHTML = '';
  sorted.forEach(([tagId, sessions]) => {
    const id = parseInt(tagId);
    const total = sessions.reduce((acc, s) => acc + s.duration, 0);
    const path = getTag(id) ? tagPath(id) : `[deleted tag #${id}]`;

    const group = document.createElement('div');
    group.className = 'history-group';

    const header = document.createElement('div');
    header.className = 'history-group-header';
    header.innerHTML = `
      <span class="tag-path">${escHtml(path)}</span>
      <span class="total">${fmt(total)} total</span>
    `;

    const sessionsEl = document.createElement('div');
    sessionsEl.className = 'history-sessions';

    [...sessions].sort((a, b) => new Date(b.date) - new Date(a.date)).forEach(s => {
      const row = document.createElement('div');
      row.className = 'history-session';
      row.innerHTML = `
        <span>${escHtml(fmtDate(s.date))}</span>
        <span class="duration">${fmt(s.duration)}</span>
      `;
      sessionsEl.appendChild(row);
    });

    header.addEventListener('click', () => sessionsEl.classList.toggle('open'));
    group.appendChild(header);
    group.appendChild(sessionsEl);
    container.appendChild(group);
  });
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── STATS / CHARTS ──────────────────────────────────────────────────────────

const CHART_COLORS = [
  '#4e79a7','#75a1c7','#a0cbe8','#499894','#69aaa5',
  '#86bcb6','#59a14f','#72b966','#8cd17d','#b6992d',
  '#d3b348','#f1ce63','#f28e2b','#f9a655','#ffbe7d',
  '#b07aa1','#c290b4','#d4a6c8','#d37295','#e799b3',
  '#fabfd2','#e15759','#f17b79','#ff9d9a',
];

// Stable tag → colour mapping, sorted by total duration descending so the
// donut, its legend, and the stacked bars all colour each tag identically.
function tagColorMap() {
  const totals = {};
  state.sessions.forEach(s => { totals[s.tagId] = (totals[s.tagId] || 0) + s.duration; });
  const map = {};
  Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .forEach(([tagId], i) => { map[tagId] = CHART_COLORS[i % CHART_COLORS.length]; });
  return map;
}

// Which calendar window the overview bar chart shows: 'week' | 'month' | 'year'
let statsView = 'week';

// ─── THEMES ──────────────────────────────────────────────────────────────────

// Single dark theme, tuned to sit beneath the categorical chart palette above
const THEME = {
  bg:'#1B1B1D', surface:'#2A2A2E', border:'#3A3A3F',
  accent:'#B8B8BE', text:'#E4E4E7', muted:'#8A8A90', green:'#72b966',
};

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function applyTheme(theme) {
  const r = document.documentElement;
  r.style.setProperty('--bg',      theme.bg);
  r.style.setProperty('--surface', theme.surface);
  r.style.setProperty('--border',  theme.border);
  r.style.setProperty('--accent',  theme.accent);
  r.style.setProperty('--text',    theme.text);
  r.style.setProperty('--muted',   theme.muted);
  r.style.setProperty('--green',   theme.green);
}

function setupCanvas(canvas, cssW, cssH) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width  = cssW + 'px';
  canvas.style.height = cssH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return ctx;
}

function drawDonut() {
  const CSS = 200;
  const canvas = document.getElementById('donut-canvas');
  const ctx = setupCanvas(canvas, CSS, CSS);

  const groups = {};
  state.sessions.forEach(s => { groups[s.tagId] = (groups[s.tagId] || 0) + s.duration; });
  const total = Object.values(groups).reduce((a, b) => a + b, 0);

  const legend = document.getElementById('donut-legend');
  legend.innerHTML = '';

  if (total === 0) {
    ctx.fillStyle = cssVar('--border');
    ctx.beginPath();
    ctx.arc(CSS/2, CSS/2, CSS*0.44, 0, 2*Math.PI);
    ctx.arc(CSS/2, CSS/2, CSS*0.44*0.58, 2*Math.PI, 0, true);
    ctx.fill();
    legend.innerHTML = '<span style="color:var(--muted);font-size:12px">No sessions yet.</span>';
    return;
  }

  const sorted = Object.entries(groups).sort((a, b) => b[1] - a[1]);
  const colorMap = tagColorMap();
  const cx = CSS/2, cy = CSS/2, r = CSS*0.44, inner = r*0.58;

  let angle = -Math.PI/2;
  sorted.forEach(([tagId, secs]) => {
    const slice = (secs / total) * 2 * Math.PI;
    ctx.beginPath();
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.arc(cx, cy, inner, angle + slice, angle, true);
    ctx.closePath();
    ctx.fillStyle = colorMap[tagId];
    ctx.fill();
    angle += slice;
  });

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = cssVar('--text');
  ctx.font = 'bold 14px Roboto, sans-serif';
  ctx.fillText(fmt(total), cx, cy - 8);
  ctx.font = '10px Roboto, sans-serif';
  ctx.fillStyle = cssVar('--muted');
  ctx.fillText('total', cx, cy + 9);

  sorted.forEach(([tagId, secs]) => {
    const id = parseInt(tagId);
    const path = getTag(id) ? tagPath(id) : `[deleted #${id}]`;
    const pct = Math.round((secs / total) * 100);
    const row = document.createElement('div');
    row.className = 'legend-row';
    row.innerHTML = `
      <span class="legend-dot" style="background:${colorMap[tagId]}"></span>
      <span class="legend-label">${escHtml(path)}</span>
      <span class="legend-val">${fmt(secs)}</span>
      <span class="legend-pct">${pct}%</span>
    `;
    legend.appendChild(row);
  });
}

// Bucket sessions into the columns of the selected calendar view.
// Each bucket = { label, byTag: { tagId: secs }, total }. `labelIdx` is the
// set of bucket indices that get an x-axis label; `title` names the period.
function addToBucket(bucket, s) {
  bucket.byTag[s.tagId] = (bucket.byTag[s.tagId] || 0) + s.duration;
  bucket.total += s.duration;
}

function statsBuckets(view) {
  const now = new Date();
  const buckets = [];
  let labelIdx = [];
  let title = '';

  if (view === 'week') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // back to Monday
    const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    for (let i = 0; i < 7; i++) buckets.push({ label: names[i], byTag: {}, total: 0 });
    state.sessions.forEach(s => {
      const idx = Math.floor((new Date(s.date) - start) / 86400000);
      if (idx >= 0 && idx < 7) addToBucket(buckets[idx], s);
    });
    labelIdx = [0, 1, 2, 3, 4, 5, 6];
    title = 'This Week';

  } else if (view === 'month') {
    const year = now.getFullYear(), month = now.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let i = 0; i < daysInMonth; i++) buckets.push({ label: String(i + 1), byTag: {}, total: 0 });
    state.sessions.forEach(s => {
      const d = new Date(s.date);
      if (d.getFullYear() === year && d.getMonth() === month) addToBucket(buckets[d.getDate() - 1], s);
    });
    for (let i = 0; i < daysInMonth; i += 7) labelIdx.push(i);
    if (labelIdx[labelIdx.length - 1] !== daysInMonth - 1) labelIdx.push(daysInMonth - 1);
    title = now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  } else { // year
    const year = now.getFullYear();
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    for (let i = 0; i < 12; i++) buckets.push({ label: names[i], byTag: {}, total: 0 });
    state.sessions.forEach(s => {
      const d = new Date(s.date);
      if (d.getFullYear() === year) addToBucket(buckets[d.getMonth()], s);
    });
    labelIdx = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    title = String(year);
  }

  return { buckets, labelIdx, title };
}

function drawBars() {
  const wrap = document.getElementById('bar-canvas-wrap');
  const cssW = wrap.clientWidth || 400;
  const cssH = 150;
  const canvas = document.getElementById('bar-canvas');
  const ctx = setupCanvas(canvas, cssW, cssH);

  const colorMap = tagColorMap();
  const { buckets, labelIdx, title } = statsBuckets(statsView);

  const titleEl = document.getElementById('bar-title');
  if (titleEl) titleEl.textContent = title;

  const rawMax = Math.max(...buckets.map(b => b.total), 3600);
  const maxVal = Math.ceil(rawMax / 3600) * 3600; // snap up to next full hour
  const padL = 40, padR = 8, padT = 8, padB = 30;
  const chartW = cssW - padL - padR;
  const chartH = cssH - padT - padB;
  const barW = chartW / buckets.length;

  // Grid lines + Y labels
  const ySteps = [0.25, 0.5, 0.75, 1.0];
  ySteps.forEach(t => {
    const y = padT + chartH * (1 - t);
    const secs = Math.round(t * maxVal);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const label = h > 0 ? `${h}h` : `${m}m`;
    ctx.fillStyle = cssVar('--muted');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.font = '9px Roboto, sans-serif';
    ctx.fillText(label, padL - 4, y);
    ctx.strokeStyle = cssVar('--border');
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + chartW, y);
    ctx.stroke();
  });
  ctx.globalAlpha = 1;

  // Stacked bars — one segment per tag, coloured to match the donut/legend
  buckets.forEach((b, i) => {
    if (b.total === 0) return;
    const x = padL + i * barW;
    const segs = Object.entries(b.byTag).sort((a, c) => c[1] - a[1]);
    let yCursor = padT + chartH; // baseline; stack each segment upward
    segs.forEach(([tagId, secs], j) => {
      const segH = (secs / maxVal) * chartH;
      const y = yCursor - segH;
      ctx.fillStyle = colorMap[tagId] || cssVar('--accent');
      ctx.beginPath();
      if (j === segs.length - 1) ctx.roundRect(x + 1, y, barW - 2, segH, [2, 2, 0, 0]);
      else ctx.rect(x + 1, y, barW - 2, segH);
      ctx.fill();
      yCursor = y;
    });
  });

  // X axis baseline
  ctx.strokeStyle = cssVar('--border');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT + chartH);
  ctx.lineTo(padL + chartW, padT + chartH);
  ctx.stroke();

  // X labels
  ctx.fillStyle = cssVar('--muted');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = '9px Roboto, sans-serif';
  labelIdx.forEach(i => {
    const x = padL + i * barW + barW / 2;
    ctx.fillText(buckets[i].label, x, padT + chartH + 5);
  });
}

function setStatsView(view) {
  statsView = view;
  document.querySelectorAll('.view-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === view));
  drawBars();
}

function renderStats() {
  const total = state.sessions.reduce((a, s) => a + s.duration, 0);
  const tagCount = new Set(state.sessions.map(s => s.tagId)).size;
  document.getElementById('stats-summary').innerHTML = `
    <div class="stat-card"><div class="stat-val">${state.sessions.length}</div><div class="stat-lbl">Sessions</div></div>
    <div class="stat-card"><div class="stat-val">${fmt(total)}</div><div class="stat-lbl">Total Time</div></div>
    <div class="stat-card"><div class="stat-val">${tagCount}</div><div class="stat-lbl">Tags Used</div></div>
  `;
  drawDonut();
  drawBars();
}

function openStats() {
  document.getElementById('stats-modal').removeAttribute('hidden');
  renderStats();
}

function closeStats() {
  document.getElementById('stats-modal').setAttribute('hidden', '');
}

// ─── PICTURE-IN-PICTURE ──────────────────────────────────────────────────────

let _pip = null;

async function openPip() {
  if (_pip && !_pip.closed) { _pip.focus(); return; }

  const w = 300, h = 160;

  // Document PiP API: floating window that stays on top of all other OS windows
  if (window.documentPictureInPicture) {
    try {
      _pip = await window.documentPictureInPicture.requestWindow({ width: w, height: h });
      _pip.addEventListener('pagehide', () => { _pip = null; });
    } catch (e) { console.error('Document PiP failed:', e); _pip = null; }
  }

  // Fallback: regular popup (does not stay on top)
  if (!_pip) {
    const left = Math.max(0, window.screen.availWidth  - w - 16);
    const top  = Math.max(0, window.screen.availHeight - h - 60);
    _pip = window.open(
      '', 'timer-pip',
      `width=${w},height=${h},left=${left},top=${top},` +
      'resizable=no,toolbar=no,menubar=no,location=no,status=no,scrollbars=no'
    );
    if (!_pip) return;
    _pip.addEventListener('beforeunload', () => { _pip = null; });
  }

  const styleHref = document.querySelector('link[href*="style.css"]').href;
  const fontsHref = document.querySelector('link[href*="fonts.googleapis"]').href;

  _pip.document.write(`<!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    <link rel="stylesheet" href="${styleHref}">
    <link rel="stylesheet" href="${fontsHref}">
  </head><body>
    <div class="pip-wrap">
      <div class="pip-tag" id="pip-tag"></div>
      <div class="pip-clock" id="pip-clock">00:00:00</div>
      <div class="pip-controls">
        <button id="pip-start" class="btn primary small">Start</button>
        <button id="pip-pause" class="btn small" disabled>Pause</button>
        <button id="pip-stop"  class="btn danger small" disabled>Stop</button>
      </div>
    </div>
  </body></html>`);
  _pip.document.close();

  _pip.document.getElementById('pip-start').addEventListener('click', startTimer);
  _pip.document.getElementById('pip-pause').addEventListener('click', pauseTimer);
  _pip.document.getElementById('pip-stop').addEventListener('click', () => stopTimer(true));

  syncThemeToPip();
  renderPip();
}

function syncThemeToPip() {
  if (!_pip || _pip.closed) return;
  const theme = THEME;
  const r = _pip.document.documentElement;
  r.style.setProperty('--bg',      theme.bg);
  r.style.setProperty('--surface', theme.surface);
  r.style.setProperty('--border',  theme.border);
  r.style.setProperty('--accent',  theme.accent);
  r.style.setProperty('--text',    theme.text);
  r.style.setProperty('--muted',   theme.muted);
  r.style.setProperty('--green',   theme.green);
}

function renderPip() {
  if (!_pip || _pip.closed) return;
  const doc = _pip.document;

  const pipClock = doc.getElementById('pip-clock');
  if (pipClock) {
    const main = document.getElementById('clock');
    pipClock.textContent = main.textContent;
    pipClock.className = 'pip-clock' + (main.classList.contains('overtime') ? ' overtime' : '');
  }

  const tagEl = doc.getElementById('pip-tag');
  if (tagEl) tagEl.textContent = state.timer.tagId ? tagPath(state.timer.tagId) : '';

  const { running, paused } = state.timer;
  const s = doc.getElementById('pip-start');
  const p = doc.getElementById('pip-pause');
  const x = doc.getElementById('pip-stop');
  if (s) { s.textContent = paused ? 'Resume' : 'Start'; s.disabled = running; }
  if (p) p.disabled = !running;
  if (x) x.disabled = !running && !paused;
}

// ─── EVENT LISTENERS ─────────────────────────────────────────────────────────

function setMode(mode) {
  if (state.timer.running || state.timer.paused) return;
  state.timer.mode = mode;
  document.getElementById('btn-mode-up').classList.toggle('active',   mode === 'up');
  document.getElementById('btn-mode-down').classList.toggle('active', mode === 'down');
  document.getElementById('countdown-input').classList.toggle('visible', mode === 'down');
  syncCountdownFromInputs();
  saveTimer();
  renderClock();
}

function syncCountdownFromInputs() {
  const h = parseInt(document.getElementById('cd-h').value) || 0;
  const m = parseInt(document.getElementById('cd-m').value) || 0;
  const s = parseInt(document.getElementById('cd-s').value) || 0;
  state.timer.countdownSecs = h * 3600 + m * 60 + s || 1;
}

document.getElementById('btn-mode-up').addEventListener('click',   () => setMode('up'));
document.getElementById('btn-mode-down').addEventListener('click', () => setMode('down'));

['cd-h','cd-m','cd-s'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => {
    syncCountdownFromInputs();
    saveTimer();
    renderClock();
  });
});

document.getElementById('btn-start').addEventListener('click', () => { startTimer(); openPip(); });
document.getElementById('btn-pause').addEventListener('click', pauseTimer);
document.getElementById('btn-stop').addEventListener('click', () => stopTimer(true));

document.getElementById('tag-select').addEventListener('change', e => {
  state.timer.tagId = parseInt(e.target.value) || null;
  saveTimer();
});

document.getElementById('btn-add-tag').addEventListener('click', () => {
  const name     = document.getElementById('tag-name').value;
  const parentId = parseInt(document.getElementById('tag-parent').value) || null;
  if (addTag(name, parentId)) {
    document.getElementById('tag-name').value = '';
    renderAll();
  }
});

document.getElementById('tag-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-add-tag').click();
});

document.getElementById('btn-sync-connect').addEventListener('click', connectSync);
document.getElementById('btn-sync-disconnect').addEventListener('click', disconnectSync);

document.getElementById('btn-stats').addEventListener('click', openStats);
document.getElementById('btn-close-stats').addEventListener('click', closeStats);
document.querySelectorAll('.view-btn').forEach(btn =>
  btn.addEventListener('click', () => setStatsView(btn.dataset.view)));
document.getElementById('stats-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeStats();
});

// ─── INIT ────────────────────────────────────────────────────────────────────

(async function init() {
  // Apply the dark theme
  applyTheme(THEME);

  // Load from Gist if already connected — it's the source of truth
  if (syncToken() && syncGistId()) {
    setSyncStatus('syncing');
    try {
      const data = await gistLoad();
      if (data) {
        state.tags          = data.tags          ?? state.tags;
        state.sessions      = data.sessions      ?? state.sessions;
        state.nextTagId     = data.nextTagId     ?? state.nextTagId;
        state.nextSessionId = data.nextSessionId ?? state.nextSessionId;
        save();
      }
      setSyncStatus('saved');
    } catch { setSyncStatus('error'); }
  }

  renderAll();
  renderSyncUI();

  // Restore mode UI
  const mode = state.timer.mode;
  document.getElementById('btn-mode-up').classList.toggle('active',   mode === 'up');
  document.getElementById('btn-mode-down').classList.toggle('active', mode === 'down');
  document.getElementById('countdown-input').classList.toggle('visible', mode === 'down');
  const total = state.timer.countdownSecs;
  document.getElementById('cd-h').value = Math.floor(total / 3600);
  document.getElementById('cd-m').value = Math.floor((total % 3600) / 60);
  document.getElementById('cd-s').value = total % 60;

  // Resume timer if it was running before reload or crash
  if (_savedTimer.startTime != null && !_savedTimer.paused) {
    const safeEnd = _savedTimer.lastHeartbeat ?? _savedTimer.startTime;
    const banked  = (_savedTimer.elapsed ?? 0) + Math.max(0, safeEnd - _savedTimer.startTime);
    state.timer.elapsed   = banked;
    state.timer.startTime = Date.now();
    state.timer.running   = true;
    state.timer.interval  = setInterval(tickClock, 100);
    saveTimer();
    renderTimerControls();
  }

  // Heartbeat every 5s
  setInterval(() => { if (state.timer.running) saveTimer(); }, 5000);
})();
