/**
 * Travel gather clips do heavy dock work (avatar + night magic + skydome). Craft hammer, walk-to-station,
 * and decor reveal similarly stack cost with twilight transitions — unify throttling via {@link isDockVisualLowBudget}.
 */
let dockTravelGatherClipActive = false;

/** Craft hammer, pending approach to station, or post-decor stagger — set from CharacterScenePreview each frame. */
let dockCraftVisualBusy = false;

export function setDockTravelGatherClipActive(active: boolean): void {
  dockTravelGatherClipActive = active;
}

export function isDockTravelGatherClipActive(): boolean {
  return dockTravelGatherClipActive;
}

export function setDockCraftVisualBusy(active: boolean): void {
  dockCraftVisualBusy = active;
}

/** True when gather travel, craft visuals, or approach/stagger should ease night-magic ramp / skydome (fairy swarm stays full). */
export function isDockVisualLowBudget(): boolean {
  return dockTravelGatherClipActive || dockCraftVisualBusy;
}
