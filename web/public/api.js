/** Small helpers for the web server's JSON API. */

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

/** The session ended (signed out elsewhere, or the token was replaced): back to the sign-in page. */
export function goToSignIn() {
  const here = location.pathname + location.search + location.hash;
  location.replace(`/login.html${here && here !== '/' ? `?next=${encodeURIComponent(here)}` : ''}`);
}

async function parse(res) {
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.signIn) goToSignIn();
  if (!res.ok) throw new ApiError(data.error || `HTTP ${res.status}`, res.status, data);
  return data;
}

export async function getJson(url, params) {
  const q = params ? `?${new URLSearchParams(Object.entries(params).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : v === undefined || v === null || v === false ? [] : [[k, v === true ? '1' : String(v)]]))).toString()}` : '';
  return parse(await fetch(url + q, { cache: 'no-store' }));
}

export async function postJson(url, body) {
  return parse(await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }));
}

/** A file manager job: polls until it finishes; resolves with its result, rejects with its error. */
export async function waitJob(job, onProgress) {
  let j = job;
  onProgress?.(j);
  while (j.state === 'running') {
    await new Promise((r) => setTimeout(r, 400));
    j = await getJson('/api/files/jobs', { id: j.id });
    onProgress?.(j);
  }
  if (j.state === 'done') return j.result;
  if (j.state === 'cancelled') throw new ApiError('Cancelled.', 499, j);
  throw new ApiError(j.error || 'The operation failed.', 500, j);
}

/** URL of a file's contents (inline, or as a download). */
export function rawUrl(path, download = false) {
  return `/api/files/raw?${new URLSearchParams({ path, ...(download ? { download: '1' } : {}) })}`;
}

export function zipUrl(paths) {
  return `/api/files/zip?${new URLSearchParams(paths.map((p) => ['path', p]))}`;
}
