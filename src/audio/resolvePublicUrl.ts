/**
 * Resolve `/audio/...` paths from the manifest for `fetch()`.
 * Uses `new URL(path, window.location.href)` so `file://` (Electron), dev server, and subpath
 * deploys all resolve to the folder that contains `index.html`.
 */
export function resolvePublicAudioUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const tail = path.replace(/^\/+/, '');

  if (typeof window !== 'undefined' && window.location?.href) {
    try {
      return new URL(tail, window.location.href).href;
    } catch {
      /* fall through */
    }
  }

  const base = import.meta.env.BASE_URL ?? '/';
  if (base === '/' || base === '') return `/${tail}`;
  if (base.endsWith('/')) return `${base}${tail}`;
  return `${base}/${tail}`;
}
