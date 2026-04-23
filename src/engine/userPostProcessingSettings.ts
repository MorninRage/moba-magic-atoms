/**
 * User overrides for post-processing (localStorage), merged on top of project.json + tier defaults.
 */

import type { PostProcessingStackOptions } from 'empire-engine/render/PostProcessingStack';

const PATCH_KEY = 'idleCraft.postProcessing.user';

export type UserPostProcessingPatch = Partial<PostProcessingStackOptions>;

const syncListeners: Array<() => void> = [];

export function registerPostProcessingSync(fn: () => void): () => void {
  syncListeners.push(fn);
  return () => {
    const i = syncListeners.indexOf(fn);
    if (i >= 0) syncListeners.splice(i, 1);
  };
}

export function notifyPostProcessingSettingsChanged(): void {
  for (const fn of syncListeners) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

export function readUserPostProcessingPatch(): UserPostProcessingPatch {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(PATCH_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as UserPostProcessingPatch) : {};
  } catch {
    return {};
  }
}

export function patchUserPostProcessing(updates: UserPostProcessingPatch): void {
  const cur = readUserPostProcessingPatch();
  const next = { ...cur, ...updates };
  try {
    localStorage.setItem(PATCH_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  notifyPostProcessingSettingsChanged();
}

export function clearUserPostProcessingPatch(): void {
  try {
    localStorage.removeItem(PATCH_KEY);
  } catch {
    /* ignore */
  }
  notifyPostProcessingSettingsChanged();
}

/** Replace entire Esc-menu override (e.g. GoE-style quality preset). */
export function replaceUserPostProcessingPatch(next: UserPostProcessingPatch): void {
  try {
    localStorage.setItem(PATCH_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  notifyPostProcessingSettingsChanged();
}
