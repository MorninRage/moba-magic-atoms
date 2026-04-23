/**
 * Browser loader for EmpireEditor project root (`/project.json`).
 */

export interface IdleEmpireProjectFile {
  name?: string;
  config?: Record<string, unknown>;
  /** 0–24 initial / frozen clock hour when `environment.hourPerRealSecond` is 0. */
  time?: number;
  weather?: { type?: string; intensity?: number };
  terrain?: unknown;
  hydrology?: unknown;
  environment?: unknown;
  /** Character / gather default camp position on dock terrain. */
  dock?: { homeX?: number; homeZ?: number };
  [key: string]: unknown;
}

/**
 * Module-level cache — the project file is immutable for a given deploy, so we share one
 * promise across callers (main bootstrap, dock preview, multiplayer stage, system menu panels).
 * Previously 2–4 parallel fetches happened on cold entry with `cache: 'no-store'` — visible
 * waste on the forging-veil loader.
 */
let projectPromise: Promise<IdleEmpireProjectFile | null> | null = null;

export async function fetchEmpireProject(): Promise<IdleEmpireProjectFile | null> {
  if (projectPromise) return projectPromise;
  projectPromise = (async () => {
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}project.json`, { cache: 'no-store' });
      if (!r.ok) return null;
      return (await r.json()) as IdleEmpireProjectFile;
    } catch {
      return null;
    }
  })();
  return projectPromise;
}

/**
 * Forget the cached project — used by the system menu when the user hot-edits settings
 * (tone mapping, renderer display) so the next read gets fresh JSON.
 */
export function invalidateEmpireProjectCache(): void {
  projectPromise = null;
}
