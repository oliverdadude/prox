import { handleUpload } from '@vercel/blob/client';
import { passwordOk, json } from './_auth.js';

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB per song

// Issues short-lived upload tokens so the browser can send the mp3 straight
// to Vercel Blob (bigger than a normal function request could carry).
export async function POST(request) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  try {
    const result = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        let password = '';
        try { password = JSON.parse(clientPayload || '{}').password; } catch { /* ignore */ }
        if (!passwordOk(password)) throw new Error('Wrong upload password');
        if (!/^mp3\/[^/]+\.mp3$/i.test(pathname)) throw new Error('Only .mp3 files can be uploaded');
        return {
          allowedContentTypes: ['audio/mpeg', 'audio/mp3'],
          maximumSizeInBytes: MAX_BYTES,
          addRandomSuffix: true,
        };
      },
    });
    return json(result);
  } catch (e) {
    const msg = e?.message || 'Upload failed';
    return json({ error: msg }, /password/i.test(msg) ? 401 : 400);
  }
}
