import { ConfigSystem } from 'empire-engine/config';
import type { IdleEmpireProjectFile } from './fetchEmpireProject';

let configSingleton: ConfigSystem | null = null;

/** Shared engine config hydrated from `project.json` (and usable by future systems). */
export function getIdleCraftEmpireConfig(): ConfigSystem {
  if (!configSingleton) configSingleton = new ConfigSystem();
  return configSingleton;
}

/** Apply `project.config` to the shared {@link ConfigSystem} (flat + nested keys). */
export function hydrateEmpireConfigFromProject(project: IdleEmpireProjectFile | null): void {
  const cfg = project?.config;
  if (!cfg || typeof cfg !== 'object') return;
  getIdleCraftEmpireConfig().deserialize(cfg as Record<string, unknown>);
}
