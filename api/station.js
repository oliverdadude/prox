import { put, head } from '@vercel/blob';
import { json } from './_auth.js';
import { upsertStation } from './_stations.js';

const storage = {
  async read(id) {
    try {
      const meta = await head(`stations/${id}.json`);
      // query string skips any cached copy so updates show up straight away
      const res = await fetch(`${meta.url}?t=${Date.now()}`, { cache: 'no-store' });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  },
  async write(id, record) {
    await put(`stations/${id}.json`, JSON.stringify(record), {
      access: 'public', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/json', cacheControlMaxAge: 60,
    });
  },
};
export { storage };

// POST /api/station { url }               -> create  { id, key, link }
// POST /api/station { id, key, url }      -> update  { id, link }
export async function POST(request) {
  let body = {};
  try { body = await request.json(); } catch { /* ignore */ }
  const { status, body: out } = await upsertStation(storage, body || {});
  if (status === 200) out.link = `${new URL(request.url).origin}/r/${out.id}.pls`;
  return json(out, status);
}
