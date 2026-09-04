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
  _remoteReady = false;
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

let _gistTimer   = null;
let _writing     = false;
let _remoteReady = false;  // a read has succeeded — safe to publish local state
let _lastPull    = 0;
let _dirty       = false;  // local edits not yet accepted by the gist

function syncPayload() {
  return {
    tags:          state.tags,
    sessions:      state.sessions,
    deletedTagIds: state.deletedTagIds,
    nextTagId:     state.nextTagId,
    nextSessionId: state.nextSessionId,
  };
}

// Union two snapshots by record id.
//
// Sessions are only ever appended, and deleteTag refuses any tag that still has
// sessions or children, so a union can never drop a real record. Deleted tags
// are carried as tombstones in `deletedTagIds` so the union does not resurrect
// them. This replaces the old whole-file overwrite, where whichever device
// happened to save last silently erased everything the other one recorded.
function mergeSnapshots(remote, local) {
  if (!remote) return local;

  const byKey = (arr, key) => {
    const m = new Map();
    (arr || []).forEach(r => { if (r && r.id != null) m.set(key(r), r); });
    return m;
  };

  const tagKey = t => String(t.id);
  // Sessions also key on their timestamp. New ids are uuids, but sessions
  // written by the old code carry a per-device counter, so two devices could
  // each hold a different session numbered 7. Folding the date in keeps both
  // instead of silently dropping one — and records that really are the same
  // still collapse, since both devices got them from the same gist.
  const sessionKey = s => String(s.id) + '|' + (s.date || '');

  const tombstones = new Set(
    [...(remote.deletedTagIds || []), ...(local.deletedTagIds || [])].map(String)
  );

  const tags = byKey(remote.tags, tagKey);
  byKey(local.tags, tagKey).forEach((t, k) => tags.set(k, t));
  tombstones.forEach(id => tags.delete(id));

  const sessions = byKey(remote.sessions, sessionKey);
  byKey(local.sessions, sessionKey).forEach((s, k) => sessions.set(k, s));

  return {
    tags:          [...tags.values()],
    sessions:      [...sessions.values()],
    deletedTagIds: [...tombstones],
    nextTagId:     Math.max(remote.nextTagId     || 1, local.nextTagId     || 1),
    nextSessionId: Math.max(remote.nextSessionId || 1, local.nextSessionId || 1),
  };
}

function applySnapshot(data) {
  if (!data) return;
  state.tags          = data.tags          ?? state.tags;
  state.sessions      = data.sessions      ?? state.sessions;
  state.deletedTagIds = data.deletedTagIds ?? state.deletedTagIds;
  state.nextTagId     = data.nextTagId     ?? state.nextTagId;
  state.nextSessionId = data.nextSessionId ?? state.nextSessionId;
}

async function gistLoad() {
  const gist = await gistRequest('GET', '/' + syncGistId());
  const raw = gist.files[GIST_FILE]?.content;
  return raw ? JSON.parse(raw) : null;
}

// Pull the gist and fold it into local state. Opens the write gate: until a
// read has succeeded at least once this session, this device must not PATCH —
// otherwise one failed request at startup republishes stale local data as truth.
// Returns true when this device holds records the gist does not, i.e. we owe it
// a write — so an ordinary startup with nothing new costs one GET, not a GET
// plus a pointless PATCH.
async function pullRemote() {
  const remote = await gistLoad();
  const merged = mergeSnapshots(remote, syncPayload());
  const localAhead = !remote
    || merged.sessions.length      !== (remote.sessions      || []).length
    || merged.tags.length          !== (remote.tags          || []).length
    || merged.deletedTagIds.length !== (remote.deletedTagIds || []).length;

  applySnapshot(merged);
  _remoteReady = true;
  _lastPull = Date.now();
  saveLocal();
  return localAhead;
}

function scheduleGistWrite() {
  if (!syncToken()) return;
  _dirty = true;
  clearTimeout(_gistTimer);
  _gistTimer = setTimeout(gistWrite, 1500);
}

// Push now instead of waiting out the debounce — used when the tab is being
// hidden or torn down, where the remaining 1.5s may never arrive.
function flushGistWrite() {
  if (_dirty && _remoteReady) gistWrite();
}

async function gistWrite() {
  if (!syncToken() || !syncGistId()) return;
  clearTimeout(_gistTimer);
  if (!_remoteReady) { setSyncStatus('stale'); return; }
  if (_writing) { scheduleGistWrite(); return; }

  _writing = true;
  setSyncStatus('syncing');
  try {
    // Re-read immediately before writing: the PATCH replaces the whole file, so
    // anything another device added since our last pull has to be folded in here
    // or it would be lost.
    applySnapshot(mergeSnapshots(await gistLoad(), syncPayload()));
    await gistRequest('PATCH', '/' + syncGistId(), {
      files: { [GIST_FILE]: { content: JSON.stringify(syncPayload(), null, 2) } },
    });
    _lastPull = Date.now();
    _dirty = false;
    saveLocal();
    renderAll();
    setSyncStatus('saved');
  } catch {
    setSyncStatus('error');
  } finally {
    _writing = false;
  }
}

// Snapshot what is on disk before this session's first sync, so a bad merge or a
// bad remote can be rolled back by hand. Keeps the three most recent.
function backupLocal() {
  try {
    localStorage.setItem('backup:' + new Date().toISOString(), JSON.stringify(syncPayload()));
    const keys = Object.keys(localStorage).filter(k => k.startsWith('backup:')).sort();
    while (keys.length > 3) localStorage.removeItem(keys.shift());
  } catch { /* quota — a missing backup must not block sync */ }
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
      backupLocal();
      // Merge rather than replace: local data created before connecting must
      // survive linking this device to an existing gist.
      await pullRemote();
      renderAll();
      scheduleGistWrite();
    } else {
      const gist = await gistRequest('POST', '', {
        description: 'Timer App Data',
        public: false,
        files: { [GIST_FILE]: { content: JSON.stringify(syncPayload(), null, 2) } },
      });
      saveSyncCredentials(undefined, gist.id);
      _remoteReady = true;  // we authored the file, so it is ours to write
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

// Walk every revision of the gist and union back any session that has ever been
// recorded. Builds before the merge fix replaced the whole file on each write, so
// a device holding a stale copy could erase sessions logged on another machine —
// but every one of those overwrites is still in the gist's revision history.
async function restoreFromHistory() {
  if (!syncToken() || !syncGistId()) return;

  const btn = document.getElementById('btn-sync-restore');
  const out = document.getElementById('sync-restore-result');
  const show = msg => { out.hidden = false; out.textContent = msg; };
  const key = s => String(s.id) + '|' + (s.date || '');

  btn.disabled = true;
  btn.textContent = 'Scanning…';
  try {
    const commits = await gistRequest('GET', '/' + syncGistId() + '/commits?per_page=100');

    // Seed with what we already hold, so the diff reports genuine recoveries only.
    const sessions = new Map(state.sessions.map(s => [key(s), s]));
    const known    = new Set(sessions.keys());
    const tags     = new Map(state.tags.map(t => [String(t.id), t]));

    for (let i = 0; i < commits.length; i++) {
      show(`Scanning revision ${i + 1} of ${commits.length}…`);
      let data;
      try {
        const rev = await gistRequest('GET', '/' + syncGistId() + '/' + commits[i].version);
        const raw = rev.files?.[GIST_FILE]?.content;
        data = raw ? JSON.parse(raw) : null;
      } catch { continue; }  // one unreadable revision must not abort the scan
      if (!data) continue;
      (data.sessions || []).forEach(s => { if (s && s.id != null) sessions.set(key(s), s); });
      (data.tags     || []).forEach(t => { if (t && t.id != null) tags.set(String(t.id), t); });
    }

    const recovered = [...sessions.entries()].filter(([k]) => !known.has(k)).map(([, s]) => s);
    if (recovered.length === 0) {
      show(`Scanned ${commits.length} revision(s) — nothing was missing.`);
      return;
    }

    // Bring back only the tags those sessions point at. Tags deleted on purpose
    // hold nothing and should stay deleted.
    const needed = new Set(recovered.map(s => String(s.tagId)));
    const restoredTags = [...tags.values()].filter(t =>
      needed.has(String(t.id)) && !state.tags.some(x => String(x.id) === String(t.id))
    );

    const hours = recovered.reduce((a, s) => a + (s.duration || 0), 0) / 3600;
    const ok = confirm(
      `Found ${recovered.length} session(s) totalling ${hours.toFixed(1)} hours ` +
      `missing from your current data.\n\nRestore them?`
    );
    if (!ok) { show(`${recovered.length} recoverable session(s) found — not restored.`); return; }

    state.sessions = [...sessions.values()];
    state.tags     = [...state.tags, ...restoredTags];
    // A restored tag must not be stripped straight back out by the next merge.
    const back = new Set(restoredTags.map(t => String(t.id)));
    state.deletedTagIds = (state.deletedTagIds || []).filter(id => !back.has(String(id)));

    save();
    renderAll();
    show(`Restored ${recovered.length} session(s) — ${hours.toFixed(1)} hours.`);
  } catch (e) {
    show('Restore failed: ' + (e.name === 'AbortError' ? 'request timed out' : e.message));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Restore from history';
  }
}

function setSyncStatus(s) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  const map = {
    syncing: ['↻ Syncing…',   'syncing'],
    saved:   ['✓ Synced',     'saved'],
    error:   ['⚠ Sync error', 'error'],
    stale:   ['⚠ Not synced — offline', 'error'],
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
  deletedTagIds: load('deletedTagIds', []),
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

function saveLocal() {
  localStorage.setItem('tags',          JSON.stringify(state.tags));
  localStorage.setItem('sessions',      JSON.stringify(state.sessions));
  localStorage.setItem('deletedTagIds', JSON.stringify(state.deletedTagIds));
  localStorage.setItem('nextTagId',     state.nextTagId);
  localStorage.setItem('nextSessionId', state.nextSessionId);
}

function save() {
  saveLocal();
  scheduleGistWrite();
}

// Ids must be unique across devices, or two machines both minting "7" would
// collide the moment their records are merged. Existing numeric ids are left
// exactly as they are — they came from the shared gist, so both devices already
// agree on them, and rewriting them is a needless risk to old data.
function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// Ids are legacy numbers or new uuid strings, but DOM values and object keys are
// always strings — resolve one back to the value actually stored on the record.
function tagIdFromKey(raw) {
  if (raw == null || raw === '') return null;
  const t = state.tags.find(t => String(t.id) === String(raw));
  return t ? t.id : raw;
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
  state.tags.push({ id: newId(), name: name.trim(), parentId: parentId || null });
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
  state.deletedTagIds.push(String(id));  // tombstone, so a merge cannot resurrect it
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
      id:       newId(),
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
    const id = tagIdFromKey(tagId);
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
    const id = tagIdFromKey(tagId);
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

// GitHub-style per-tag yearly heatmap. Each cell is one day of the current
// calendar year, filled with the tag's colour at an opacity stepped by how
// many hours were logged that day: <2, 2-4, 4-6, 6-8, >8.
const GRID_OPACITY = [0, 0.2, 0.4, 0.6, 0.8, 1.0];

function gridLevel(hours) {
  if (hours <= 0) return 0;
  if (hours < 2) return 1;
  if (hours < 4) return 2;
  if (hours < 6) return 3;
  if (hours < 8) return 4;
  return 5;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function dayKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function drawTagGrids() {
  const container = document.getElementById('tag-grids');
  if (!container) return;
  container.innerHTML = '';

  const colorMap = tagColorMap();
  const year = new Date().getFullYear();

  // tagId → { dayKey: seconds } and tagId → total, for this year only
  const perTag = {};
  const totals = {};
  state.sessions.forEach(s => {
    const d = new Date(s.date);
    if (d.getFullYear() !== year) return;
    const key = dayKey(d);
    const days = perTag[s.tagId] || (perTag[s.tagId] = {});
    days[key] = (days[key] || 0) + s.duration;
    totals[s.tagId] = (totals[s.tagId] || 0) + s.duration;
  });

  const tagIds = Object.keys(totals).sort((a, b) => totals[b] - totals[a]); // same order as colours
  if (tagIds.length === 0) {
    container.innerHTML = '<div class="no-history">No sessions this year.</div>';
    return;
  }

  const jan1 = new Date(year, 0, 1);
  const dec31 = new Date(year, 11, 31);
  const offset = jan1.getDay(); // leading blanks so Jan 1 lands on its weekday row (Sun=0)

  tagIds.forEach(id => {
    const color = colorMap[id];
    const [r, g, b] = hexToRgb(color);
    const tid  = tagIdFromKey(id);
    const path = getTag(tid) ? tagPath(tid) : `[deleted #${id}]`;
    const days = perTag[id] || {};

    const block = document.createElement('div');
    block.className = 'tag-grid-block';

    const head = document.createElement('div');
    head.className = 'tag-grid-head';
    head.innerHTML = `<span class="legend-dot" style="background:${color}"></span>` +
      `<span class="tag-grid-label">${escHtml(path)}</span>`;
    block.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'tag-grid';

    for (let i = 0; i < offset; i++) {
      const c = document.createElement('div');
      c.className = 'grid-cell empty';
      grid.appendChild(c);
    }

    for (const cur = new Date(jan1); cur <= dec31; cur.setDate(cur.getDate() + 1)) {
      const secs = days[dayKey(cur)] || 0;
      const level = gridLevel(secs / 3600);
      const c = document.createElement('div');
      c.className = 'grid-cell';
      if (level > 0) c.style.background = `rgba(${r},${g},${b},${GRID_OPACITY[level]})`;
      const label = cur.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      c.title = `${label}: ${secs > 0 ? fmt(secs) : '0:00:00'}`;
      grid.appendChild(c);
    }

    block.appendChild(grid);
    container.appendChild(block);
  });
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
  drawTagGrids();
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
  state.timer.tagId = tagIdFromKey(e.target.value);
  saveTimer();
});

document.getElementById('btn-add-tag').addEventListener('click', () => {
  const name     = document.getElementById('tag-name').value;
  const parentId = tagIdFromKey(document.getElementById('tag-parent').value);
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
document.getElementById('btn-sync-restore').addEventListener('click', restoreFromHistory);

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

  // Merge the Gist into local state — not "the Gist wins". Anything recorded on
  // this device while it was offline has to survive, so both sides are unioned.
  if (syncToken() && syncGistId()) {
    setSyncStatus('syncing');
    try {
      backupLocal();
      if (await pullRemote()) scheduleGistWrite();  // publish offline work
      setSyncStatus('saved');
    } catch {
      // The write gate stays shut. Local data is intact on disk and will be
      // merged up on the next successful pull; publishing it now would overwrite
      // newer data from another device with this device's stale copy.
      setSyncStatus('stale');
    }
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

  // A tab left open for days would otherwise keep serving state from the day it
  // was opened, then publish that over newer work from another device. Re-pull
  // whenever it comes back to the foreground, and flush pending writes when it
  // goes away rather than betting on the 1.5s debounce completing.
  document.addEventListener('visibilitychange', () => {
    if (!syncToken() || !syncGistId()) return;
    if (document.visibilityState !== 'visible') { flushGistWrite(); return; }
    if (Date.now() - _lastPull < 30000) return;
    setSyncStatus('syncing');
    pullRemote()
      .then(ahead => {
        renderAll();
        setSyncStatus('saved');
        if (ahead) scheduleGistWrite(); else flushGistWrite();
      })
      .catch(() => setSyncStatus('stale'));
  });

  window.addEventListener('pagehide', flushGistWrite);
})();
