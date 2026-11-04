import { timingSafeEqual } from 'node:crypto';

// Only people who know UPLOAD_PASSWORD (set in the Vercel project's
// environment variables) can upload, list or delete files.
export function passwordOk(given) {
  const expected = process.env.UPLOAD_PASSWORD || '';
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const json = (data, status = 200) => Response.json(data, { status });
