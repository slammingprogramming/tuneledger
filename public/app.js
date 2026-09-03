'use strict';

// ---------------------------------------------------------------------------
// Tiny fetch wrapper + toast
// ---------------------------------------------------------------------------

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = j.error || msg;
    } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

let toastTimer = null;
function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.borderColor = isError ? 'var(--red)' : 'var(--accent)';
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STATUS_LABELS = {
  not_started: 'Not started',
  in_progress: 'In progress',
  downloaded: 'Downloaded',
  skipped: 'Skipped',
  problem: 'Problem',
};

function statusOptionsHtml(current) {
  return Object.entries(STATUS_LABELS)
    .map(([v, l]) => `<option value="${v}" ${v === current ? 'selected' : ''}>${l}</option>`)
    .join('');
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'review') loadReview();
    if (btn.dataset.tab === 'history') loadHistory();
    if (btn.dataset.tab === 'library') loadScanHistory();
  });
});

// ---------------------------------------------------------------------------
// Stats bar
// ---------------------------------------------------------------------------

async function refreshStats() {
  const s = await api('GET', '/stats');
  document.getElementById('statsBar').innerHTML = `
    Artists: <b>${s.artists.toLocaleString()}</b>
    Albums: <b>${s.albums.toLocaleString()}</b>
    Unique tracks: <b>${s.uniqueTracks.toLocaleString()}</b>
    &middot; Downloaded: <b>${s.downloaded.toLocaleString()}</b>
    Remaining: <b>${s.remaining.toLocaleString()}</b>
    &middot; Progress: <span class="progress-pct">${s.progressPct}%</span>
    ${s.ignored ? `&middot; Ignored: <b>${s.ignored}</b>` : ''}
    ${s.pendingReview ? `&middot; <span style="color:var(--yellow)">Pending review: <b>${s.pendingReview}</b></span>` : ''}
  `;
  const badge = document.getElementById('reviewBadge');
  badge.textContent = s.pendingReview ? s.pendingReview : '';
  badge.style.display = s.pendingReview ? 'inline-block' : 'none';
  return s;
}

// ---------------------------------------------------------------------------
// Queue tab: Artist -> Album -> Track tree, lazily loaded
// ---------------------------------------------------------------------------

const artistsState = new Map(); // id -> artist summary
const albumsState = new Map(); // artistId -> [album summaries]
let artistOffset = 0;
const ARTIST_PAGE_SIZE = 100;

async function loadArtists(reset) {
  if (reset) {
    artistOffset = 0;
    document.getElementById('artistList').innerHTML = '';
    artistsState.clear();
  }
  const q = document.getElementById('artistFilterQ').value.trim();
  const status = document.getElementById('artistFilterStatus').value;
  const data = await api(
    'GET',
    `/artists?limit=${ARTIST_PAGE_SIZE}&offset=${artistOffset}${q ? '&q=' + encodeURIComponent(q) : ''}${status ? '&status=' + status : ''}`
  );
  artistOffset += data.artists.length;
  const list = document.getElementById('artistList');
  for (const a of data.artists) {
    artistsState.set(a.id, a);
    list.insertAdjacentHTML('beforeend', renderArtistRow(a));
  }
  document.getElementById('artistLoadMore').style.display = artistOffset >= data.total ? 'none' : '';
}

function renderArtistRow(a) {
  return `
  <div class="artist-row" data-artist-id="${a.id}">
    <div class="artist-header" data-action="toggle-artist">
      <span class="chevron">&#9656;</span>
      <span class="artist-name">${esc(a.name)}</span>
      <span class="artist-progress" data-role="artist-progress">${a.downloadedCount} / ${a.trackCount} tracks &middot; ${a.albumCount} album${a.albumCount === 1 ? '' : 's'} &middot; ${a.progressPct}%</span>
    </div>
    <div class="album-list" data-role="album-list"></div>
  </div>`;
}

function updateArtistHeaderDom(artistId) {
  const a = artistsState.get(artistId);
  if (!a) return;
  const row = document.querySelector(`.artist-row[data-artist-id="${artistId}"] [data-role="artist-progress"]`);
  if (row) {
    a.progressPct = a.trackCount ? Math.round((a.downloadedCount / a.trackCount) * 1000) / 10 : 0;
    row.textContent = `${a.downloadedCount} / ${a.trackCount} tracks · ${a.albumCount} album${a.albumCount === 1 ? '' : 's'} · ${a.progressPct}%`;
  }
}

function updateAlbumHeaderDom(albumId, artistId) {
  const albums = albumsState.get(artistId) || [];
  const al = albums.find((x) => x.id === albumId);
  if (!al) return;
  al.progressPct = al.trackCount ? Math.round((al.downloadedCount / al.trackCount) * 1000) / 10 : 0;
  const el = document.querySelector(`.album-block[data-album-id="${albumId}"] [data-role="album-progress"]`);
  if (el) el.textContent = `${al.downloadedCount} / ${al.trackCount}`;
}

async function toggleArtist(artistRow) {
  const artistId = Number(artistRow.dataset.artistId);
  artistRow.classList.toggle('expanded');
  if (!artistRow.classList.contains('expanded')) return;
  const albumListEl = artistRow.querySelector('[data-role="album-list"]');
  if (albumListEl.dataset.loaded) return;
  albumListEl.dataset.loaded = '1';
  const albums = await api('GET', `/artists/${artistId}/albums`);
  albumsState.set(artistId, albums);
  albumListEl.innerHTML = albums.map((al) => renderAlbumBlock(al)).join('');
}

function renderAlbumBlock(al) {
  return `
  <div class="album-block" data-album-id="${al.id}">
    <div class="album-header" data-action="toggle-album">
      <span class="chevron">&#9656;</span>
      <span class="album-name">${esc(al.name)}</span>
      <span class="album-meta">${al.release_date ? esc(al.release_date.slice(0, 4)) : ''} ${al.release_category !== 'album' ? '· ' + al.release_category : ''}</span>
      <span class="album-progress" data-role="album-progress">${al.downloadedCount} / ${al.trackCount}</span>
    </div>
    <div class="track-list" data-role="track-list"></div>
  </div>`;
}

async function toggleAlbum(albumBlock, artistId) {
  const albumId = Number(albumBlock.dataset.albumId);
  albumBlock.classList.toggle('expanded');
  if (!albumBlock.classList.contains('expanded')) return;
  await reloadAlbumTracks(albumBlock, albumId, artistId);
}

async function reloadAlbumTracks(albumBlock, albumId, artistId) {
  const trackListEl = albumBlock.querySelector('[data-role="track-list"]');
  const tracks = await api('GET', `/albums/${albumId}/tracks`);
  trackListEl.innerHTML = tracks.map((t) => renderTrackRow(t, { artistId, albumId, showTrackNum: true })).join('');
}

function versionBadge(v) {
  return v && v !== 'original' ? `<span class="track-version">[${v.replace('_', ' ')}]</span>` : '';
}

function renderTrackRow(t, ctx) {
  const num = ctx.showTrackNum ? `<span class="track-num">${t.track_number != null ? String(t.track_number).padStart(2, '0') : '--'}</span>` : '';
  return `
  <div class="track-row ${t.ignored ? 'ignored' : ''}" data-track-row data-track-id="${t.id}" data-status="${t.status}"
       ${ctx.artistId != null ? `data-artist-id="${ctx.artistId}"` : ''} ${ctx.albumId != null ? `data-album-id="${ctx.albumId}"` : ''}>
    <input type="checkbox" data-action="toggle-check" ${t.status === 'downloaded' ? 'checked' : ''} title="Toggle downloaded" />
    ${num}
    <span class="track-title" data-action="edit-title" title="Click to rename" data-id="${t.id}">${esc(t.title)}</span>
    ${versionBadge(t.version_type)}
    ${t.sourceCount > 1 ? `<span class="track-dup" data-action="toggle-dup">×${t.sourceCount}</span>` : ''}
    <select class="status-select" data-action="set-status">${statusOptionsHtml(t.status)}</select>
    <span class="track-actions">
      <button class="small" data-action="edit-more" title="Edit artist/album/track#/disc#">✎</button>
      <button class="small" data-action="toggle-ignore" title="${t.ignored ? 'Restore' : 'Ignore'}">${t.ignored ? '↺' : '⊘'}</button>
    </span>
  </div>
  <div class="dup-panel" data-role="dup-panel" style="display:none"></div>`;
}

document.getElementById('artistList').addEventListener('click', (e) => {
  const header = e.target.closest('[data-action="toggle-artist"]');
  if (header) {
    toggleArtist(header.closest('.artist-row'));
    return;
  }
  const albumHeader = e.target.closest('[data-action="toggle-album"]');
  if (albumHeader) {
    const artistId = Number(albumHeader.closest('.artist-row').dataset.artistId);
    toggleAlbum(albumHeader.closest('.album-block'), artistId);
    return;
  }
  handleTrackRowClick(e);
});

document.getElementById('artistFilterGo').addEventListener('click', () => loadArtists(true));
document.getElementById('artistFilterQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadArtists(true); });
document.getElementById('artistLoadMore').addEventListener('click', () => loadArtists(false));

// ---------------------------------------------------------------------------
// Shared track-row interaction handling (used by Queue tree + Search table)
// ---------------------------------------------------------------------------

async function handleTrackRowClick(e) {
  const row = e.target.closest('[data-track-row]');
  if (!row) return;
  const trackId = Number(row.dataset.trackId);
  const artistId = row.dataset.artistId ? Number(row.dataset.artistId) : null;
  const albumId = row.dataset.albumId ? Number(row.dataset.albumId) : null;

  if (e.target.matches('[data-action="toggle-check"]')) {
    const checked = e.target.checked;
    await applyStatusChange(row, trackId, artistId, albumId, checked ? 'downloaded' : 'not_started');
    return;
  }
  if (e.target.matches('[data-action="toggle-dup"]')) {
    await toggleDupPanel(row, trackId, artistId, albumId);
    return;
  }
  if (e.target.matches('[data-action="edit-title"]')) {
    startInlineTitleEdit(e.target, trackId, row);
    return;
  }
  if (e.target.matches('[data-action="edit-more"]')) {
    await editMore(trackId, row, artistId, albumId);
    return;
  }
  if (e.target.matches('[data-action="toggle-ignore"]')) {
    const ignored = row.classList.contains('ignored');
    await api('POST', `/tracks/${trackId}/${ignored ? 'unignore' : 'ignore'}`);
    row.classList.toggle('ignored');
    e.target.textContent = ignored ? '⊘' : '↺';
    toast(ignored ? 'Restored' : 'Ignored');
    refreshStats();
    return;
  }
}

document.getElementById('artistList').addEventListener('change', (e) => {
  const row = e.target.closest('[data-track-row]');
  if (!row) return;
  if (e.target.matches('[data-action="set-status"]')) {
    const trackId = Number(row.dataset.trackId);
    const artistId = row.dataset.artistId ? Number(row.dataset.artistId) : null;
    const albumId = row.dataset.albumId ? Number(row.dataset.albumId) : null;
    applyStatusChange(row, trackId, artistId, albumId, e.target.value);
  }
});

async function applyStatusChange(row, trackId, artistId, albumId, newStatus) {
  const oldStatus = row.dataset.status;
  if (oldStatus === newStatus) return;
  try {
    await api('POST', `/tracks/${trackId}/status`, { status: newStatus });
  } catch (err) {
    toast('Failed: ' + err.message, true);
    return;
  }
  row.dataset.status = newStatus;
  row.querySelector('[data-action="toggle-check"]').checked = newStatus === 'downloaded';
  const sel = row.querySelector('[data-action="set-status"]');
  if (sel) sel.value = newStatus;

  const delta = (newStatus === 'downloaded' ? 1 : 0) - (oldStatus === 'downloaded' ? 1 : 0);
  if (delta !== 0 && artistId != null) {
    const a = artistsState.get(artistId);
    if (a) { a.downloadedCount += delta; updateArtistHeaderDom(artistId); }
    if (albumId != null) {
      const al = (albumsState.get(artistId) || []).find((x) => x.id === albumId);
      if (al) { al.downloadedCount += delta; }
      updateAlbumHeaderDom(albumId, artistId);
    }
  }
  refreshStats();
}

function findDupPanel(row) {
  const sib = row.nextElementSibling;
  if (!sib) return null;
  if (sib.matches('[data-role="dup-panel"]')) return sib;
  return sib.querySelector('[data-role="dup-panel"]');
}

async function toggleDupPanel(row, trackId, artistId, albumId) {
  const panel = findDupPanel(row);
  if (!panel) return;
  if (panel.style.display !== 'none') {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  panel.innerHTML = 'Loading…';
  const detail = await api('GET', `/tracks/${trackId}`);
  panel.innerHTML = detail.sources
    .map(
      (s) => `
    <div class="dup-source">
      <span>${s.is_primary ? '★' : '&nbsp;&nbsp;'}</span>
      <span class="src-album">${esc(s.album_raw || '(no album)')} ${s.release_date ? '· ' + esc(s.release_date) : ''} ${s.release_category !== 'album' ? '· ' + s.release_category : ''}</span>
      ${!s.is_primary ? `<button class="small" data-pref="${s.normalized_entry_id}">Make preferred</button>` : ''}
      ${detail.sources.length > 1 ? `<button class="small" data-split="${s.normalized_entry_id}">Split out</button>` : ''}
    </div>`
    )
    .join('');
  panel.querySelectorAll('[data-pref]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api('POST', `/tracks/${trackId}/set-preferred`, { normalizedEntryId: Number(btn.dataset.pref) });
      toast('Preferred source updated');
      if (albumId != null) await reloadAlbumTracks(row.closest('.album-block'), albumId, artistId);
      else document.dispatchEvent(new Event('search:refresh'));
    })
  );
  panel.querySelectorAll('[data-split]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        await api('POST', `/tracks/${trackId}/split`, { normalizedEntryId: Number(btn.dataset.split) });
        toast('Split into a new track');
        if (albumId != null) await reloadAlbumTracks(row.closest('.album-block'), albumId, artistId);
        else document.dispatchEvent(new Event('search:refresh'));
        refreshStats();
      } catch (err) {
        toast('Failed: ' + err.message, true);
      }
    })
  );
}

function startInlineTitleEdit(span, trackId, row) {
  const original = span.textContent;
  span.contentEditable = 'true';
  span.focus();
  document.execCommand && window.getSelection().selectAllChildren(span);
  function done(save) {
    span.contentEditable = 'false';
    span.removeEventListener('keydown', onKey);
    span.removeEventListener('blur', onBlur);
    if (save) {
      const newTitle = span.textContent.trim();
      if (newTitle && newTitle !== original) {
        api('PATCH', `/tracks/${trackId}`, { title: newTitle })
          .then(() => toast('Title updated'))
          .catch((err) => { span.textContent = original; toast('Failed: ' + err.message, true); });
      } else {
        span.textContent = original;
      }
    } else {
      span.textContent = original;
    }
  }
  function onKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); done(true); }
    if (e.key === 'Escape') { e.preventDefault(); done(false); }
  }
  function onBlur() { done(true); }
  span.addEventListener('keydown', onKey);
  span.addEventListener('blur', onBlur);
}

async function editMore(trackId, row, artistId, albumId) {
  const artistName = prompt('Artist (leave blank to keep unchanged):', '');
  const albumName = prompt('Album (leave blank to keep unchanged):', '');
  const trackNumber = prompt('Track number (blank = unchanged, "none" = clear):', '');
  const discNumber = prompt('Disc number (blank = unchanged, "none" = clear):', '');
  const body = {};
  if (artistName) body.artistName = artistName;
  if (albumName) body.albumName = albumName;
  if (trackNumber) body.track_number = trackNumber === 'none' ? null : Number(trackNumber);
  if (discNumber) body.disc_number = discNumber === 'none' ? null : Number(discNumber);
  if (!Object.keys(body).length) return;
  try {
    await api('PATCH', `/tracks/${trackId}`, body);
    toast('Track updated');
    if (albumId != null) {
      await reloadAlbumTracks(row.closest('.album-block'), albumId, artistId);
      const albums = await api('GET', `/artists/${artistId}/albums`);
      albumsState.set(artistId, albums);
    } else {
      document.dispatchEvent(new Event('search:refresh'));
    }
  } catch (err) {
    toast('Failed: ' + err.message, true);
  }
}

// ---------------------------------------------------------------------------
// Search tab
// ---------------------------------------------------------------------------

let searchOffset = 0;
const SEARCH_PAGE_SIZE = 100;

function searchParams() {
  const p = new URLSearchParams();
  const q = document.getElementById('searchQ').value.trim();
  const artist = document.getElementById('searchArtist').value.trim();
  const album = document.getElementById('searchAlbum').value.trim();
  const status = document.getElementById('searchStatus').value;
  const versionType = document.getElementById('searchVersion').value;
  const duplicatesOnly = document.getElementById('searchDuplicatesOnly').checked;
  const missingMeta = document.getElementById('searchMissingMeta').checked;
  const ignored = document.getElementById('searchIgnored').value;
  if (q) p.set('q', q);
  if (artist) p.set('artist', artist);
  if (album) p.set('album', album);
  if (status) p.set('status', status);
  if (versionType) p.set('versionType', versionType);
  if (duplicatesOnly) p.set('duplicatesOnly', 'true');
  if (missingMeta) p.set('missingMetadata', 'true');
  p.set('ignored', ignored);
  p.set('limit', SEARCH_PAGE_SIZE);
  p.set('offset', searchOffset);
  return p;
}

async function runSearch(reset) {
  if (reset) searchOffset = 0;
  const data = await api('GET', `/tracks?${searchParams().toString()}`);
  const tbody = document.getElementById('searchResults');
  tbody.innerHTML = data.tracks
    .map(
      (t) => `
    <tr data-track-row data-track-id="${t.id}" data-status="${t.status}" class="${t.ignored ? 'ignored' : ''}">
      <td><input type="checkbox" data-action="toggle-check" ${t.status === 'downloaded' ? 'checked' : ''} /></td>
      <td>${esc(t.artist_name)}</td>
      <td>${esc(t.album_name)}</td>
      <td>${t.track_number != null ? t.track_number : ''}</td>
      <td><span data-action="edit-title" data-id="${t.id}">${esc(t.title)}</span> ${versionBadge(t.version_type)}</td>
      <td>${t.version_type}</td>
      <td>${t.sourceCount > 1 ? `<span class="track-dup" data-action="toggle-dup">×${t.sourceCount}</span>` : ''}</td>
      <td><select class="status-select" data-action="set-status">${statusOptionsHtml(t.status)}</select></td>
      <td><button class="small" data-action="toggle-ignore">${t.ignored ? '↺' : '⊘'}</button></td>
    </tr>
    <tr><td colspan="9"><div class="dup-panel" data-role="dup-panel" style="display:none"></div></td></tr>
  `
    )
    .join('');
  const page = Math.floor(searchOffset / SEARCH_PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(data.total / SEARCH_PAGE_SIZE));
  document.getElementById('searchPageInfo').textContent = `Page ${page} / ${pages} (${data.total} results)`;
}

document.getElementById('searchGo').addEventListener('click', () => runSearch(true));
document.getElementById('searchResults').addEventListener('click', handleTrackRowClick);
document.getElementById('searchResults').addEventListener('change', (e) => {
  const row = e.target.closest('[data-track-row]');
  if (!row || !e.target.matches('[data-action="set-status"]')) return;
  applyStatusChange(row, Number(row.dataset.trackId), null, null, e.target.value);
});
document.getElementById('searchPrev').addEventListener('click', () => {
  searchOffset = Math.max(0, searchOffset - SEARCH_PAGE_SIZE);
  runSearch(false);
});
document.getElementById('searchNext').addEventListener('click', () => {
  searchOffset += SEARCH_PAGE_SIZE;
  runSearch(false);
});
document.addEventListener('search:refresh', () => runSearch(false));

// ---------------------------------------------------------------------------
// Review tab (fuzzy possible-duplicates)
// ---------------------------------------------------------------------------

async function loadReview() {
  const rows = await api('GET', '/possible-duplicates?status=pending');
  const el = document.getElementById('reviewList');
  if (!rows.length) {
    el.innerHTML = '<p class="hint">Nothing pending review.</p>';
    return;
  }
  el.innerHTML = rows
    .map(
      (r) => `
    <div class="review-card" data-pd-id="${r.id}">
      <div class="review-pair">
        <div>${esc(r.artist_a)} — ${esc(r.title_a)}</div>
        <div>${esc(r.artist_b)} — ${esc(r.title_b)}</div>
      </div>
      <div class="review-reason">${esc(r.reason)} (score ${r.score.toFixed(2)})</div>
      <div class="review-actions">
        <button class="primary small" data-act="confirm">Confirm duplicate (merge)</button>
        <button class="small" data-act="reject">Not a duplicate</button>
      </div>
    </div>`
    )
    .join('');
  el.querySelectorAll('.review-card').forEach((card) => {
    const id = card.dataset.pdId;
    card.querySelector('[data-act="confirm"]').addEventListener('click', async () => {
      await api('POST', `/possible-duplicates/${id}/confirm`);
      toast('Merged');
      card.remove();
      refreshStats();
    });
    card.querySelector('[data-act="reject"]').addEventListener('click', async () => {
      await api('POST', `/possible-duplicates/${id}/reject`);
      toast('Kept separate');
      card.remove();
      refreshStats();
    });
  });
}

// ---------------------------------------------------------------------------
// Import tab
// ---------------------------------------------------------------------------

document.getElementById('importForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = document.getElementById('importFile').files[0];
  if (!file) return;
  const label = document.getElementById('importLabel').value;
  const fd = new FormData();
  fd.append('file', file);
  if (label) fd.append('label', label);
  const resultEl = document.getElementById('importResult');
  resultEl.innerHTML = 'Importing…';
  try {
    const res = await fetch('/api/imports', { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const data = await res.json();
    renderImportResult(data);
    refreshStats();
    loadArtists(true);
  } catch (err) {
    resultEl.innerHTML = `<p style="color:var(--red)">Import failed: ${esc(err.message)}</p>`;
  }
});

function renderImportResult(data) {
  const { import: imp, dedupe } = data;
  const resultEl = document.getElementById('importResult');
  resultEl.innerHTML = `
    <div class="import-summary">
      <h3>Import complete: ${esc(imp.filename)}</h3>
      <p>${imp.rowCount} rows read &middot; ${imp.okCount} clean &middot; ${imp.warningCount} with warnings (${imp.skippedNoTitle} skipped for missing title, still preserved in raw data)</p>
      <p>Dedup: ${dedupe.processed} entries processed &middot; ${dedupe.newCanonical} new tracks &middot;
         ${dedupe.mergedExact + dedupe.mergedMeta + dedupe.mergedTitle + dedupe.mergedFuzzy} matched to existing tracks &middot;
         ${dedupe.flaggedForReview} flagged for review</p>
      ${imp.warnings.length ? `<h4>Warnings</h4>` + imp.warnings.slice(0, 50).map((w) => `<div class="warning-row">Row ${w.rowNumber}: ${esc(w.message)} ${w.artistRaw ? '(' + esc(w.artistRaw) + ' — ' + esc(w.albumRaw) + ')' : ''}</div>`).join('') : ''}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// History tab
// ---------------------------------------------------------------------------

async function loadHistory() {
  const imports = await api('GET', '/imports');
  const el = document.getElementById('historyList');
  el.innerHTML = imports
    .map(
      (imp) => `
    <div class="history-card">
      <div><b>#${imp.id}</b> ${esc(imp.filename)} ${imp.label ? '(' + esc(imp.label) + ')' : ''} — ${esc(imp.imported_at)}</div>
      <div>${imp.row_count} rows &middot; ${imp.ok_count} ok &middot; ${imp.error_count} warnings</div>
    </div>`
    )
    .join('');
}

// ---------------------------------------------------------------------------
// Local Library (directory scan + WPL import)
// ---------------------------------------------------------------------------

let scanPollTimer = null;

function stopScanPolling() {
  if (scanPollTimer) clearInterval(scanPollTimer);
  scanPollTimer = null;
}

function renderScanJob(job) {
  const pct = job.total_files ? Math.round((job.processed_files / job.total_files) * 100) : 0;
  const running = job.status === 'running';
  const moves = job.fileMoves || [];
  const pendingMoves = moves.filter((m) => !m.applied);

  return `
  <div class="scan-card" data-job-id="${job.id}">
    <div><b>#${job.id}</b> ${job.source_type === 'wpl' ? 'WPL import' : 'Directory scan'} &middot;
      <span class="status-${job.status === 'completed' ? 'downloaded' : job.status === 'failed' ? 'problem' : 'in_progress'}">${job.status}</span>
      ${job.dry_run ? '<span class="hint">(staged only - nothing moved yet)</span>' : ''}
    </div>
    <div class="hint">${esc(job.root_path)} &middot; matches will ${job.mark_downloaded ? 'be marked downloaded' : 'stay queued (linked as a source only)'}</div>
    ${
      running
        ? `<div class="scan-progress-bar"><div class="scan-progress-fill" style="width:${pct}%"></div></div>
           <div class="scan-current-file">${job.processed_files} / ${job.total_files || '?'} ${job.current_file ? '— ' + esc(job.current_file) : ''}</div>
           <button class="small danger" data-action="cancel-scan">Cancel</button>`
        : `<div class="scan-summary">Identified: ${job.identified_count} &middot; Needs review: ${job.review_count} &middot; Skipped: ${job.skipped_count}</div>`
    }
    ${job.error ? `<div class="scan-note">${esc(job.error)}</div>` : ''}
    ${
      pendingMoves.length
        ? `<button class="primary small" data-action="apply-moves">Apply ${pendingMoves.length} pending move${pendingMoves.length === 1 ? '' : 's'} now</button>`
        : ''
    }
    ${
      moves.length
        ? `<div class="move-list">${moves
            .map(
              (m) => `
          <div class="move-row">
            ${m.applied ? '<span class="move-applied">✓ moved</span>' : '<span class="hint">pending</span>'}
            ${esc(m.original_path)}<br/>
            <span class="move-reason">${esc(m.reason)}</span>
          </div>`
            )
            .join('')}</div>`
        : ''
    }
  </div>`;
}

async function pollScanJob(jobId) {
  stopScanPolling();
  const render = async () => {
    const job = await api('GET', `/library-scan/${jobId}`);
    document.getElementById('scanProgress').innerHTML = renderScanJob(job);
    wireScanCardActions(jobId);
    if (job.status !== 'running') {
      stopScanPolling();
      refreshStats();
      loadArtists(true);
      loadScanHistory();
    }
  };
  await render();
  scanPollTimer = setInterval(render, 1200);
}

function wireScanCardActions(jobId) {
  const card = document.querySelector(`.scan-card[data-job-id="${jobId}"]`);
  if (!card) return;
  const cancelBtn = card.querySelector('[data-action="cancel-scan"]');
  if (cancelBtn) cancelBtn.addEventListener('click', async () => {
    await api('POST', `/library-scan/${jobId}/cancel`);
    toast('Cancelling…');
  });
  const applyBtn = card.querySelector('[data-action="apply-moves"]');
  if (applyBtn) applyBtn.addEventListener('click', async () => {
    applyBtn.disabled = true;
    const res = await api('POST', `/library-scan/${jobId}/apply-moves`);
    toast(`Moved ${res.applied} file(s)${res.failed ? `, ${res.failed} failed` : ''}`);
    pollScanJob(jobId);
  });
}

document.getElementById('scanForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const rootPath = document.getElementById('scanRootPath').value.trim();
  const reviewFolder = document.getElementById('scanReviewFolder').value.trim();
  const useMusicBrainz = document.getElementById('scanUseMb').checked;
  const dryRun = !document.getElementById('scanMoveNow').checked;
  const markDownloaded = document.getElementById('scanMarkDownloaded').value === 'true';
  try {
    const { scanJobId } = await api('POST', '/library-scan', {
      rootPath,
      reviewFolder: reviewFolder || undefined,
      useMusicBrainz,
      dryRun,
      markDownloaded,
    });
    toast('Scan started');
    pollScanJob(scanJobId);
  } catch (err) {
    toast('Failed: ' + err.message, true);
  }
});

document.getElementById('wplForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const wplPath = document.getElementById('wplPath').value.trim();
  const useMusicBrainz = document.getElementById('wplUseMb').checked;
  const dryRun = !document.getElementById('wplMoveNow').checked;
  const markDownloaded = document.getElementById('wplMarkDownloaded').value === 'true';
  try {
    const { scanJobId } = await api('POST', '/wpl-import', { wplPath, useMusicBrainz, dryRun, markDownloaded });
    toast('WPL import started');
    pollScanJob(scanJobId);
  } catch (err) {
    toast('Failed: ' + err.message, true);
  }
});

async function loadScanHistory() {
  const jobs = await api('GET', '/library-scan');
  const el = document.getElementById('scanHistory');
  if (!jobs.length) {
    el.innerHTML = '<p class="hint">No scans yet.</p>';
    return;
  }
  el.innerHTML = jobs
    .map(
      (j) => `
    <div class="history-card" data-action="view-job" data-job-id="${j.id}" style="cursor:pointer">
      <div><b>#${j.id}</b> ${j.source_type === 'wpl' ? 'WPL' : 'Scan'} &middot; ${esc(j.root_path)} &middot;
        <span class="status-${j.status === 'completed' ? 'downloaded' : j.status === 'failed' ? 'problem' : 'in_progress'}">${j.status}</span>
      </div>
      <div>Identified: ${j.identified_count} &middot; Review: ${j.review_count} &middot; ${esc(j.started_at)}</div>
    </div>`
    )
    .join('');
  el.querySelectorAll('[data-action="view-job"]').forEach((card) =>
    card.addEventListener('click', () => pollScanJob(card.dataset.jobId))
  );
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

refreshStats();
loadArtists(true);
