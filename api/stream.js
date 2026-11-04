// Wraps any audio stream URL in a one-line playlist so radios that only accept
// links ending in .mp3 / .pls / .m3u will take it.
//   /s/<base64url-of-stream-url>.m3u   ->  #EXTM3U playlist
//   /s/<base64url-of-stream-url>.pls   ->  PLS playlist
export function GET(request) {
  const params = new URL(request.url).searchParams;
  const fmt = params.get('fmt') === 'pls' ? 'pls' : 'm3u';
  let target = '';
  try {
    target = Buffer.from(params.get('id') || '', 'base64url').toString('utf8');
    const u = new URL(target);
    if (!/^https?:$/.test(u.protocol) || target.length > 2000 || /[\r\n]/.test(target)) throw new Error();
  } catch {
    return new Response('Invalid stream link\n', { status: 400, headers: { 'Content-Type': 'text/plain' } });
  }
  const body = fmt === 'pls'
    ? `[playlist]\nNumberOfEntries=1\nFile1=${target}\nTitle1=GMod Radio\nLength1=-1\nVersion=2\n`
    : `#EXTM3U\n#EXTINF:-1,GMod Radio\n${target}\n`;
  return new Response(body, {
    headers: {
      'Content-Type': fmt === 'pls' ? 'audio/x-scpls' : 'audio/x-mpegurl',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
