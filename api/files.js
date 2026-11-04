import { list, del } from '@vercel/blob';
import { passwordOk, json } from './_auth.js';

// GET  /api/files  (header x-upload-password)  -> your uploaded mp3s
export async function GET(request) {
  if (!passwordOk(request.headers.get('x-upload-password'))) return json({ error: 'Wrong upload password' }, 401);
  const files = [];
  let cursor;
  do {
    const page = await list({ prefix: 'mp3/', cursor, limit: 1000 });
    files.push(...page.blobs.map((b) => ({ url: b.url, pathname: b.pathname, size: b.size, uploadedAt: b.uploadedAt })));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  files.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  return json({ files });
}

// DELETE /api/files  { url }  (header x-upload-password)
export async function DELETE(request) {
  if (!passwordOk(request.headers.get('x-upload-password'))) return json({ error: 'Wrong upload password' }, 401);
  let url;
  try { ({ url } = await request.json()); } catch { /* ignore */ }
  if (typeof url !== 'string' || !/\.blob\.vercel-storage\.com\/mp3\//.test(url)) return json({ error: 'Bad file' }, 400);
  await del(url);
  return json({ ok: true });
}
