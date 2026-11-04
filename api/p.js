import { head } from '@vercel/blob';

// GET /p/<id>.pls -> one-entry PLS playlist pointing at the saved audio link.
export async function GET(request) {
  const id = new URL(request.url).searchParams.get('id') || '';
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
  const body = `[playlist]\nNumberOfEntries=1\nFile1=${target}\nTitle1=GMod Radio\nLength1=-1\nVersion=2\n`;
  return new Response(body, {
    headers: { 'Content-Type': 'audio/x-scpls', 'Cache-Control': 'public, max-age=3600, s-maxage=31536000' },
  });
}
