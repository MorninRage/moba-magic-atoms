/**
 * Tiny synchronous stub for the system menu module.
 *
 * The real `./systemMenu.ts` module pulls in:
 *   - `system-menu-bg.webp` (~92 KB image asset, fetched as soon as the module loads)
 *   - The graphics + lighting + audio panels (large UI surfaces)
 *   - The FPS monitor UI hookup
 *
 * None of that is needed for the title screen's first paint. To keep the boot
 * bundle small for Vibe Jam 2026's "instant entry" target, the real systemMenu
 * is dynamic-imported lazily (rIC after first paint, or first ESC press). But
 * other modules — `mountApp.ts` (camera registration), `mountTutorial.ts`
 * (programmatic ESC open) — call into systemMenu APIs SYNCHRONOUSLY. This stub
 * captures those calls and replays them once the real module loads.
 *
 * Usage:
 *   - Other modules import the stub functions instead of the real systemMenu:
 *       `import { registerCharacterCameraForSystemMenu } from './systemMenuStub'`
 *   - The lazy installer in `main.ts` imports the real systemMenu, then calls
 *     `bindRealSystemMenu(...)` to wire the deferred state through.
 */
import type { OpenCampSystemMenuOpts } from './systemMenu';

type RegisterFn = (fn: (() => void) | null) => void;
type OpenFn = (opts?: OpenCampSystemMenuOpts) => void;

let realRegister: RegisterFn | null = null;
let realOpen: OpenFn | null = null;
/* `pendingRegister` uses a sentinel object (`UNSET`) so we can tell "never set"
 * apart from "explicitly set to null" (the latter is a valid clear-the-camera
 * call from `returnToTitle`). */
const UNSET = Symbol('unset');
let pendingRegister: ((() => void) | null) | typeof UNSET = UNSET;
let pendingOpenOpts: OpenCampSystemMenuOpts | undefined | typeof UNSET = UNSET;

export function registerCharacterCameraForSystemMenu(fn: (() => void) | null): void {
  if (realRegister) {
    realRegister(fn);
  } else {
    pendingRegister = fn;
  }
}

export function openCampSystemMenu(opts?: OpenCampSystemMenuOpts): void {
  if (realOpen) {
    realOpen(opts);
  } else {
    pendingOpenOpts = opts;
  }
}

/** Called by `main.ts` once the real systemMenu module has finished installing. */
export function bindRealSystemMenu(real: { register: RegisterFn; open: OpenFn }): void {
  realRegister = real.register;
  realOpen = real.open;
  if (pendingRegister !== UNSET) {
    real.register(pendingRegister);
    pendingRegister = UNSET;
  }
  if (pendingOpenOpts !== UNSET) {
    real.open(pendingOpenOpts);
    pendingOpenOpts = UNSET;
  }
}
