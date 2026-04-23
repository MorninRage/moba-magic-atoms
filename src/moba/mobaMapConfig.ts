/**
 * MOBA map v0 — layout constants. Lobby `OnlineLaunchSession.seed` lives in
 * `GameStore.state.onlineSession.seed` for future deterministic placement.
 */
export const MOBA_MAP_V0 = {
  /** Rough spawn offset from world origin for team 0 (mirror for team 1 later). */
  team0SpawnXZ: { x: -6, z: 4 },
} as const;
