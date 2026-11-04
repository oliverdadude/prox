/* GMod Radio Linker
 * Static, browser-only app: Spotify login (PKCE, no server/secret needed),
 * then turns any Spotify track into a YouTube link you can paste into a
 * Garry's Mod radio / media player.
 */
(() => {
  'use strict';

  // ---------- storage helpers ----------
  const PREFIX = 'grl.';
  const store = {
    get(key, fallback = null) {
      try {
        const raw = localStorage.getItem(PREFIX + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch { return fallback; }
    },
    set(key, value) {
      try {
        if (value == null) localStorage.removeItem(PREFIX + key);
        else localStorage.setItem(PREFIX + key, JSON.stringify(value));
      } catch { /* storage blocked: app still works for this visit */ }
    },
  };

  const settings = {
    get clientId() { return store.get('clientId', ''); },
    get ytKey() { return store.get('ytKey', ''); },
    get linkType() { return store.get('linkType', 'youtube'); },
    get ytSuffix() { return store.get('ytSuffix', 'audio'); },
    get notify() { return store.get('notify', true); },
  };

  // ---------- tiny DOM helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const show = (el, on = true) => el.classList.toggle('hidden', !on);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('error', isError);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 4500 : 2500);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
      return ok;
    }
  }

  // ---------- Spotify auth (Authorization Code + PKCE) ----------
  const SCOPES = [
    'user-read-currently-playing',
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-recently-played',
    'playlist-read-private',
    'playlist-read-collaborative',
    'user-library-read',
  ].join(' ');

  function redirectUri() {
    return location.origin + location.pathname.replace(/index\.html$/, '');
  }

  function randomString(len) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    return [...bytes].map((b) => chars[b % chars.length]).join('');
  }

  async function pkceChallenge(verifier) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function login() {
    if (!settings.clientId) { openSettings(); return; }
    if (!window.crypto?.subtle) {
      toast('This page must be opened over https:// (or http://127.0.0.1) to log in.', true);
      return;
    }
    const verifier = randomString(64);
    const state = randomString(16);
    store.set('pkce', { verifier, state });
    const params = new URLSearchParams({
      client_id: settings.clientId,
      response_type: 'code',
      redirect_uri: redirectUri(),
      scope: SCOPES,
      code_challenge_method: 'S256',
      code_challenge: await pkceChallenge(verifier),
      state,
    });
    location.href = `https://accounts.spotify.com/authorize?${params}`;
  }

  function saveToken(data) {
    const prev = store.get('token') || {};
    store.set('token', {
      access_token: data.access_token,
      refresh_token: data.refresh_token || prev.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    });
  }

  async function tokenRequest(body) {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error_description || data.error || `Token error ${res.status}`);
    return data;
  }

  async function handleCallback() {
    const q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return;
    history.replaceState(null, '', redirectUri());
    if (q.get('error')) {
      toast(`Spotify login cancelled (${q.get('error')})`, true);
      return;
    }
    const pkce = store.get('pkce');
    store.set('pkce', null);
    if (!pkce || pkce.state !== q.get('state')) {
      toast('Login check failed, please try again.', true);
      return;
    }
    try {
      const data = await tokenRequest({
        grant_type: 'authorization_code',
        code: q.get('code'),
        redirect_uri: redirectUri(),
        client_id: settings.clientId,
        code_verifier: pkce.verifier,
      });
      saveToken(data);
      toast('Spotify connected ✔');
    } catch (e) {
      toast(`Login failed: ${e.message}`, true);
    }
  }

  let refreshing = null;
  async function refreshToken() {
    const tok = store.get('token');
    if (!tok?.refresh_token) throw new Error('Not logged in');
    refreshing ??= tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: tok.refresh_token,
      client_id: settings.clientId,
    }).then(saveToken).finally(() => { refreshing = null; });
    return refreshing;
  }

  async function accessToken() {
    const tok = store.get('token');
    if (!tok) return null;
    if (Date.now() > tok.expires_at - 60_000) {
      try { await refreshToken(); } catch { logout(true); return null; }
    }
    return store.get('token').access_token;
  }

  function logout(expired = false) {
    store.set('token', null);
    stopPolling();
    if (expired) toast('Spotify session expired, please connect again.', true);
    render();
  }

  class ApiError extends Error {
    constructor(status, message, reason) { super(message); this.status = status; this.reason = reason; }
  }

  async function api(path, { method = 'GET', body, retried = false } = {}) {
    const token = await accessToken();
    if (!token) throw new ApiError(401, 'Not logged in');
    const url = path.startsWith('http') ? path : `https://api.spotify.com/v1${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) {
      try { await refreshToken(); } catch { logout(true); throw new ApiError(401, 'Session expired'); }
      return api(path, { method, body, retried: true });
    }
    if (res.status === 204 || res.status === 202) return null;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const err = data?.error || {};
      let msg = err.message || `Spotify error ${res.status}`;
      if (res.status === 429) msg = 'Spotify rate limit hit, wait a bit and try again.';
      throw new ApiError(res.status, msg, err.reason);
    }
    return data;
  }

  // ---------- track model ----------
  const tracks = new Map(); // id -> simplified track (so buttons can look them up)

  function simplify(t) {
    if (!t || !t.id || t.type === 'episode' && !t.show) return null;
    const isEpisode = t.type === 'episode';
    const images = isEpisode ? (t.images || t.show?.images || []) : (t.album?.images || []);
    const s = {
      id: t.id,
      name: t.name,
      artists: isEpisode ? (t.show?.name || '') : (t.artists || []).map((a) => a.name).join(', '),
      firstArtist: isEpisode ? (t.show?.name || '') : (t.artists?.[0]?.name || ''),
      artistIds: isEpisode ? [] : (t.artists || []).map((a) => a.id).filter(Boolean),
      art: images[images.length - 1]?.url || images[0]?.url || '',
      artBig: images[0]?.url || '',
      durationMs: t.duration_ms || 0,
      spotifyUrl: t.external_urls?.spotify || `https://open.spotify.com/track/${t.id}`,
    };
    tracks.set(s.id, s);
    return s;
  }

  // ---------- YouTube lookup ----------
  const linkCache = store.get('linkCache', {}); // trackId -> { videoId, title } | { custom }
  const candidateCache = new Map();             // trackId -> [candidates] (this visit only)

  function saveLinkCache() { store.set('linkCache', linkCache); }

  function ytUrl(videoId) {
    return settings.linkType === 'youtu.be'
      ? `https://youtu.be/${videoId}`
      : `https://www.youtube.com/watch?v=${videoId}`;
  }

  function ytQuery(track) {
    return [track.firstArtist, '-', track.name, settings.ytSuffix].filter(Boolean).join(' ');
  }

  function ytSearchUrl(track) {
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(ytQuery(track))}`;
  }

  function parseYtId(url) {
    const m = String(url).match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/);
    return m ? m[1] : null;
  }

  function isoDurationMs(iso) {
    const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
    if (!m) return 0;
    const [, d = 0, h = 0, mi = 0, s = 0] = m.map((x) => +x || 0);
    return (((d * 24 + h) * 60 + mi) * 60 + s) * 1000;
  }

  const UNWANTED = ['live', 'cover', 'remix', 'sped up', 'slowed', 'nightcore', '8d', 'karaoke',
    'instrumental', 'reaction', 'tutorial', 'mashup', 'bass boosted', 'reverb', '1 hour', '10 hours'];

  function scoreCandidate(track, c) {
    const title = c.title.toLowerCase();
    const want = `${track.name} ${track.artists}`.toLowerCase();
    let score = 0;
    if (c.durationMs && track.durationMs) score += Math.abs(c.durationMs - track.durationMs) / 1000;
    else score += 60;
    for (const w of UNWANTED) if (title.includes(w) && !want.includes(w)) score += 90;
    if (c.channel.endsWith(' - Topic')) score -= 15;
    if (/\baudio\b/.test(title)) score -= 8;
    if (title.includes(track.name.toLowerCase())) score -= 10;
    if (c.channel.toLowerCase().includes(track.firstArtist.toLowerCase())) score -= 8;
    if (c.embeddable === false) score += 1000; // in-game players usually can't play these
    return score;
  }

  async function ytSearch(track) {
    if (candidateCache.has(track.id)) return candidateCache.get(track.id);
    const key = settings.ytKey;
    const sp = new URLSearchParams({
      part: 'snippet', type: 'video', maxResults: '8', q: ytQuery(track), key,
    });
    const sres = await fetch(`https://www.googleapis.com/youtube/v3/search?${sp}`);
    const sdata = await sres.json().catch(() => ({}));
    if (!sres.ok) {
      const reason = sdata?.error?.errors?.[0]?.reason;
      if (reason === 'quotaExceeded') throw new Error('YouTube API daily limit reached. Use "Search on YouTube" for now.');
      throw new Error(sdata?.error?.message || `YouTube error ${sres.status}`);
    }
    const ids = (sdata.items || []).map((i) => i.id?.videoId).filter(Boolean);
    if (!ids.length) { candidateCache.set(track.id, []); return []; }

    const vp = new URLSearchParams({ part: 'contentDetails,snippet,status', id: ids.join(','), key });
    const vres = await fetch(`https://www.googleapis.com/youtube/v3/videos?${vp}`);
    const vdata = vres.ok ? await vres.json() : { items: [] };
    const byId = new Map((vdata.items || []).map((v) => [v.id, v]));

    const candidates = ids.map((id) => {
      const v = byId.get(id);
      const s = sdata.items.find((i) => i.id.videoId === id).snippet;
      return {
        videoId: id,
        title: decodeEntities(v?.snippet?.title || s.title),
        channel: v?.snippet?.channelTitle || s.channelTitle || '',
        thumb: s.thumbnails?.medium?.url || s.thumbnails?.default?.url || '',
        durationMs: isoDurationMs(v?.contentDetails?.duration),
        embeddable: v?.status?.embeddable,
      };
    });
    candidates.forEach((c) => { c.score = scoreCandidate(track, c); });
    candidates.sort((a, b) => a.score - b.score);
    candidateCache.set(track.id, candidates);
    return candidates;
  }

  function decodeEntities(s) {
    const t = document.createElement('textarea');
    t.innerHTML = s;
    return t.value;
  }

  // Returns the URL to paste into the radio, or null if we can't find one automatically.
  async function resolveLink(track) {
    if (settings.linkType === 'spotify') return track.spotifyUrl;
    const cached = linkCache[track.id];
    if (cached?.custom) return cached.custom;
    if (cached?.videoId) return ytUrl(cached.videoId);
    if (!settings.ytKey) return null;
    const [best] = await ytSearch(track);
    if (!best) return null;
    linkCache[track.id] = { videoId: best.videoId, title: best.title };
    saveLinkCache();
    return ytUrl(best.videoId);
  }

  async function copyForRadio(track, btn) {
    const original = btn?.innerHTML;
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
    try {
      const url = await resolveLink(track);
      if (!url) { openPicker(track); return false; }
      const ok = await copyText(url);
      if (ok) {
        toast(`Copied! Paste it into the radio 📻`);
        startRadioTimer(track);
        return true;
      }
      // clipboard blocked: show it in the picker so they can copy by hand
      openPicker(track, url);
      return false;
    } catch (e) {
      toast(e.message, true);
      openPicker(track);
      return false;
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = original; }
    }
  }

  // ---------- picker dialog (choose a different video / paste own link) ----------
  let pickerTrack = null;

  async function openPicker(track, manualUrl) {
    pickerTrack = track;
    const dlg = $('#picker');
    $('#picker-for').textContent = `${track.name} — ${track.artists} (${fmt(track.durationMs)})`;
    $('#picker-yt-search').href = ytSearchUrl(track);
    $('#picker-custom').value = manualUrl || linkCache[track.id]?.custom || '';
    const list = $('#picker-list');
    if (!dlg.open) dlg.showModal();

    if (manualUrl) {
      list.innerHTML = `<p class="hint">Your browser blocked automatic copying. Select the link above and copy it with Ctrl+C.</p>`;
      $('#picker-custom').select();
      return;
    }
    if (!settings.ytKey) {
      list.innerHTML = `<p class="hint">No YouTube API key set, so I can't search for you. Click <b>Search on YouTube</b>, open the right video, copy its address and paste it below. I'll remember it for this song.<br><br>Tip: add a free API key in ⚙️ Settings to make this automatic.</p>`;
      return;
    }
    list.innerHTML = '<p class="hint"><span class="spinner"></span> Searching YouTube…</p>';
    try {
      const cands = await ytSearch(track);
      if (pickerTrack !== track) return;
      if (!cands.length) { list.innerHTML = '<p class="hint">No results. Try Search on YouTube.</p>'; return; }
      const current = linkCache[track.id]?.videoId;
      list.innerHTML = cands.map((c) => `
        <button class="pick ${c.videoId === current ? 'current' : ''}" data-video="${esc(c.videoId)}">
          <img src="${esc(c.thumb)}" alt="" loading="lazy">
          <div>
            <div class="p-title">${esc(c.title)}</div>
            <div class="p-sub">${esc(c.channel)} · ${fmt(c.durationMs)}${c.embeddable === false ? ' · ⚠️ may not play in-game' : ''}${c.videoId === current ? ' · ✔ current' : ''}</div>
          </div>
        </button>`).join('');
    } catch (e) {
      list.innerHTML = `<p class="hint">${esc(e.message)}</p>`;
    }
  }

  $('#picker-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-video]');
    if (!b || !pickerTrack) return;
    const c = candidateCache.get(pickerTrack.id)?.find((x) => x.videoId === b.dataset.video);
    linkCache[pickerTrack.id] = { videoId: b.dataset.video, title: c?.title || '' };
    saveLinkCache();
    $('#picker').close();
    await copyForRadio(pickerTrack);
  });

  $('#btn-picker-custom').addEventListener('click', async () => {
    const url = $('#picker-custom').value.trim();
    if (!/^https?:\/\//i.test(url)) { toast('Paste a full link starting with https://', true); return; }
    const id = parseYtId(url);
    linkCache[pickerTrack.id] = id ? { videoId: id, title: '' } : { custom: url };
    saveLinkCache();
    $('#picker').close();
    await copyForRadio(pickerTrack);
  });
  $('#btn-picker-close').addEventListener('click', () => $('#picker').close());

  // ---------- rendering tracks ----------
  function trackActions(track, { queueIndex } = {}) {
    const id = esc(track.id);
    const inQueue = queueIndex != null;
    return `
      <button class="btn btn-small btn-primary" data-act="copy" data-id="${id}" ${inQueue ? `data-qi="${queueIndex}"` : ''} title="Copy the link for the radio">📋 Copy link</button>
      <button class="btn btn-small" data-act="pick" data-id="${id}" title="Choose a different video">🎯</button>
      ${inQueue
        ? `<button class="btn btn-small" data-act="up" data-qi="${queueIndex}" title="Move up" ${queueIndex === 0 ? 'disabled' : ''}>↑</button>
           <button class="btn btn-small" data-act="remove" data-qi="${queueIndex}" title="Remove">✕</button>`
        : `<button class="btn btn-small" data-act="queue" data-id="${id}" title="Add to radio queue">＋ Queue</button>`}`;
  }

  function trackRow(track, opts = {}) {
    const num = opts.queueIndex != null ? `<span class="num">${opts.queueIndex + 1}.</span>` : '';
    return `
      <div class="track">
        <img src="${esc(track.art)}" alt="" loading="lazy">
        <div class="track-meta">
          <div class="track-title">${num}${esc(track.name)}</div>
          <div class="track-sub">${esc(track.artists)} · ${fmt(track.durationMs)}</div>
        </div>
        <div class="track-actions">${trackActions(track, opts)}</div>
      </div>`;
  }

  function renderList(el, list, emptyMsg) {
    el.innerHTML = list.length ? list.map((t) => trackRow(t)).join('') : `<div class="empty">${emptyMsg}</div>`;
  }

  // one click handler for every track button on the page
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const track = tracks.get(b.dataset.id);
    const qi = b.dataset.qi != null ? +b.dataset.qi : null;
    if (act === 'copy' && track) {
      const ok = await copyForRadio(track, b);
      if (ok && qi != null) { queue.splice(qi, 1); saveQueue(); }
    } else if (act === 'pick' && track) {
      openPicker(track);
    } else if (act === 'queue' && track) {
      queue.push(track); saveQueue();
      toast(`Added to radio queue (#${queue.length})`);
    } else if (act === 'up' && qi > 0) {
      [queue[qi - 1], queue[qi]] = [queue[qi], queue[qi - 1]]; saveQueue();
    } else if (act === 'remove' && qi != null) {
      queue.splice(qi, 1); saveQueue();
    }
  });

  // ---------- radio queue ----------
  const queue = store.get('queue', []);
  queue.forEach((t) => tracks.set(t.id, t));

  function saveQueue() {
    store.set('queue', queue);
    renderQueue();
  }

  function renderQueue() {
    $('#queue-count').textContent = queue.length;
    $('#queue-list').innerHTML = queue.length
      ? queue.map((t, i) => trackRow(t, { queueIndex: i })).join('')
      : '<div class="empty">Queue is empty. Use “＋ Queue” on any song to line it up.</div>';
    $('#btn-queue-next').disabled = !queue.length;
    updateUpNext();
  }

  async function copyNext(btn) {
    if (!queue.length) { toast('Queue is empty'); return; }
    const next = queue[0];
    const ok = await copyForRadio(next, btn);
    if (ok) { queue.shift(); saveQueue(); }
  }

  $('#btn-queue-next').addEventListener('click', (e) => copyNext(e.currentTarget));
  $('#btn-timer-next').addEventListener('click', (e) => copyNext(e.currentTarget));
  $('#btn-queue-clear').addEventListener('click', () => {
    if (queue.length && confirm('Clear the whole radio queue?')) { queue.length = 0; saveQueue(); }
  });
  $('#btn-queue-shuffle').addEventListener('click', () => {
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    saveQueue();
  });

  // ---------- "on the radio" timer ----------
  let radio = store.get('radio'); // { name, artists, startedAt, durationMs, beeped }

  function startRadioTimer(track) {
    if (!track.durationMs) return;
    radio = { name: track.name, artists: track.artists, startedAt: Date.now(), durationMs: track.durationMs, beeped: false };
    store.set('radio', radio);
    tickRadio();
  }

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.25].forEach((when) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.15, ctx.currentTime + when);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + when + 0.2);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + when);
        o.stop(ctx.currentTime + when + 0.22);
      });
    } catch { /* audio not available */ }
  }

  const baseTitle = document.title;
  function tickRadio() {
    const box = $('#radio-timer');
    if (!radio) { show(box, false); document.title = baseTitle; return; }
    show(box, true);
    const elapsed = Date.now() - radio.startedAt;
    const left = radio.durationMs - elapsed;
    $('#rt-title').textContent = `${radio.name} — ${radio.artists}`;
    $('#rt-progress').style.width = `${Math.min(100, (elapsed / radio.durationMs) * 100)}%`;
    const ending = left <= 15_000;
    box.classList.toggle('ending', ending);
    if (left > 0) {
      $('#rt-left').textContent = `${fmt(left)} left`;
      document.title = ending ? `⏰ ${fmt(left)} – queue next!` : baseTitle;
    } else {
      $('#rt-left').textContent = 'Song should be over — paste the next one!';
      document.title = '⏰ Radio song finished';
    }
    if (ending && !radio.beeped) {
      radio.beeped = true;
      store.set('radio', radio);
      if (settings.notify) beep();
    }
    if (left < -10 * 60_000) { radio = null; store.set('radio', null); tickRadio(); }
  }

  function updateUpNext() {
    const next = queue[0];
    $('#rt-next').innerHTML = next ? `Up next: <b>${esc(next.name)}</b> — ${esc(next.artists)}` : 'Queue is empty';
    $('#btn-timer-next').disabled = !next;
  }

  $('#btn-rt-stop').addEventListener('click', () => { radio = null; store.set('radio', null); tickRadio(); });
  setInterval(tickRadio, 1000);

  // ---------- now playing + Spotify controls ----------
  let nowPlaying = null; // { track, progressMs, isPlaying, fetchedAt }
  let pollTimer = null;

  async function pollNowPlaying() {
    try {
      const data = await api('/me/player/currently-playing?additional_types=track,episode');
      const track = data?.item ? simplify(data.item) : null;
      nowPlaying = track ? {
        track, progressMs: data.progress_ms || 0, isPlaying: !!data.is_playing, fetchedAt: Date.now(),
      } : null;
    } catch (e) {
      if (e.status === 401) return;
      nowPlaying = null;
    }
    renderNowPlaying(true);
  }

  let lastNpId = null;
  function renderNowPlaying(full = false) {
    const np = nowPlaying;
    if (!np) {
      $('#np-title').textContent = 'Nothing playing';
      $('#np-artist').textContent = 'Start a song in Spotify on any device and it shows up here.';
      $('#np-art').removeAttribute('src');
      $('#np-progress').style.width = '0';
      $('#np-pos').textContent = '0:00';
      $('#np-dur').textContent = '0:00';
      $('#np-actions').innerHTML = '';
      $('#np-playpause').textContent = '▶';
      lastNpId = null;
      return;
    }
    const pos = Math.min(np.track.durationMs, np.progressMs + (np.isPlaying ? Date.now() - np.fetchedAt : 0));
    $('#np-progress').style.width = `${np.track.durationMs ? (pos / np.track.durationMs) * 100 : 0}%`;
    $('#np-pos').textContent = fmt(pos);
    if (!full) return;
    $('#np-playpause').textContent = np.isPlaying ? '⏸' : '▶';
    $('#np-dur').textContent = fmt(np.track.durationMs);
    if (lastNpId === np.track.id) return;
    lastNpId = np.track.id;
    $('#np-title').textContent = np.track.name;
    $('#np-artist').textContent = np.track.artists;
    $('#np-art').src = np.track.artBig || np.track.art;
    $('#np-actions').innerHTML = trackActions(np.track);
  }

  function startPolling() {
    stopPolling();
    pollNowPlaying();
    pollTimer = setInterval(() => { if (!document.hidden) pollNowPlaying(); }, 5000);
  }
  function stopPolling() { clearInterval(pollTimer); pollTimer = null; }
  setInterval(() => renderNowPlaying(false), 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && pollTimer) pollNowPlaying(); });

  $$('[data-player]').forEach((b) => b.addEventListener('click', async () => {
    let action = b.dataset.player;
    if (action === 'toggle') action = nowPlaying?.isPlaying ? 'pause' : 'play';
    const method = action === 'next' || action === 'previous' ? 'POST' : 'PUT';
    try {
      await api(`/me/player/${action}`, { method });
      if (nowPlaying && (action === 'play' || action === 'pause')) {
        nowPlaying.progressMs += nowPlaying.isPlaying ? Date.now() - nowPlaying.fetchedAt : 0;
        nowPlaying.fetchedAt = Date.now();
        nowPlaying.isPlaying = action === 'play';
        renderNowPlaying(true);
      }
      setTimeout(pollNowPlaying, 400);
    } catch (e) {
      if (e.status === 404 || e.reason === 'NO_ACTIVE_DEVICE') toast('Open Spotify on a device first.', true);
      else if (e.status === 403) toast('Spotify only allows play/pause/skip from websites with Premium.', true);
      else toast(e.message, true);
    }
  }));

  // ---------- search ----------
  $('#search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('#search-input').value.trim();
    const el = $('#search-results');
    if (!q) return;
    el.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    try {
      const data = await api(`/search?${new URLSearchParams({ q, type: 'track', limit: '10' })}`);
      renderList(el, (data?.tracks?.items || []).map(simplify).filter(Boolean), 'No songs found.');
    } catch (err) {
      el.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  });

  // ---------- playlists ----------
  let playlistsLoaded = false;
  let playlists = [];

  async function loadPlaylists() {
    const view = $('#playlist-view');
    view.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    try {
      playlists = [];
      let next = '/me/playlists?limit=50';
      while (next && playlists.length < 500) {
        const page = await api(next);
        playlists.push(...(page?.items || []).filter(Boolean));
        next = page?.next;
      }
      playlistsLoaded = true;
      renderPlaylistGrid();
    } catch (e) {
      view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  function renderPlaylistGrid() {
    const tiles = [
      `<button class="playlist-tile" data-pl="liked">
         <div class="ph" style="background:linear-gradient(135deg,#450af5,#8e8ee5)">💚</div>
         <div class="pt-name">Liked Songs</div><div class="pt-sub">Your saved songs</div>
       </button>`,
      ...playlists.map((p) => {
        const img = p.images?.[0]?.url;
        const count = p.items?.total ?? p.tracks?.total;
        return `<button class="playlist-tile" data-pl="${esc(p.id)}">
          ${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : '<div class="ph">🎵</div>'}
          <div class="pt-name">${esc(p.name)}</div>
          <div class="pt-sub">${count != null ? `${count} songs` : esc(p.owner?.display_name || '')}</div>
        </button>`;
      }),
    ];
    $('#playlist-view').innerHTML = `<div class="playlist-grid">${tiles.join('')}</div>`;
  }

  async function fetchAllItems(firstUrl, max = 1000) {
    const out = [];
    let next = firstUrl;
    while (next && out.length < max) {
      const page = await api(next);
      for (const it of page?.items || []) {
        const t = simplify(it.item || it.track);
        if (t) out.push(t);
      }
      next = page?.next;
    }
    return out;
  }

  async function openPlaylist(id) {
    const view = $('#playlist-view');
    const name = id === 'liked' ? 'Liked Songs' : (playlists.find((p) => p.id === id)?.name || 'Playlist');
    view.innerHTML = `<div class="pl-head"><button class="btn btn-small btn-ghost" data-pl-back>← Back</button><h3>${esc(name)}</h3></div>
      <div class="track-list"><div class="empty"><span class="spinner"></span> Loading songs…</div></div>`;
    try {
      let list;
      if (id === 'liked') {
        list = await fetchAllItems('/me/tracks?limit=50');
      } else {
        try {
          list = await fetchAllItems(`/playlists/${id}/items?limit=50`);
        } catch (e) {
          if (e.status !== 404) throw e;
          list = await fetchAllItems(`/playlists/${id}/tracks?limit=50`); // older API name
        }
      }
      view.innerHTML = `<div class="pl-head">
          <button class="btn btn-small btn-ghost" data-pl-back>← Back</button>
          <h3>${esc(name)}</h3>
          <button class="btn btn-small" data-pl-queue-all>＋ Queue all (${list.length})</button>
        </div><div class="track-list" id="pl-tracks"></div>`;
      view._list = list;
      renderList($('#pl-tracks'), list, 'This playlist has no playable songs (Spotify may hide songs from playlists you don\'t own).');
    } catch (e) {
      view.querySelector('.track-list').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  $('#playlist-view').addEventListener('click', (e) => {
    const tile = e.target.closest('[data-pl]');
    if (tile) { openPlaylist(tile.dataset.pl); return; }
    if (e.target.closest('[data-pl-back]')) { renderPlaylistGrid(); return; }
    if (e.target.closest('[data-pl-queue-all]')) {
      const list = $('#playlist-view')._list || [];
      queue.push(...list); saveQueue();
      toast(`Added ${list.length} song${list.length === 1 ? "" : "s"} to the radio queue`);
    }
  });

  // ---------- recently played ----------
  async function loadRecent() {
    const el = $('#recent-list');
    el.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    try {
      const data = await api('/me/player/recently-played?limit=50');
      const seen = new Set();
      const list = (data?.items || []).map((i) => simplify(i.track)).filter((t) => t && !seen.has(t.id) && seen.add(t.id));
      renderList(el, list, 'Nothing played recently.');
    } catch (e) {
      el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  // ---------- tabs ----------
  function switchTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.tab-panel').forEach((p) => show(p, p.dataset.panel === name));
    store.set('tab', name);
    if (name === 'playlists' && !playlistsLoaded) loadPlaylists();
    if (name === 'recent') loadRecent();
    if (name === 'search') $('#search-input').focus();
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // ---------- settings ----------
  function openSettings() {
    $('#set-client-id').value = settings.clientId;
    $('#set-yt-key').value = settings.ytKey;
    $('#set-link-type').value = settings.linkType;
    $('#set-yt-suffix').value = settings.ytSuffix;
    $('#set-notify').checked = settings.notify;
    $('#settings').showModal();
  }

  $('#btn-settings').addEventListener('click', openSettings);
  $('#settings').addEventListener('close', () => {
    if ($('#settings').returnValue !== 'save') return;
    const oldClient = settings.clientId;
    const oldSuffix = settings.ytSuffix;
    store.set('clientId', $('#set-client-id').value.trim());
    store.set('ytKey', $('#set-yt-key').value.trim());
    store.set('linkType', $('#set-link-type').value);
    store.set('ytSuffix', $('#set-yt-suffix').value);
    store.set('notify', $('#set-notify').checked);
    if (oldSuffix !== settings.ytSuffix) candidateCache.clear();
    if (oldClient !== settings.clientId) store.set('token', null);
    toast('Settings saved');
    render();
  });
  $('#btn-clear-cache').addEventListener('click', () => {
    for (const k of Object.keys(linkCache)) delete linkCache[k];
    candidateCache.clear();
    saveLinkCache();
    toast('Saved links cleared');
  });

  $('#btn-setup-save').addEventListener('click', () => {
    const id = $('#setup-client-id').value.trim();
    if (!/^[0-9a-f]{32}$/i.test(id)) { toast('That doesn\'t look like a Client ID (32 letters/numbers).', true); return; }
    store.set('clientId', id);
    login();
  });

  $('#btn-connect').addEventListener('click', login);
  $('#btn-connect-2').addEventListener('click', login);
  $('#btn-logout').addEventListener('click', () => { logout(); toast('Logged out'); });

  $$('[data-copy-target]').forEach((b) => b.addEventListener('click', async () => {
    if (await copyText($(`#${b.dataset.copyTarget}`).textContent)) toast('Copied');
  }));

  // ---------- top-level render ----------
  async function loadProfile() {
    try {
      const me = await api('/me');
      $('#user-name').textContent = me.display_name || me.id;
      const img = me.images?.[0]?.url;
      if (img) $('#user-avatar').src = img; else $('#user-avatar').removeAttribute('src');
    } catch { /* not fatal */ }
  }

  function render() {
    const hasClient = !!settings.clientId;
    const loggedIn = !!store.get('token');
    $('#redirect-uri').textContent = redirectUri();
    $('#redirect-uri-2').textContent = redirectUri();
    show($('#setup'), !hasClient);
    show($('#connect-card'), hasClient && !loggedIn);
    show($('#btn-connect'), hasClient && !loggedIn);
    show($('#btn-logout'), loggedIn);
    show($('#user-chip'), loggedIn);
    show($('#now-playing'), loggedIn);
    show($('#browser'), loggedIn);
    if (loggedIn) {
      loadProfile();
      startPolling();
    } else {
      stopPolling();
    }
  }

  // shared with stations.js
  // The GMod car radio rejects long links, so every link we hand out is a
  // short /p/<id>.pls playlist on this site that points at the real audio.
  const shortCache = store.get('shortLinks', {});
  async function radioLink(url) {
    if (shortCache[url]) return shortCache[url];
    const res = await fetch('/api/short', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.link) throw new Error(data.error || "Couldn't make a short link, try again.");
    shortCache[url] = data.link;
    store.set('shortLinks', shortCache);
    return data.link;
  }

  window.GRL = {
    toast, copyText, api, esc, radioLink,
    isLoggedIn: () => !!store.get('token'),
    nowPlayingTrack: () => nowPlaying?.track || null,
  };

  (async function init() {
    await handleCallback();
    render();
    renderQueue();
    tickRadio();
    const tab = store.get('tab', 'search');
    if (store.get('token')) switchTab(['search', 'playlists', 'recent', 'queue'].includes(tab) ? tab : 'search');
  })();
})();
