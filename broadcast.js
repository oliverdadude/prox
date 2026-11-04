/* "My Spotify broadcast": remembers your own stream link (e.g. Zeno.fm fed by BUTT)
 * and walks you through the one-time setup. */
(() => {
  'use strict';
  const { toast, copyText, radioLink } = window.GRL;
  const $ = (s) => document.querySelector(s);
  const get = (k, d) => { try { const v = localStorage.getItem(`grl.bc.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const set = (k, v) => { try { localStorage.setItem(`grl.bc.${k}`, JSON.stringify(v)); } catch { /* ignore */ } };

  let url = get('url', '');
  const audio = new Audio();
  audio.preload = 'none';
  let testing = false;

  function render() {
    $('#bc-url').value = url;
    $('#bc-copy').disabled = !url;
    $('#bc-test').disabled = !url;
    $('#bc-test').textContent = testing ? '⏹ Stop test' : '▶ Test it here';
  }

  function stopTest() { audio.pause(); audio.removeAttribute('src'); testing = false; render(); }

  $('#bc-save').addEventListener('click', () => {
    const v = $('#bc-url').value.trim();
    if (v && !/^https?:\/\/\S+$/i.test(v)) { toast('Paste the full link starting with https:// or http://', true); return; }
    if (/zeno\.fm\/(radio|podcast)\//i.test(v)) toast("That looks like the station's web page. Use the stream URL from its settings.", true);
    url = v; set('url', url); stopTest();
    $('#bc-status').textContent = '';
    toast(url ? 'Saved' : 'Cleared');
  });
  $('#bc-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#bc-save').click(); } });

  $('#bc-copy').addEventListener('click', async () => {
    const link = radioLink(url);
    if (await copyText(link)) toast('Copied! Paste it into the radio and press Enter 📻');
    else window.prompt('Copy this link:', link);
  });

  $('#bc-test').addEventListener('click', async () => {
    if (testing) { stopTest(); return; }
    if (location.protocol === 'https:' && url.startsWith('http:')) {
      $('#bc-status').textContent = "Can't test http:// links here, but it may still work in GMod.";
      return;
    }
    testing = true; render();
    $('#bc-status').textContent = 'Connecting…';
    audio.src = url;
    try {
      await audio.play();
      $('#bc-status').textContent = '✔ Your station is live';
    } catch {
      $('#bc-status').textContent = '✖ No audio. Is BUTT connected and Spotify playing into CABLE Input?';
      stopTest();
    }
  });
  audio.addEventListener('error', () => {
    if (!testing) return;
    $('#bc-status').textContent = '✖ Stream not reachable. Is BUTT connected (▶ pressed)?';
    stopTest();
  });

  // checklist with saved ticks
  const boxes = [...document.querySelectorAll('#bc-steps input[type=checkbox]')];
  const done = get('steps', []);
  function updateProgress() {
    const n = boxes.filter((b) => b.checked).length;
    $('#bc-progress').textContent = `${n}/${boxes.length}`;
    boxes.forEach((b) => b.closest('li').classList.toggle('done', b.checked));
  }
  boxes.forEach((b, i) => {
    b.checked = !!done[i];
    b.addEventListener('change', () => { set('steps', boxes.map((x) => x.checked)); updateProgress(); });
  });
  updateProgress();
  // open the guide until setup is done
  $('#bc-guide').open = !url || boxes.some((b) => !b.checked);

  render();
})();
