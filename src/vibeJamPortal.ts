/**
 * Vibe Jam 2026 — official portal webring (optional feature).
 * @see https://vibej.am/2026 — section "PORTALS (OPTIONAL)"
 *
 * Exit: redirect to the hub; it picks the next game and adds ?portal=true to the destination.
 * Params we forward: ref, username, color, speed, hp (all optional except we always send ref).
 */

export const VIBEJAM_PORTAL_HUB_2026 = 'https://vibej.am/portal/2026';

export type VibeJamPortalExitParams = {
  /** Where the player started — jam uses this for return portals. Prefer host, e.g. mygame.netlify.app */
  ref: string;
  username?: string;
  color?: string;
  speed?: number;
  hp?: number;
};

export function buildVibeJamPortalExitUrl(params: VibeJamPortalExitParams): string {
  const u = new URL(VIBEJAM_PORTAL_HUB_2026);
  u.searchParams.set('ref', params.ref);
  if (params.username) u.searchParams.set('username', params.username);
  if (params.color) u.searchParams.set('color', params.color);
  if (params.speed != null && Number.isFinite(params.speed)) {
    u.searchParams.set('speed', String(params.speed));
  }
  if (params.hp != null && Number.isFinite(params.hp)) {
    u.searchParams.set('hp', String(Math.max(1, Math.min(100, Math.round(params.hp)))));
  }
  return u.toString();
}

/** Call on boot: detects ?portal=true from the hub / previous game. */
export function applyVibeJamPortalArrivalClass(): void {
  const p = new URLSearchParams(window.location.search);
  if (p.get('portal') === 'true') {
    document.body.classList.add('vibejam-from-portal');
  }
}
