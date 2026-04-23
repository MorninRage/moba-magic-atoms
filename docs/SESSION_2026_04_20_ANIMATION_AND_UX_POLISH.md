# Session 2026-04-20 — Animation Smoothing + Harvest Picker + Controls Popup

## Context

Companion to **`docs/SESSION_2026_04_20_PRELOAD_OPTIMIZATION.md`** (the morning's boot-performance + ghost-mesh fix work). This doc covers the afternoon/evening pass: animation smoothing, harvest UX, and the Esc-menu Controls reference refactor.

Single overarching theme: **make every state transition smooth — no snaps, no leaps, no surprises**.

---

## 1. Walk-pose smooth fade (awakened mode)

### Problem

Player reported "after walking, I stop and ~1 second later the avatar snaps to a resting position — shoulders shift, torso shifts back." The shift was a real ~5° change per shoulder happening on a delay.

### Root cause

The awakened walk-cycle pose block in `applyIdle` (in `src/visual/characterScenePreview.ts`) used a hard `if (awakenedSpeed > 0.2)` gate. The block ASSIGNED limb rotations like `armL.rotation.z = 0.1` (overriding whatever the page-ambient layer had set, e.g. 0.1 for 'gather'). My initial fade attempt scaled by `amp`, so as amp decayed past 0.001 (~1 second after stop) the block stopped running and `arm.z` jumped from `~0` (last fade frame) to whatever the page-ambient layer had already set (e.g. 0.1 again). That jump was the visible "snap to rest after a delay."

### Fix

Two-part solution:

1. **`awakenedWalkAmp` smoothing field** in `tickAwakenedFootsteps` — a 0..1 amplitude that exponentially eases toward `smoothstep(speed, 0.05, 1.5)` with rate ≈ 12 (≈190ms time constant). Replaces the hard `> 0.2` threshold with a continuous fade. Press W → amp grows 0→1 over ~190ms; release W → amp decays 1→0 symmetrically. Applies to both walk start AND stop.

2. **Blend FROM the underlying rest value**, not assignment scaled by amp:
   ```
   const restArmLZ = this.armL.rotation.z;  // page-ambient already wrote this
   this.armL.rotation.z = restArmLZ + (0.1 - restArmLZ) * amp;
   ```
   At amp=1: arm.z = 0.1 (full walk pose, unchanged from before).
   At amp=0: arm.z = whatever page-ambient set it to (no jump waiting to happen).
   At any in-between: smooth lerp between the two.

Same blend pattern applied to `torso.rotation.z`. Limbs that have NO underlying rest value (legs, head x-bob, torso bob-y where `resetPose` sets them to 0/baseTorsoY) keep the simpler `walkValue * amp` form because amp=0 → walkValue=0 → matches rest=0 → no snap.

### Files

- `src/visual/characterScenePreview.ts`:
  - New field: `awakenedWalkAmp: number = 0`
  - `tickAwakenedFootsteps` smooths amp toward `smoothstep(speed, 0.05, 1.5)` every frame (rate ≈ 12, dt-clamped)
  - Walk-cycle block in `applyIdle` gated on `awakenedWalkAmp > 0.001` instead of `awakenedSpeed > 0.2`
  - Arm-z + torso-z values use `lerp(rest, walk, amp)` blend pattern
  - Legacy `awakenedSpeed` field deleted (replaced by amp)

### Result

Avatar smoothly fades into stride on press, smoothly fades out on release. No "delayed shift" 1 second after stopping. Same effect on transitions FROM the dock-route walk pose into idle.

---

## 2. Post-clip pose blend (harvest → idle)

### Problem

Player reported "going from harvesting animations to idle pose there is a giant leap." When a chop / mine / pluck clip ended (with my new fast 0.55s in-place duration), the avatar's arms were mid-pose (axe overhead, bucket dipped, pickaxe arc) and the very next frame `applyIdle` snapped them to neutral. A ~60-90° arm jump in one frame.

### Root cause

Same shape as #1, different layer. The clip-end branch in `loop()` flips `clip = 'idle'`, then immediately calls `applyIdle(dt)`. `applyIdle` calls `resetPose()` (zeros all limbs) + `applyDockIdleBodyLayer` (small breathing values). The held harvest pose values are wiped instantly. No blending.

### Fix

Snapshot-and-fade: at the moment a clip ends (just before the first `applyIdle(dt)` call of the new idle window), capture the current limb pose into a `postClipCaptured` typed object + start a `postClipBlendT = 0` timer. Then at the end of every `applyIdle` frame, blend the displayed pose back from the snapshot toward the live computed pose:

```ts
const w = 1 - smoothstep(progress);  // captured weight: 1 → 0 over BLEND_DURATION
this.armL.rotation.x += (c.armLRotX - this.armL.rotation.x) * w;
// ...19 other limb dimensions
```

Smoothstep S-curve: held pose lingers briefly (~50ms), middle transitions quickly, settle into idle is gentle (~250ms). Total blend window: 300ms (`POST_CLIP_BLEND_DURATION_SEC`). Captures + blends 19 separate limb dimensions (torso pos.y + rot xyz, head rot xyz, both arms rot xyz, both legs rot xyz).

### Files

- `src/visual/characterScenePreview.ts`:
  - New constant: `POST_CLIP_BLEND_DURATION_SEC = 0.30`
  - New fields: `postClipBlendT: number = -1`, `postClipCaptured: { ... }` typed bag
  - New method: `captureCurrentPoseForPostClipBlend()`
  - At clip-end branch (~line 6710): captures + sets `postClipBlendT = 0`
  - At end of `applyIdle`: blend pass writes `current += (captured - current) * w`

### Result

Harvest swing now reads as a smooth settle into rest. No visible "axe overhead → neutral" leap.

---

## 3. Harvest swing timing — fixed wall-clock target

### Problem

Player: "the character animation loop for harvesting is taking too long." Each in-place harvest swing took ~1.45-1.75s wall-clock time before the player could fire the next press → pacing felt sluggish.

### Root cause

The in-place clip boost was a fixed `1 / (TR_WORK - TR_WALK1)` ≈ 2.94×, which mapped a 5.15s `wood` clip to ~1.75s wall-clock, a 4.25s `mine` clip to ~1.45s, etc. The boost made the work motion play at "natural pacing" but didn't actually shorten the perceived loop because the underlying clips are long.

### Fix

Replace the fixed-multiplier boost with a fixed-wall-clock target:

```ts
const IN_PLACE_HARVEST_TARGET_SEC = 0.55;
const inPlaceBoost = this.inPlaceHarvestActive
  ? dur / IN_PLACE_HARVEST_TARGET_SEC
  : 1;
```

Now every harvest swing finishes in ~0.55s regardless of underlying clip duration. Matches the natural cadence of `battle_strike` (0.58s) so harvest mashing feels like combat mashing.

### Files

- `src/visual/characterScenePreview.ts`:
  - New constant: `IN_PLACE_HARVEST_TARGET_SEC = 0.55`
  - Replaced fixed `1 / (TR_WORK - TR_WALK1)` boost with `dur / IN_PLACE_HARVEST_TARGET_SEC`

### Tunable

If 0.55s feels too snappy or too slow:
- 0.45 = very snappy, almost combat-strike fast
- 0.55 = current
- 0.70 = deliberate but still well below the old 1.5s feel
- 0.85 = old-feel-but-faster

### Result

Player can mash E for satisfying chop/mine/pick cadence. Combined with #2 (post-clip blend), the loop feels: press → swing → smooth settle → press again, with no dead time and no visible reset.

---

## 4. Height-aware harvest picker

### Problem

Player: "we had a height detector so in an area the tallest would be chosen — that seems to have regressed."

The `DockForestHandle` interface comment in `src/world/dockForestBatchedScene.ts` advertised: *"Used by the height-aware harvest picker so `mountApp.ts` can walk all nodes inside a small radius around the reticle hit and prefer the tallest"* — but `mountApp.ts` actually called `getNodeNearAvatar(...)` which picked nearest by surface-distance only. Aiming at a thicket of ferns + bushes around an oak chopped a fern, not the oak. Plus a latent bug: the reticle path picked one node by reticle-XZ then dispatched a possibly-different node via `tryDockForestHit(ax, az)` (avatar XZ).

### Fix

Three-part:

1. **Surface height fields on the public node interface** — added `topYWorld: number` and `bottomY: number` to `DockForestHarvestNode`. The internal `ScatteredNode` already carried these for collision footprint registration; just exposed them.

2. **`pickTallestDockForestNodeNear` helper** in `mountApp.ts` — walks `dockForestHandle.nodes` once, applies up to two reach gates (pick-from-XZ + optional avatar-reach-gate), picks by max `topYWorld - bottomY`. Tiebreak (within 0.15m epsilon): nearest by surface distance to pick point. Allocation-free hot path.

3. **`dispatchDockForestHit(node)` shared helper** — single dispatch entry point so reticle and proximity paths emit identical SFX + chip yield + tool wear behavior. Eliminates the latent reticle-vs-avatar mismatch bug.

### Files

- `src/world/dockForestBatchedScene.ts`: added `topYWorld` + `bottomY` to `DockForestHarvestNode` interface
- `src/ui/mountApp.ts`:
  - New helper: `pickTallestDockForestNodeNear(pickXZ, pickRadius, avatarXZ | null, avatarReach)`
  - New helper: `dispatchDockForestHit(node)`
  - `tryDockForestHit(ax, az)` refactored to use the picker (proximity → tallest near avatar)
  - Reticle-locked dock-forest dispatch refactored to use the picker AND dispatch the picked node directly (fixes the latent bug)

### Behavior

| Situation | Before | After |
|---|---|---|
| Aim at thicket of ferns around tall oak | Chops nearest fern | **Chops the oak** |
| Press E (proximity) in moss patch with apple tree at edge | Chops nearest moss patch | **Chops the apple tree** if reachable |
| Aim at tall tree but standing in shrubs (avatar far from tree) | Picked tree, failed avatar-reach gate, no-op | Picker evaluates shorter REACHABLE candidates, chops the shrub the player can actually touch |
| Aim at giant oak standing right next to bark | Picks oak via reticle, validates reach, dispatches via avatar (could pick different node) | Picks oak, dispatches the oak directly — **bug fixed** |

---

## 5. Controls reference popup (UX refactor)

### Problem

Player: "Controls menu shouldn't be in the Esc panel — that should have a button that brings up a Controls popup. If we press Esc or close, we're still at the Esc menu."

The Controls reference was rendered INLINE inside the Esc menu panel, taking up vertical space and forcing the player to scroll past it to reach Performance / Audio / Lighting controls.

### Fix

Refactored `src/ui/systemMenuControlsPanel.ts` from inline panel to standalone popup:

- `wireControlsPanel(shell)` removed. Replaced by `installControlsPopup()` returning `{ open, close, isOpen, dispose }`.
- Popup mounts to `document.body` with its own backdrop, panel, and Esc handler. Lazy DOM mount on first `open()`.
- Re-uses `.system-menu` base CSS classes for visual chrome (backdrop, panel, btn) for free consistency. New `.controls-popup` modifier bumps z-index to 12100 (above parent menu's 12000) and widens panel to 560px so multi-word key bindings don't wrap.
- Popup's Esc handler uses `capture: true` + `stopImmediatePropagation()` so Esc dismisses just the popup, not the parent Esc menu.
- Closes return focus to the button that opened it (the Controls reference button in the Esc menu) → player lands back on the Esc menu, exactly where they came from.

In `src/ui/systemMenu.ts`:
- Removed `<div data-system-controls-block>` placeholder and `wireControlsPanel(shell)` call
- Added `<button data-system-controls-open>Controls reference</button>` in the actions row (next to Resume + Return to main menu)
- Wired button click to `controlsPopup.open()`

### Esc-key behavior matrix

| State | Press Esc → |
|---|---|
| Game world (no menu) | Opens Esc menu |
| Esc menu open, popup closed | Closes Esc menu (resumes game) |
| Esc menu open, popup open | **Closes popup only — Esc menu stays open** |
| Esc menu open, popup just closed, Esc again | Closes Esc menu (resumes game) |

### Files

- `src/ui/systemMenuControlsPanel.ts`: rewritten as `installControlsPopup()` factory
- `src/ui/systemMenu.ts`: button + popup install replacing inline panel
- `src/ui/systemMenu.css`: new `.controls-popup` + `.controls-popup__panel` + `.controls-popup__stack` + `.controls-popup__actions` modifier styles

---

## Outcome

- Walk start/stop transitions read as smooth fades, not snaps
- Harvest end transitions read as smooth settles, not leaps
- Harvest mash cadence is ~0.55s/swing, matches combat-strike rhythm
- Aiming at a cluster harvests the obvious target (tallest), not whichever shrub happened to be nearest the reticle pixel
- Esc menu is now compact + uncluttered; controls live in their own dedicated popup that doesn't unmount the menu when dismissed
- Type-check + lint clean
- Production build clean (~2.5s)
- Deployed to https://idle-craft1.netlify.app (commits `a72bc42` + `0d0b41e`)

## Test in browser

1. Walk WASD and stop — no shoulder/torso snap 1 second later
2. Chop a tree — swing finishes in ~0.55s, settles smoothly into idle (no axe-overhead leap)
3. Aim at a fern thicket near a tall tree, press E → chops the tree
4. Aim at moss patch alone, press E → chops the moss (height bracket isn't artificially raised)
5. Press Esc → click Controls reference → popup opens above menu
6. Press Esc inside popup → popup closes, Esc menu still open
7. Click backdrop outside popup panel → popup closes, Esc menu still open
8. Click Close button in popup → same
9. Press Esc again from Esc menu → game resumes (single Esc — popup is already gone)

## Files touched today (animation + UX pass)

| File | Lines | Purpose |
|---|---|---|
| `src/visual/characterScenePreview.ts` | ~80 | walk-pose fade, post-clip blend, harvest swing timing |
| `src/world/dockForestBatchedScene.ts` | ~10 | expose topYWorld + bottomY on public interface |
| `src/ui/mountApp.ts` | ~70 | height-aware picker + dispatch helper, reticle bug fix |
| `src/ui/systemMenuControlsPanel.ts` | full rewrite | inline panel → standalone popup |
| `src/ui/systemMenu.ts` | ~15 | controls button + popup install |
| `src/ui/systemMenu.css` | ~30 | .controls-popup modifier styles |

Plus the morning's preload work documented in **`SESSION_2026_04_20_PRELOAD_OPTIMIZATION.md`** (unified preload pipeline, scene-singleton handles, harvest broken-node Set tracking, AbortError fix, pointer-capture try/catch). All five of today's animation/UX changes layered cleanly on top of the morning's structural cleanup.
