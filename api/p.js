import { head } from '@vercel/blob';

// GET /p/<id>.pls -> one-entry PLS playlist pointing at the saved audio link.
// GET /p/<id>.mp3 -> redirect straight to the saved mp3 file.
export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const id = params.get('id') || '';
  const asFile = params.get('fmt') === 'mp3';
  const notFound = () => new Response('Link not found\n', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  if (!/^[0-9A-Za-z]{6}$/.test(id)) return notFound();
  let target;
  try {
    const meta = await head(`links/${id}.txt`);
    const res = await fetch(meta.url);
    if (!res.ok) return notFound();
    target = (await res.text()).trim();
    if (!/^https?:\/\/\S+$/.test(target)) return notFound();
  } catch {
    return notFound();
  }
  if (asFile) return Response.redirect(target, 302);
  const body = `[playlist]\nNumberOfEntries=1\nFile1=${target}\nTitle1=GMod Radio\nLength1=-1\nVersion=2\n`;
  return new Response(body, {
    headers: { 'Content-Type': 'audio/x-scpls', 'Cache-Control': 'public, max-age=3600, s-maxage=31536000' },
  });
}
