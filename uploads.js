/* Upload mp3s to Vercel Blob and get direct links the GMod car radio can play. */
import { upload } from './vendor/blob-client.js';

const { toast, copyText, esc } = window.GRL;
const $ = (s) => document.querySelector(s);
const get = (k, d) => { try { const v = localStorage.getItem(`grl.up.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } };
const set = (k, v) => { try { if (v == null) localStorage.removeItem(`grl.up.${k}`); else localStorage.setItem(`grl.up.${k}`, JSON.stringify(v)); } catch { /* ignore */ } };

let password = get('pass', '');
let files = [];
const audio = new Audio();
let playing = null;

const prettyName = (pathname) => decodeURIComponent(pathname.replace(/^mp3\//, '').replace(/-[A-Za-z0-9]{20,}(?=\.mp3$)/, '').replace(/\.mp3$/i, '').replace(/[-_]+/g, ' '));
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function apiFiles(method = 'GET', body) {
  const res = await fetch('/api/files', {
    method,
    headers: { 'x-upload-password': password, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Error ${res.status}`); e.status = res.status; throw e; }
  return data;
}

function showLocked(locked) {
  $('#up-locked').classList.toggle('hidden', !locked);
  $('#up-unlocked').classList.toggle('hidden', locked);
}

async function refresh() {
  $('#up-list').innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  try {
    ({ files } = await apiFiles());
    render();
  } catch (e) {
    if (e.status === 401) { lock(); toast('Wrong upload password', true); return; }
    $('#up-list').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function render() {
  $('#up-count').textContent = files.length;
  $('#up-list').innerHTML = files.length ? files.map((f) => `
    <div class="track ${playing === f.url ? 'previewing' : ''}">
      <div class="mp3-icon">🎵</div>
      <div class="track-meta">
        <div class="track-title">${esc(prettyName(f.pathname))}</div>
        <div class="track-sub">${mb(f.size)} · ${new Date(f.uploadedAt).toLocaleDateString()}</div>
      </div>
      <div class="track-actions">
        <button class="btn btn-small btn-primary" data-up="copy" data-url="${esc(f.url)}">📋 Copy link</button>
        <button class="btn btn-small" data-up="play" data-url="${esc(f.url)}" title="Listen">${playing === f.url ? '⏹' : '▶'}</button>
        <button class="btn btn-small" data-up="del" data-url="${esc(f.url)}" title="Delete">🗑</button>
      </div>
    </div>`).join('') : '<div class="empty">No songs yet. Upload an mp3 above.</div>';
}

function lock() {
  password = ''; set('pass', null); files = [];
  audio.pause(); playing = null;
  $('#up-pass').value = '';
  showLocked(true);
}

$('#up-unlock').addEventListener('click', async () => {
  password = $('#up-pass').value.trim();
  if (!password) return;
  try {
    ({ files } = await apiFiles());
    set('pass', password);
    showLocked(false);
    render();
  } catch (e) {
    toast(e.status === 401 ? 'Wrong upload password' : e.message, true);
    password = '';
  }
});
$('#up-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#up-unlock').click(); });
$('#up-lock').addEventListener('click', lock);

// ---------- uploading ----------
function safeName(name) {
  const base = name.replace(/\.mp3$/i, '').normalize('NFKD').replace(/[^\w\s.-]/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'song';
  return `mp3/${base}.mp3`;
}

async function uploadFiles(list) {
  const mp3s = [...list].filter((f) => /\.mp3$/i.test(f.name) || f.type === 'audio/mpeg');
  if (!mp3s.length) { toast('Pick .mp3 files', true); return; }
  for (const file of mp3s) {
    const row = document.createElement('div');
    row.className = 'up-item';
    row.innerHTML = `<div class="row"><span class="name">${esc(file.name)}</span><span class="pct">0%</span></div><div class="progress"><div class="progress-bar"></div></div>`;
    $('#up-progress').prepend(row);
    if (file.size > 50 * 1024 * 1024) { row.classList.add('err'); row.querySelector('.pct').textContent = 'Too big (max 50 MB)'; continue; }
    try {
      const blob = await upload(safeName(file.name), file, {
        access: 'public',
        handleUploadUrl: '/api/upload',
        clientPayload: JSON.stringify({ password }),
        contentType: 'audio/mpeg',
        multipart: file.size > 8 * 1024 * 1024,
        onUploadProgress: ({ percentage }) => {
          row.querySelector('.pct').textContent = `${Math.round(percentage)}%`;
          row.querySelector('.progress-bar').style.width = `${percentage}%`;
        },
      });
      row.querySelector('.pct').textContent = '✔ Done, link copied';
      await copyText(blob.url);
      setTimeout(() => row.remove(), 4000);
    } catch (e) {
      row.classList.add('err');
      row.querySelector('.pct').textContent = /password/i.test(e.message) ? 'Wrong password' : (e.message || 'Failed');
    }
  }
  toast('Uploaded! Link copied. Paste it into the radio 📻');
  refresh();
}

$('#up-file').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });
const drop = $('#up-drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));

// ---------- list actions ----------
$('#up-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-up]');
  if (!b) return;
  const url = b.dataset.url;
  if (b.dataset.up === 'copy') {
    if (await copyText(url)) toast('Copied! Paste it into the radio and press Enter 📻');
    else window.prompt('Copy this link:', url);
  } else if (b.dataset.up === 'play') {
    if (playing === url) { audio.pause(); playing = null; } else {
      audio.src = url; playing = url;
      audio.play().catch(() => { playing = null; render(); toast("Couldn't play it here", true); });
    }
    render();
  } else if (b.dataset.up === 'del') {
    if (!confirm('Delete this song? Its link will stop working.')) return;
    try { await apiFiles('DELETE', { url }); toast('Deleted'); refresh(); } catch (err) { toast(err.message, true); }
  }
});
audio.addEventListener('ended', () => { playing = null; render(); });

// ---------- start ----------
if (password) { showLocked(false); refresh(); } else showLocked(true);
