import { storage } from './station.js';
import { plsFor } from './_stations.js';

// GET /r/<id>.pls -> playlist pointing at the station's current stream address
export async function GET(request) {
  const id = new URL(request.url).searchParams.get('id') || '';
  const rec = /^[0-9A-Za-z]{8}$/.test(id) ? await storage.read(id) : null;
  if (!rec?.url) return new Response('Station not found\n', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  return new Response(plsFor(rec.url), {
    headers: { 'Content-Type': 'audio/x-scpls', 'Cache-Control': 'no-store' },
  });
}
