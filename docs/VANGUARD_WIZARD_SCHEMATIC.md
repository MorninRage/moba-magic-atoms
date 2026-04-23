# Vanguard wizard — research schematic (draft v0.2)

**Status:** Draft — **design locks** in §6 approved; numbers still tunable during LPCA mold pass.  
**Archetype (IP-neutral):** Tall **elder sage mage** — layered robes, **deep hood** (primary silhouette), **long beard**, **staff** with strong finial read, believable anatomy under cloth, **gravitas** in dock orbit + thumbnail.  
**Companion intent:** [`VANGUARD_WIZARD_NEW_CHARACTER_HANDOFF.md`](VANGUARD_WIZARD_NEW_CHARACTER_HANDOFF.md)  
**Dock conventions:** [`DOCK_HERO_FIGURE_BLUEPRINT.md`](DOCK_HERO_FIGURE_BLUEPRINT.md) — Three.js units, **feet / locomotion +Z forward**, soles grounded at scene y = 0.  
**Build-ready math + 42 micro-layers + orientation + motion contract:** [`VANGUARD_WIZARD_INGAME_BLUEPRINT.md`](VANGUARD_WIZARD_INGAME_BLUEPRINT.md).

---

## 1. What research surfaced (summary)

### Elder / sage body (realism under robes)

- **Head-to-body:** Older adults are still often drawn in the **~6.5–7.5 heads** total range for heroes; “sage” reads well with a **slightly larger head read** (wisdom, age) — target **~7–7.25 heads** to eye level, not chibi.
- **Age reads:** Optional **mild forward shoulder / upper spine** (very subtle rotation on `torso`, not a hunchback) + **thinner forearm/wrist** and **knuckle definition** on hands; face: deeper nasolabial read, slightly heavier brow ridge — all LPCA boxes/lathes.
- **Sources consulted (method only):** General figure-drawing “proportions by age” articles (e.g. Winged Canvas, Bardot Brush–style summaries): posture and facial markers matter as much as head count.

### Wizard costume / silhouette (fantasy reads)

- **Silhouette triad:** **Hood peak / cowl depth** (frames face, casts read on shoulders) + **full-length robe** + **staff** taller than shoulder when vertical.
- **Competition note:** **Hood + beard** give a **two-level silhouette** (outer hood edge, inner beard wedge) — reads at distance like Phantom Operator’s helmet strips; staff **finial** (lathe crystal, ring stack, or spiral) is the cheap hero prop.
- **Published refs in this doc:** Use **Ref A / Ref B** only in your own moodboard — do not paste copyrighted art into the repo without rights.

---

## 2. Proposed scale (world units)

Aligned with dock survivor **~1.8 u** heroic height; wizard reads **taller / heavier** via **hood volume** + posture, not a giant body mesh.

| Quantity | Target | Notes |
|----------|--------|--------|
| **Ground → top of skull** | **~1.78–1.82 u** | Elder sage; matches dock male weight class. |
| **Hood — cowl rise above skull apex** | **+0.10–0.16 u** | Peak at back or top; **opening** stays clear of eyes (rim at ~brow / upper cheek). |
| **Hood — depth (front opening)** | **~0.18–0.26 u** rim inset | Face + **beard** remain readable in orbit. |
| **Head unit (1 “head”)** | **~0.25–0.26 u** | ~7 heads to ~1.8. |
| **Beard — bulk below chin** | **~0.12–0.20 u** drop | **Long:** secondary mass to **upper chest** (tubes + lathe sheet); tapers sideways **~0.08–0.12 u** max half-width. |
| **Staff — total length** | **~1.42–1.52 u** | Vertical rest: taller than shoulder line. |
| **Staff — grip** | **Right hand** (`handR`); grip center **~0.88–0.95 u** above sole | Left hand can overlap robe or upper shaft. |
| **Staff — shaft thickness** | **~0.02–0.028 u** radius | Finial **~0.07–0.11 u** feature width for silhouette. |
| **Robe hem** | **At ankle / top of foot** | Sole rule: local Y ≈ **-0.14**, Z ≈ **+0.05**. |
| **Robe outer width (shoulder)** | **+0.08–0.14 u** beyond athletic torso | Cone/lathe or panel drape. |
| **Train** | **None for v1** | Avoids terrain clip in dock; add later if heightfield clearance confirmed. |

**+Z forward:** Toe, staff tip offset, and robe train (if any) must follow dock **+Z** rule.

---

## 3. Layer stack (bottom → top) — LPCA build order

1. **Root / grounding** — `torso` group; feet soles; optional **robe skirt** lathe from pelvis down (inner volume).
2. **Legs + boots** — Under-robe legs (may be mostly hidden); boots at sole parity with blueprint.
3. **Core body** — Elder-adjusted lathe torso + neck (visible at V-neck or cloak opening).
4. **Inner tunic** — Lighter material strip at chest if cloak opens.
5. **Outer robe / mantle** — Main lathe or draped panels; **secondary darker layer** for depth; optional **train** as flat extrusion or second lathe.
6. **Arms + hands** — Sleeves merged or staged; **hands** aged read (knuckles); grip point empty for staff attach.
7. **Head** — `headRoot`: elder cranium/jaw, brows, optional nose read; **no** young-hero jaw.
8. **Long beard** — **Layered LPCA:** main chin mass (`LatheGeometry` or `ExtrudeGeometry` sheet) + **2–4 `TubeGeometry` braids** (CatmullRom curves) + mustache bridge if needed; merge beard meshes **by material** where peer mapping allows; use **`userData`** keys if palette touches beard pieces.
9. **Hood** — **Outer cowl:** `LatheGeometry` or revolved partial profile + **rim** (`ExtrudeGeometry` or thin box ring); **inner lining** slightly lighter material; opening sized so **face + beard** read; hood parented after head or integrated with **mantle** group for clean motion.
10. **Staff** — Attach to **`handR`**; rest pose clears robe + beard (slight tilt).
11. **Trim / magic accent** — **Hood edge** + **staff finial** priority; belt trim secondary; **1–2 emissive accents max**.

---

## 4. Pivot / integration (IDLE-CRAFT dock)

Match existing preview expectations where possible ([`DOCK_HERO_FIGURE_BLUEPRINT.md`](DOCK_HERO_FIGURE_BLUEPRINT.md)):

- **`torso`**, **`headRoot`**, **`armL` / `armR`**, **`handL` / `handR`**, leg/foot meshes as today.
- **Staff:** child of dominant hand group; **rest pose** rotation so shaft clears robe (small X/Z tilt).
- **Motion:** extend [`dockCharacterMotion.ts`](../src/data/dockCharacterMotion.ts) only if new pivots; prefer **existing** sway with **robe-safe** amplitude.

---

## 5. Material direction (PBR)

| Zone | Roughness | Metalness | Note |
|------|-----------|-----------|------|
| Outer robe | 0.82–0.92 | 0–0.05 | Deep cool grey / blue-grey; subtle **sheen** not plastic. |
| Inner / undertunic | 0.75–0.85 | 0 | Slightly lighter. |
| Leather belt / wraps | 0.65–0.75 | 0–0.08 | Warm contrast. |
| Metal trim | 0.35–0.55 | 0.65–0.85 | Sparse. |
| Staff wood | 0.7–0.85 | 0 | Or dark lathe “metal” staff if design shifts. |
| Finial / focus | 0.25–0.45 | 0.1–0.3 | **Very subtle** emissive (competition pop, not neon). |

---

## 6. Locked creative decisions (2026-04-16)

| Decision | Choice |
|----------|--------|
| **Cowl vs hat** | **Hood / deep cowl** — primary silhouette. |
| **Beard** | **Long** — layered lathe + tubes; chest-length read. |
| **Staff** | **Yes** — tall shaft + **strong finial**; **right-hand** grip. |
| **Train** | **None for v1** — dock-safe; revisit if env clearance is guaranteed. |

---

## 7. Technique readiness — are these the right tools?

**Yes.** This project already assumes **LPCA = runtime Three.js primitives + PBR**, same family as GoE’s Phantom Operator (`LatheGeometry`, `ExtrudeGeometry`, `TubeGeometry`, `BoxGeometry`, `CylinderGeometry`, `SphereGeometry`, `mergeByMaterial` where safe). Nothing about **hood + beard + staff** requires a different engine or importing `.glb` heroes.

| Feature | Technique | Precedent in your stack |
|--------|-----------|-------------------------|
| **Hood** | Revolved partial profile + rim extrude; optional inner shell for depth | Phantom helmet shell + visor extrude (conceptually similar layering) |
| **Long beard** | Lathe bulk + `TubeGeometry` on curves; merge by hair material | [`artisanFemaleLPCA.ts`](../src/visual/artisanFemaleLPCA.ts) layered hair pattern |
| **Staff** | Cylinder/taper lathe shaft + lathe/extrude finial; parent to `handR` | Existing [`vanguardWizardLPCA.ts`](../src/visual/vanguardWizardLPCA.ts) staff path (to be **replaced**, not copied blindly) |
| **“Incredible” bar** | **Material contrast** (outer/inner hood), **rim catchlight**, **finial emissive**, **dignified idle** — mold → refine in dock | Same **mold-and-refine** cycle as `LPCA_METHOD.md` |

**Real risks (manageable, not tool gaps):**

1. **`CharacterScenePreview` peer clone** — If mesh count/order changes vs legacy topology, update pairing or adopt **`userData` mesh keys** (see [`DOCK_HERO_FIGURE_BLUEPRINT.md`](DOCK_HERO_FIGURE_BLUEPRINT.md) §3–5).
2. **Draw calls** — Beard/hood add meshes; **merge by material** on stable groups; keep finial + robe trims **bucketed**.
3. **Time** — Competition polish is **iteration in the running dock**, not a missing technique.

**Bottom line:** The toolkit is **appropriate**; execution is **new dedicated wizard module** + careful preview wiring + your feedback passes until the silhouette feels competition-ready.

---

## 8. Changelog

| Ver | Date | Notes |
|-----|------|--------|
| 0.1 | 2026-04-16 | Draft from dock blueprint + generic elder/wizard research; IP-neutral archetype. |
| 0.2 | 2026-04-16 | Locks: **hood**, **long beard**, **staff right**, **no train v1**; hood/beard scale table; **§7 technique readiness**. |
