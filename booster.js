/* Volume booster: apply a gain (100–500%) to an audio file in the browser,
 * optionally through a limiter, and export it as an mp3. Nothing leaves the
 * browser unless you choose "Upload". */
import { Mp3Encoder } from './vendor/lame.js';

const { toast, copyText } = window.GRL;
const $ = (s) => document.querySelector(s);

let fileName = '';
let decoded = null;     // AudioBuffer of the chosen file
let ctx = null;         // live preview context
let live = null;        // { src, gain }

const gainValue = () => Number($('#bo-gain').value) / 100;

// gain -> (limiter) -> destination; shared by live preview and export
function buildChain(ac, input) {
  const gain = ac.createGain();
  gain.gain.value = gainValue();
  input.connect(gain);
  let out = gain;
  if ($('#bo-limit').checked) {
    const lim = ac.createDynamicsCompressor();
    lim.threshold.value = -2;
    lim.knee.value = 0;
    lim.ratio.value = 20;
    lim.attack.value = 0.002;
    lim.release.value = 0.08;
    gain.connect(lim);
    out = lim;
  }
  out.connect(ac.destination);
  return gain;
}

function setStatus(t) { $('#bo-status').textContent = t; }

async function loadFile(file) {
  if (!file) return;
  $('#bo-pick').value = '';
  await loadAudio(() => file.arrayBuffer(), file.name);
}

async function loadAudio(getBytes, name) {
  stopPreview();
  setStatus('Loading…');
  try {
    ctx ??= new AudioContext();
    decoded = await ctx.decodeAudioData(await getBytes());
    fileName = name.replace(/\.(mp3|wav|ogg|m4a|flac)$/i, '');
    $('#bo-name').innerHTML = `<b>${window.GRL.esc(name)}</b> · ${Math.round(decoded.duration)}s · click to change`;
    $('#bo-controls').classList.remove('hidden');
    setStatus('');
  } catch {
    decoded = null;
    setStatus('');
    toast("Couldn't read that file. Try an mp3.", true);
  }
}

// ---------- live preview ----------
function stopPreview() {
  if (live) { try { live.src.stop(); } catch { /* already stopped */ } live = null; }
  $('#bo-preview').textContent = '▶ Preview';
}

async function startPreview() {
  if (!decoded) return;
  await ctx.resume();
  const src = ctx.createBufferSource();
  src.buffer = decoded;
  const gain = buildChain(ctx, src);
  src.onended = () => { if (live?.src === src) stopPreview(); };
  src.start();
  live = { src, gain };
  $('#bo-preview').textContent = '⏹ Stop';
}

$('#bo-preview').addEventListener('click', () => (live ? stopPreview() : startPreview()));

$('#bo-gain').addEventListener('input', () => {
  const v = gainValue();
  $('#bo-gain-out').textContent = `${Math.round(v * 100)}%`;
  $('.bo-slider-row').classList.toggle('bo-hot', v > 2);
  if (live) live.gain.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
});
// limiter on/off rebuilds the chain, so restart the preview
$('#bo-limit').addEventListener('change', () => { if (live) { stopPreview(); startPreview(); } });

// ---------- export ----------
async function renderMp3() {
  const channels = Math.min(2, decoded.numberOfChannels);
  const off = new OfflineAudioContext(channels, decoded.length, decoded.sampleRate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  buildChain(off, src);
  src.start();
  setStatus('Boosting…');
  const rendered = await off.startRendering();

  const enc = new Mp3Encoder(channels, rendered.sampleRate, 192);
  const toInt16 = (f) => {
    const out = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) {
      const v = Math.max(-1, Math.min(1, f[i]));   // hard clip anything still over the top
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out;
  };
  const left = toInt16(rendered.getChannelData(0));
  const right = channels > 1 ? toInt16(rendered.getChannelData(1)) : null;
  const parts = [];
  const STEP = 1152 * 40;
  for (let i = 0; i < left.length; i += STEP) {
    const l = left.subarray(i, i + STEP);
    const chunk = right ? enc.encodeBuffer(l, right.subarray(i, i + STEP)) : enc.encodeBuffer(l);
    if (chunk.length) parts.push(chunk);
    if ((i / STEP) % 20 === 0) {
      setStatus(`Encoding mp3… ${Math.round((i / left.length) * 100)}%`);
      await new Promise((r) => setTimeout(r));     // keep the page responsive
    }
  }
  parts.push(enc.flush());
  const pct = Math.round(gainValue() * 100);
  return new File(parts, `${fileName || 'song'} (boost ${pct}%).mp3`, { type: 'audio/mpeg' });
}

async function withBusy(btn, fn) {
  const all = ['#bo-download', '#bo-upload', '#bo-preview'].map((s) => $(s));
  all.forEach((b) => { b.disabled = true; });
  stopPreview();
  try { await fn(); } catch (e) { toast(e.message || 'Something went wrong', true); setStatus(''); } finally {
    all.forEach((b) => { b.disabled = false; });
  }
}

$('#bo-download').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  const file = await renderMp3();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  setStatus(`✔ Saved “${file.name}”`);
}));

$('#bo-upload').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  if (!window.GRL.uploadMp3) throw new Error('Uploads are still loading, try again.');
  const file = await renderMp3();
  setStatus('Uploading… 0%');
  const link = await window.GRL.uploadMp3(file, (p) => setStatus(`Uploading… ${Math.round(p)}%`));
  const ok = await copyText(link);
  setStatus(ok ? `✔ Uploaded, link copied: ${link}` : `✔ Uploaded: ${link}`);
  toast(ok ? 'Boosted song uploaded, link copied 📻' : 'Uploaded');
}));

// ---------- your uploaded songs ----------
async function loadUrl(url, name) {
  await loadAudio(async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error();
    return res.arrayBuffer();
  }, name || 'song');
}

window.GRL.boostUrl = (url, name) => {
  $('#bo-pick').value = url;
  document.getElementById('booster').scrollIntoView({ behavior: 'smooth', block: 'start' });
  loadUrl(url, name);
};

function fillPicker(songs) {
  const pick = $('#bo-pick');
  const current = pick.value;
  pick.innerHTML = '<option value="">…or pick one of your uploaded songs</option>'
    + songs.map((f) => `<option value="${window.GRL.esc(f.url)}">${window.GRL.esc(f.name)}</option>`).join('');
  if (songs.some((f) => f.url === current)) pick.value = current;
  $('#bo-pick-row').classList.toggle('hidden', !songs.length);
}
window.addEventListener('grl:uploads', (e) => fillPicker(e.detail || []));
fillPicker(window.GRL.uploadedSongs || []);

$('#bo-pick').addEventListener('change', (e) => {
  const opt = e.target.selectedOptions[0];
  if (e.target.value) loadUrl(e.target.value, opt.textContent);
});

// ---------- file picking ----------
$('#bo-file').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
const drop = $('#bo-drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));
