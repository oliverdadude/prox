// /d/<base64url-of-blob-url>.mp3 -> redirect to the Blob file with
// "download=1", so it's served as a file download (Content-Disposition:
// attachment) while the link itself still ends in .mp3.
export function GET(request) {
  const id = new URL(request.url).searchParams.get('id') || '';
  let target;
  try {
    target = new URL(Buffer.from(id, 'base64url').toString('utf8'));
    if (target.protocol !== 'https:' || !target.hostname.endsWith('.public.blob.vercel-storage.com')) throw new Error();
  } catch {
    return new Response('Invalid link\n', { status: 400, headers: { 'Content-Type': 'text/plain' } });
  }
  target.searchParams.set('download', '1');
  return Response.redirect(target.toString(), 302);
}
