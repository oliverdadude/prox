/* Internet radio stations for radios that only take direct stream links
 * (.mp3 / .pls / .m3u), like GMod car radios.
 * Uses the free, open Radio Browser directory: https://www.radio-browser.info
 */
(() => {
  'use strict';
  const { toast, copyText, api, esc, isLoggedIn, nowPlayingTrack, radioLink } = window.GRL;
  const $ = (sel) => document.querySelector(sel);

  const store = {
    get(k, d) { try { const v = localStorage.getItem(`grl.st.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(`grl.st.${k}`, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  // ---------- Radio Browser API (several mirrors; use whichever answers) ----------
  const MIRRORS = ['de1', 'de2', 'nl1', 'at1', 'fi1'].map((h) => `https://${h}.api.radio-browser.info`);
  let mirror = store.get('mirror', null);

  async function rb(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const order = mirror ? [mirror, ...MIRRORS.filter((m) => m !== mirror)] : [...MIRRORS].sort(() => Math.random() - 0.5);
    let lastErr;
    for (const base of order) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 7000);
        const res = await fetch(`${base}${path}${qs ? `?${qs}` : ''}`, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (mirror !== base) { mirror = base; store.set('mirror', base); }
        return data;
      } catch (e) { lastErr = e; }
    }
    throw new Error(`Couldn't reach the station directory (${lastErr?.message || 'offline'}). Try again in a moment.`);
  }

  // GMod's built-in player handles MP3 (and OGG) streams; skip HLS and other codecs.
  const BASE_FILTER = { codec: 'MP3', hidebroken: 'true', order: 'clickcount', reverse: 'true', limit: '40' };
  const playable = (s) => s && !s.hls && (s.url_resolved || s.url);

  function dedupe(list) {
    const seen = new Set();
    return list.filter((s) => playable(s) && !seen.has(s.stationuuid) && seen.add(s.stationuuid))
      .sort((a, b) => (b.clickcount || 0) - (a.clickcount || 0));
  }

  const searchByTag = (tag) => rb('/json/stations/search', { ...BASE_FILTER, tag });
  const searchByName = (name) => rb('/json/stations/search', { ...BASE_FILTER, name });
  const topStations = () => rb('/json/stations/search', BASE_FILTER);

  // ---------- state ----------
  const stations = new Map(); // uuid -> station
  let favorites = store.get('favs', []); // full station objects so they show without a network call
  let onAir = store.get('onair', null);
  let activeChip = null;

  // ---------- preview audio (in the browser, before pasting in game) ----------
  const audio = new Audio();
  audio.preload = 'none';
  let previewing = null;

  function stopPreview() {
    audio.pause();
    audio.removeAttribute('src');
    previewing = null;
    refreshRows();
  }

  async function togglePreview(st) {
    if (previewing === st.stationuuid) { stopPreview(); return; }
    const url = st.url_resolved || st.url;
    if (location.protocol === 'https:' && url.startsWith('http:')) {
      toast("Your browser won't preview http:// streams on this site, but the link still works in GMod.", true);
      return;
    }
    audio.src = url;
    previewing = st.stationuuid;
    refreshRows();
    try { await audio.play(); } catch {
      toast("Couldn't preview this one here. It may still work in GMod.", true);
      stopPreview();
    }
  }
  audio.addEventListener('error', () => { if (previewing) { toast('That stream failed to load. Try another station.', true); stopPreview(); } });

  // ---------- rendering ----------
  const GENRES = ['Pop', 'Hip Hop', 'Rap', 'Rock', 'Dance', 'Electronic', 'House', 'Techno', 'Drum and Bass',
    'Lofi', 'Chill', 'R&B', 'Jazz', 'Classical', 'Country', 'Metal', 'Reggae', 'Latin', 'Phonk',
    '80s', '90s', '2000s', 'Christmas'];

  function renderChips() {
    const chips = [];
    if (isLoggedIn()) chips.push(`<button class="chip spotify" data-chip="spotify">🎧 Match my Spotify</button>`);
    if (favorites.length) chips.push(`<button class="chip" data-chip="favs">★ Favorites</button>`);
    chips.push(`<button class="chip" data-chip="top">🔥 Most popular</button>`);
    chips.push(...GENRES.map((g) => `<button class="chip" data-chip="tag:${esc(g.toLowerCase())}">${esc(g)}</button>`));
    $('#st-chips').innerHTML = chips.join('');
    highlightChip();
  }

  function highlightChip() {
    document.querySelectorAll('#st-chips .chip').forEach((c) => c.classList.toggle('active', c.dataset.chip === activeChip));
  }

  function stationRow(st) {
    const isFav = favorites.some((f) => f.stationuuid === st.stationuuid);
    const tags = (st.tags || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 3).join(', ');
    const info = [tags, st.countrycode || st.country, st.bitrate ? `${st.bitrate} kbps` : ''].filter(Boolean).join(' · ');
    const id = esc(st.stationuuid);
    return `
      <div class="track ${previewing === st.stationuuid ? 'previewing' : ''}" data-row="${id}">
        <img src="${esc(st.favicon || '')}" alt="" loading="lazy" onerror="this.removeAttribute('src')">
        <div class="track-meta">
          <div class="track-title">${esc(st.name.trim() || 'Unnamed station')}</div>
          <div class="track-sub">${esc(info)}</div>
        </div>
        <div class="track-actions">
          <button class="btn btn-small btn-primary" data-st="copy" data-id="${id}" title="Copy the stream link for the radio">📋 Copy link</button>
          <button class="btn btn-small" data-st="preview" data-id="${id}" title="Listen here first">${previewing === st.stationuuid ? '⏹' : '▶'}</button>
          <button class="btn btn-small ${isFav ? 'fav-on' : ''}" data-st="fav" data-id="${id}" title="Favorite">${isFav ? '★' : '☆'}</button>
        </div>
      </div>`;
  }

  let currentList = [];
  function showList(list, emptyMsg = 'No stations found. Try another genre or name.') {
    currentList = list;
    list.forEach((s) => stations.set(s.stationuuid, s));
    $('#st-list').innerHTML = list.length ? list.map(stationRow).join('') : `<div class="empty">${esc(emptyMsg)}</div>`;
  }
  function refreshRows() { showList(currentList); }

  function renderOnAir() {
    const el = $('#st-onair');
    if (!onAir) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.innerHTML = `
      <div class="grow">📻 Last copied: <b>${esc(onAir.name)}</b><br><code>${esc(onAir.link)}</code></div>
      <button class="btn btn-small btn-primary" data-onair-copy>Copy again</button>`;
  }

  function loading() { $('#st-list').innerHTML = '<div class="empty"><span class="spinner"></span> Finding stations…</div>'; }

  async function run(fn) {
    loading();
    try { showList(dedupe(await fn())); } catch (e) { $('#st-list').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }

  // ---------- actions ----------
  async function copyStation(st) {
    const link = radioLink(st.url_resolved || st.url);
    if (await copyText(link)) toast('Copied! Paste it into the radio and press Enter 📻');
    else window.prompt('Copy this link:', link);
    onAir = { name: st.name.trim(), link };
    store.set('onair', onAir);
    renderOnAir();
    // tell the directory someone used it (helps keep popular stations ranked)
    rb(`/json/url/${encodeURIComponent(st.stationuuid)}`).catch(() => {});
  }

  function toggleFav(st) {
    const i = favorites.findIndex((f) => f.stationuuid === st.stationuuid);
    if (i >= 0) favorites.splice(i, 1);
    else favorites.unshift(st);
    store.set('favs', favorites);
    renderChips();
    refreshRows();
  }

  async function matchSpotify() {
    const track = nowPlayingTrack();
    if (!track) { toast('Play something on Spotify first.', true); return; }
    loading();
    let genres = [];
    try {
      if (track.artistIds?.length) {
        const artist = await api(`/artists/${track.artistIds[0]}`);
        genres = artist?.genres || [];
      }
    } catch { /* fall through */ }
    if (!genres.length) {
      $('#st-list').innerHTML = `<div class="empty">Spotify didn't give a genre for ${esc(track.firstArtist)}. Pick one of the genres above.</div>`;
      return;
    }
    // Spotify genres are very specific ("canadian hip hop"); also try without the first word ("hip hop").
    const broader = (g) => (g.includes(' ') ? g.split(' ').slice(1).join(' ') : g);
    const tags = [...new Set(genres.slice(0, 3).flatMap((g) => [g, broader(g)]))].slice(0, 5);
    toast(`Looking for ${tags.slice(0, 3).join(', ')} stations…`);
    await run(async () => (await Promise.allSettled(tags.map(searchByTag)))
      .flatMap((r) => (r.status === 'fulfilled' ? r.value : [])));
  }

  // ---------- events ----------
  $('#st-chips').addEventListener('click', (e) => {
    const c = e.target.closest('[data-chip]');
    if (!c) return;
    activeChip = c.dataset.chip;
    highlightChip();
    if (activeChip === 'spotify') matchSpotify();
    else if (activeChip === 'favs') showList(favorites, 'No favorites yet.');
    else if (activeChip === 'top') run(topStations);
    else if (activeChip.startsWith('tag:')) run(() => searchByTag(activeChip.slice(4)));
  });

  $('#st-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#st-q').value.trim();
    if (!q) return;
    activeChip = null;
    highlightChip();
    run(async () => {
      const [byTag, byName] = await Promise.allSettled([searchByTag(q.toLowerCase()), searchByName(q)]);
      if (byTag.status === 'rejected' && byName.status === 'rejected') throw byTag.reason;
      return [...(byName.value || []), ...(byTag.value || [])];
    });
  });

  $('#st-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-st]');
    if (!b) return;
    const st = stations.get(b.dataset.id);
    if (!st) return;
    if (b.dataset.st === 'copy') copyStation(st);
    else if (b.dataset.st === 'preview') togglePreview(st);
    else if (b.dataset.st === 'fav') toggleFav(st);
  });

  $('#st-onair').addEventListener('click', async (e) => {
    if (e.target.closest('[data-onair-copy]') && onAir && await copyText(onAir.link)) toast('Copied again');
  });

  // ---------- start ----------
  renderChips();
  renderOnAir();
  if (favorites.length) { activeChip = 'favs'; highlightChip(); showList(favorites); } else {
    activeChip = 'top'; highlightChip(); run(topStations);
  }
  // the Spotify chip appears once you're logged in
  setTimeout(renderChips, 1500);
})();
