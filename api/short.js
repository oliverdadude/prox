import { createHash } from 'node:crypto';
import { put } from '@vercel/blob';
import { json } from './_auth.js';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Same URL always gets the same 6-character id, so repeat copies are free.
function shortId(url) {
  let n = BigInt(`0x${createHash('sha256').update(url).digest('hex').slice(0, 16)}`);
  let id = '';
  for (let i = 0; i < 6; i++) { id += ALPHABET[Number(n % 62n)]; n /= 62n; }
  return id;
}

// POST /api/short { url } -> { link: "https://<site>/p/<id>.pls" }
// Some GMod radios reject long links, so every link the site hands out is a
// short .pls playlist on this domain that points at the real audio.
export async function POST(request) {
  let url;
  try { ({ url } = await request.json()); } catch { /* ignore */ }
  return shorten(request, url);
}

// GET /api/short?url=... does the same (handy for testing in a browser).
export function GET(request) {
  return shorten(request, new URL(request.url).searchParams.get('url'));
}

async function shorten(request, url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || url.length > 2000 || /[\r\n]/.test(url)) throw new Error();
  } catch {
    return json({ error: 'Not a valid audio link' }, 400);
  }
  const host = new URL(url).hostname.replace(/^www\.|^m\.|^music\./, '');
  if (/^(youtube\.com|youtu\.be|spotify\.com|open\.spotify\.com|soundcloud\.com)$/.test(host)) {
    return json({ error: "That's a YouTube/Spotify/SoundCloud page, not an audio file. The car radio can only play radio stations, your broadcast, or uploaded mp3s." }, 400);
  }
  const id = shortId(url);
  await put(`links/${id}.txt`, url, {
    access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'text/plain; charset=utf-8',
  });
  const origin = new URL(request.url).origin;
  // Single mp3 files get an .mp3 link (redirects to the file); streams get a .pls playlist.
  const ext = /\.mp3$/i.test(new URL(url).pathname) ? 'mp3' : 'pls';
  return json({ link: `${origin}/p/${id}.${ext}`, id });
}
