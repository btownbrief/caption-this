// Supabase backend for CAPTION THIS (shared Btown Games project).
// Schema lives in supabase/schema.sql; the anon key below can only call
// the security-definer RPCs defined there, plus upload a jpeg to the
// caption-photos bucket. Same identity model as every Btown game: a random
// player id + secret token under shared btown-* localStorage keys, so
// caption authors' names match their arcade names.

const SUPABASE_URL = 'https://jnouvwxomrcffqwilqkq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_RkMJQopffWlV6DSwCRkndQ_Xw6GJMf3';

function stored(key, make) {
  let v = localStorage.getItem(key);
  if (!v) { v = make(); localStorage.setItem(key, v); }
  return v;
}
// shared "btown-" keys so all Btown games on this domain share one identity
export function playerId() {
  return stored('btown-player-id', () => crypto.randomUUID());
}
export function playerToken() {
  return stored('btown-player-token', () =>
    [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''));
}
export function getName() { return localStorage.getItem('btown-player-name') || ''; }
export function setName(n) { localStorage.setItem('btown-player-name', n.trim().slice(0, 20)); }

function baseHeaders(extra = {}) {
  const headers = { apikey: SUPABASE_ANON_KEY, ...extra };
  // legacy JWT-style anon keys also go in the Authorization header;
  // new sb_publishable_ keys must not (they aren't bearer tokens)
  if (SUPABASE_ANON_KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
  return headers;
}

export async function rpc(fn, args = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: baseHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    let msg = `${fn} failed: ${res.status}`;
    try { msg = (await res.json()).message || msg; } catch { /* keep default */ }
    throw new Error(msg);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export function photoUrl(storagePath) {
  return `${SUPABASE_URL}/storage/v1/object/public/caption-photos/${storagePath}`;
}

// Uploads a jpeg blob to the caption-photos bucket; returns its storage path.
export async function uploadPhoto(blob) {
  const path = `submissions/${crypto.randomUUID()}.jpg`;
  const doUpload = (headers) =>
    fetch(`${SUPABASE_URL}/storage/v1/object/caption-photos/${path}`, {
      method: 'POST',
      headers,
      body: blob,
    });
  let res = await doUpload(baseHeaders({ 'Content-Type': 'image/jpeg' }));
  if (res.status === 401 || res.status === 403) {
    // some storage gateways want the key as a bearer token as well
    res = await doUpload(baseHeaders({
      'Content-Type': 'image/jpeg',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    }));
  }
  if (!res.ok) {
    let msg = `upload failed: ${res.status}`;
    try { msg = (await res.json()).message || msg; } catch { /* keep default */ }
    throw new Error(msg);
  }
  return path;
}

// Client-side resize: longest edge ≤1600px, JPEG. Returns a Blob.
export async function resizeImage(file, maxDim = 1600, quality = 0.85) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('could not process that image');
  return blob;
}
