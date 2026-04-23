# Vanguard wizard — in-game LPCA blueprint (build-ready)

**Purpose:** Turn [`VANGUARD_WIZARD_SCHEMATIC.md`](VANGUARD_WIZARD_SCHEMATIC.md) into **exact build math**, **orientation rules**, and a **deep layer list** so the first mold pass is accurate — fewer blind iteration loops.  
**Audience:** Implementer in `src/visual/` + anyone touching [`characterScenePreview.ts`](../src/visual/characterScenePreview.ts) / [`dockCharacterMotion.ts`](../src/data/dockCharacterMotion.ts).  
**Method alignment:** IDLE [`LPCA_IDLE_CRAFT_REFERENCE.md`](LPCA_IDLE_CRAFT_REFERENCE.md); dock rig [`DOCK_HERO_FIGURE_BLUEPRINT.md`](DOCK_HERO_FIGURE_BLUEPRINT.md); GoE `LPCA_UNIFIED_PIPELINE.md` / `LPCA_METHOD.md` (**Orientation Blueprint** = map each part’s default normal vs desired world direction **before** placement code).

---

## 1. Canonical constants (lock these first in code)

| Symbol | Value | Derivation |
|--------|-------|------------|
| **H** | **0.248 u** | Total figure ~**1.80 u** ÷ **7.25 heads** (sage elder read). All vertical spacing can be expressed as **k·H** to stay internally consistent. |
| **Sole Y** | **-0.14** | Dock parity ([`DOCK_HERO_FIGURE_BLUEPRINT.md`](DOCK_HERO_FIGURE_BLUEPRINT.md)). |
| **Sole Z** | **+0.05** | Dock parity; **+Z = forward**. |
| **Head root Y** (above `torso` origin) | **~0.398 u** | Existing dock stack — keep unless full rig retune. |
| **Cranium radius baseline** | **~0.11 u** | Dock blueprint head unit. |
| **Staff length** | **1.48 u** | Mid of schematic range **1.42–1.52**. |
| **Staff grip height** (world, sole at 0) | **0.91 u** | Mid of **0.88–0.95**. |
| **Hood rise above skull apex** | **0.13 u** | Mid of **0.10–0.16**. |
| **Hood opening rim inset** | **0.22 u** | Mid of **0.18–0.26** (face + beard clearance). |

**Preset scale:** [`characterPresets.ts`](../src/data/characterPresets.ts) `vanguard` uses `avatarScale` **1.045**, `torsoScale` / `headScale` — apply **after** this blueprint’s **local** rig geometry unless you intentionally bake scale into profiles.

---

## 2. Proportion ladder (landmarks in world space, soles on y = 0)

Use this table to **place pivots** and **check screenshots** without guessing.

| Landmark | Approx. y (u) | As multiple of H |
|----------|---------------|------------------|
| Ground / sole contact | 0 | 0 |
| Ankle pivot | ~0.10 | ~0.4H |
| Knee | ~0.55 | ~2.2H |
| Hip / torso origin reference | ~0.95 | ~3.8H |
| Navel / belt line | ~1.05 | ~4.2H |
| Sternum / cloak pin | ~1.25 | ~5.0H |
| Shoulder pivot | ~1.40 | ~5.6H |
| Base of neck (torso top) | ~1.43 | ~5.8H |
| Chin (headRoot local stack) | ~1.65 | ~6.7H |
| Brow | ~1.78 | ~7.2H |
| Skull apex | ~1.82 | ~7.3H |
| Hood peak | ~1.95 | ~7.9H |
| Staff upper tip (idle, vertical-ish) | ~2.05–2.15 | — |

*Numbers are targets for **mold v1**; tweak only with a single “global body offset” if feet drift after peer grounding.*

---

## 3. Orientation blueprint (reduce preventable iteration)

GoE **`LPCA_METHOD.md` §8.1** lesson: **before** writing placement code, decide **each mesh family’s default extrusion/lathe axis** vs **desired world direction**. For the dock, **locomotion +Z = forward**, **+Y = up**.

| Build block | Primitive / pattern | Default “out” or sweep | World intent | Typical fix |
|-------------|----------------------|------------------------|--------------|-------------|
| Boot / foot box | `BoxGeometry` | Face normals ±X,±Y,±Z | Toe toward **+Z** | Rotate box or mirror Z verts; verify sole line coplanar with ground |
| Torso / robe lathe | `LatheGeometry` | Spun in **XZ**, seam on +X | Front bulk slightly **+Z** | After `add`, `rotateY` whole group or bias profile Z in next layer |
| Robe panel / mantle | `ExtrudeGeometry` | Extrude along **+Z** of shape | Panel hangs **down −Y**, faces camera on **+Z** | Build shape in XY, extrude depth, then `rotateX(-π/2)` or compose with `lookAt` logic |
| Hood outer cowl | `LatheGeometry` (partial) or swept surface | Axis **+Y** | Opening faces **forward-down** toward viewer | Trim φ range; tilt group **small +X** (~0.08–0.12 rad) for “looking out” read |
| Hood rim | `TorusGeometry` / thin `ExtrudeGeometry` | Ring in XY | Rim normal roughly **+Z** toward camera | Parent to `headRoot`, inherit head sway |
| Beard sheet | `ExtrudeGeometry` thin | Thickness **+Z** local | Drape **−Y** in front of chest | Rotate; avoid z-fighting with robe (offset **0.002–0.005** along normal) |
| Beard braid | `TubeGeometry` | Curve tangent | Follows gravity + slight **+Z** sweep | CatmullRom: chin → mid-chest → lateral flare |
| Staff shaft | `CylinderGeometry` | Axis **+Y** | Shaft from hand to sky **+Y** in hand-local | Child of `handR`: `rotateZ` ~0.35–0.55 rad so tip clears hood in orbit |
| Finial | `LatheGeometry` / `SphereGeometry` | On staff top | Reads at silhouette | One emissive-capable mesh |

**Boot / sole rule (GoE + dock):** Phantom Operator doc lesson — if toe points wrong, **negate Z** on boot pieces and flip toe cap **X-rotation** sign. Re-verify **every** footwear mesh after first screenshot.

---

## 4. Micro-layer stack (many layers — build bottom → top)

Each row is a **named LPCA stratum** (Phantom Operator–style discipline). **Merge** only within a material bucket after IDs are stable; use `mesh.name` + `userData.lpcaId` for peer-safe palette.

### 4.1 Foundation / body (under robes)

| # | Layer id | Content | Material bucket |
|---|----------|---------|-----------------|
| L01 | `root_torso` | `torso` animated group | — |
| L02 | `hip_mass` | Optional lathe hip pad (elder) | `robe_outer` or `undertunic` |
| L03 | `leg_L_thigh` | Upper leg volume | `pants` |
| L04 | `leg_L_calf` | Lower leg | `pants` |
| L05 | `foot_L_boot` | Shaft, sole, toe (Z-forward verified) | `boot` |
| L06 | `leg_R_thigh` | Mirror | `pants` |
| L07 | `leg_R_calf` | Mirror | `pants` |
| L08 | `foot_R_boot` | Mirror | `boot` |

### 4.2 Garment core

| # | Layer id | Content | Material bucket |
|---|----------|---------|-----------------|
| L09 | `skirt_inner` | Inner robe lathe from hip down | `undertunic` |
| L10 | `undertunic` | Chest/back visible lathe | `undertunic` |
| L11 | `sash_waist` | Rope or wide belt base | `trim` / `leather` |
| L12 | `buckle` | Box + bevel | `metal_trim` |
| L13 | `robe_inner_drape` | Thin second shell for depth | `undertunic` (darker) |
| L14 | `robe_outer_main` | Primary mantle lathe or panels | `jerkin` / wizard outer |
| L15 | `robe_shoulder_L` | Shoulder fold panel | `jerkin` |
| L16 | `robe_shoulder_R` | Mirror | `jerkin` |
| L17 | `cloak_collar` | Back/neck rise connecting to hood | `jerkin` |
| L18 | `sleeve_L_upper` | Upper arm cloth | `jerkin` |
| L19 | `sleeve_L_fore` | Forearm + cuff | `jerkin` |
| L20 | `sleeve_R_upper` | Mirror | `jerkin` |
| L21 | `sleeve_R_fore` | Mirror (staff clears cuff) | `jerkin` |

### 4.3 Hands / head / beard / hood

| # | Layer id | Content | Material bucket |
|---|----------|---------|-----------------|
| L22 | `hand_L` | Aged knuckles, palm | `skin` |
| L23 | `hand_R` | Grip-ready; staff attach child | `skin` |
| L24 | `cranium` | Elder lathe skull read | `skin` |
| L25 | `jaw_chin` | Heavier chin/jowl | `skin` |
| L26 | `brow_ridge` | Box/lathe | `skin` |
| L27 | `nose` | Simple wedge/lathe | `skin` |
| L28 | `mustache` | Optional thin tube strip | `hair` |
| L29 | `beard_core` | Main chin/cheek mass | `hair` |
| L30 | `beard_lock_L` | Tube braid | `hair` |
| L31 | `beard_lock_R` | Mirror | `hair` |
| L32 | `beard_center_braid` | Central tube to chest | `hair` |
| L33 | `beard_chest_spread` | Extrude sheet taper | `hair` |
| L34 | `hood_outer` | Main cowl shell | `jerkin` / `hood_outer` |
| L35 | `hood_inner` | Lining (lighter) | `undertunic` |
| L36 | `hood_rim` | Welt / edge | `trim` |
| L37 | `hood_trim` | Thin metal or embroidery strip | `metal_trim` |

### 4.4 Staff / VFX hooks

| # | Layer id | Content | Material bucket |
|---|----------|---------|-----------------|
| L38 | `staff_shaft` | Taper cylinder/lathe | `staff_wood` |
| L39 | `staff_ferrule_lower` | Metal ring | `metal_trim` |
| L40 | `staff_finial_base` | Lathe transition | `staff_gem` |
| L41 | `staff_finial_core` | Gem / orb core | `staff_gem` (emissive-capable) |
| L42 | `staff_finial_crown` | Optional ring stack | `metal_trim` |

**Total named strata:** **42** (can split further for competition polish; e.g. split `robe_outer_main` into front/back for asymmetric fold).

---

## 5. Motion contract (dock language — do not break silently)

**Rig consumed by motion:** [`DockIdlePoseRig`](../src/data/dockCharacterMotion.ts) — `torso`, `headRoot`, `armL`, `armR` only. No `hand*` in sway; **hands inherit** arm rotations.

| Mechanism | Behavior |
|-----------|----------|
| `applyDockIdleBodyLayer` | Adds **sin** on `headRoot.rotation.x`, `torso.rotation.z`, and **both arms** `rotation.x`. |
| `applyDockPageAmbient` | **Per-page** offsets: e.g. `hire` uses **large** `armR.rotation.x` (~−0.42); `battle` similar. |
| **Staff** | Child of `handR` (or lower forearm group if you add one — then motion must target that chain consistently). |

**Wizard-specific risk:** Heavy `armR` down-angle + long staff can **intersect hood or beard** on **hire / battle / decks**. Mitigations (pick in implementation, not ambiguous):

1. **Geometry:** Staff local **rotateZ** + slight **translate** in hand so tip arcs **forward** of face.  
2. **Motion:** Optional `vanguard_wizard` branch in `dockCharacterMotion.ts` that **scales** `armR` extremes by **0.85–0.92** for pages where staff is visible.  
3. **Visibility:** Existing [`updateVanguardWizardAttachmentVisibility`](../src/visual/characterScenePreview.ts) hides staff when another prop occupies hand — preserve that contract.

**Hood / beard:** Parent hood to **`headRoot`** so it follows `headRoot.rotation.x` sway; beard on `headRoot` or child of chin group that inherits head — **avoid** skinning beard to `torso` only or it will shear against hood.

---

## 6. Integration graph (preview expectations)

Until refactor lands, legacy names may remain in TS (`vanguardWizardHatRoot` → **repurpose as hood root** or alias). Target logical roots:

| Root group | Holds |
|------------|--------|
| `vanguardWizardRobeRoot` | L09–L21 (+ belt) |
| `vanguardWizardHoodRoot` (rename from Hat) | L34–L37 |
| `vanguardWizardStaffRoot` | L38–L42 |
| Beard | Under `headRoot` or dedicated `beardRoot` child of `headRoot` |

**Orb VFX:** [`vanguardStaffOrbVfx`](../src/visual/vanguardStaffOrbVfx.ts) — keep **staff tip** anchor stable when replacing finial mesh (same world offset or named attach empty).

---

## 7. Pre-build checklist (cut iteration — from unified pipeline + dock lessons)

Complete **before** first full-scene compile:

- [ ] **Schematic v0.2** locks read (hood, long beard, staff right, no train).  
- [ ] **H** and landmark table pasted into factory header comment.  
- [ ] **Orientation table** verified for **boot Z**, **robe extrude**, **hood opening**, **staff axis**.  
- [ ] **+Z forward** pass on footwear + staff tip.  
- [ ] **`mesh.name` + `userData.lpcaId`** on every palette-driven mesh (peer safety).  
- [ ] **Merge plan** written: which layers share `robe_outer` / `hair` / `metal_trim` buckets.  
- [ ] **Motion pass:** idle + hire + battle screenshots with staff — no hood clip.  
- [ ] **Grounding:** `relevelAvatarFeet` / bbox min Y still valid after hood (hood must not affect foot bbox if possible — keep wide volumes above waist).

---

## 8. Changelog

| Ver | Date | Notes |
|-----|------|--------|
| 0.1 | 2026-04-16 | Initial ingame blueprint: constants, landmarks, orientation, 42 micro-layers, motion + integration + checklist. |
