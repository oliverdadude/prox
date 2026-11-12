import { createHash, randomBytes } from 'node:crypto';

// Permanent radio links whose target can be changed later by whoever holds the key.
// The Radio Relay app uses this: its public tunnel address changes every start,
// but the link pasted into GMod (/r/<id>.pls) stays the same.

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const sha = (s) => createHash('sha256').update(s).digest('hex');

export function newId() {
  return [...randomBytes(8)].map((b) => ALPHABET[b % 62]).join('').slice(0, 8);
}

export function validTarget(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && url.length <= 2000 && !/[\r\n]/.test(url);
  } catch { return false; }
}

/** storage: { read(id) -> {keyHash,url}|null, write(id, record) } */
export async function upsertStation(storage, { id, key, url }) {
  if (!validTarget(url)) return { status: 400, body: { error: 'Not a valid stream URL' } };
  if (!id) {
    const newKey = randomBytes(24).toString('hex');
    const newStationId = newId();
    await storage.write(newStationId, { keyHash: sha(newKey), url });
    return { status: 200, body: { id: newStationId, key: newKey } };
  }
  if (!/^[0-9A-Za-z]{8}$/.test(id) || typeof key !== 'string') return { status: 400, body: { error: 'Bad station' } };
  const rec = await storage.read(id);
  if (!rec) return { status: 404, body: { error: 'Station not found' } };
  if (rec.keyHash !== sha(key)) return { status: 403, body: { error: 'Wrong station key' } };
  await storage.write(id, { keyHash: rec.keyHash, url });
  return { status: 200, body: { id } };
}

export function plsFor(url) {
  return `[playlist]\nNumberOfEntries=1\nFile1=${url}\nTitle1=Radio Relay\nLength1=-1\nVersion=2\n`;
}
