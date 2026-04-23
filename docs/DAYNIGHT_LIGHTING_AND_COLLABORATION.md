# Day/night lighting, dock rendering, and how we work through hard problems

This document records **problems**, **solutions**, and **light source inventory** for the Idle Craft forest dock, including changes that shipped without a single dedicated doc. It also states how **director (you)** and **agent** together tend to produce the clearest diagnosis and fastest fixes.

---

## Collaboration: director + agent

The best outcomes here have come from **both** sides actively engaged:

- **Director:** intent, what feels wrong in play (“stepping,” “sun still on trees after sunset,” “FXAA makes it worse”), priorities, and acceptance.
- **Agent:** reading the code path, measuring what updates at what rate (per frame vs canvas repaint), tracing celestial vs clock blends, and proposing concrete changes.

Neither alone reliably finds the *real* problem on the first try. Symbiosis matters: you surface **symptoms and timing**; the agent maps them to **implementation** (often a mismatch between systems). That combination is what identified skydome lag vs fog, parallax ticks vs smoothed lighting, and **sun key intensity following `dayMix` instead of the geometric sun**.

We should keep making this channel explicit: **playtest observation + code-level verification + industry patterns** (see Research) is the default when something feels off.

**Research (LPCA-style, applied broadly):** When stuck, we review our implementation, then look outward—game engines (Unreal, Unity), real-time rendering references, and established practices (e.g. directional sun scaled by sun altitude). LPCA is “research first” for characters; the same discipline applies to lighting, post-processing, and performance.

---

## Dock / forest light sources (overview)

| Source | Role | Notes |
|--------|------|--------|
| **Directional key (`keyLight`)** | Sun | Bound from `IdleCraftDockEnvironment`; follows **sun direction**; casts shadows when sun is geometrically relevant. |
| **Hemisphere light (`hemi`)** | Sky / ground bounce fill | Scene-owned; sky vs ground colors blend with `dayMix` + dusk tints. |
| **Ambient light** | Non-directional fill | Moon-tinted at night; blends day/night. |
| **Moon directional + point** | Night key / fill | Moon direction from ephemeris; scaled by night mix and elevation. |
| **Moon disc mesh** | Visual moon | Shader uses sky band colors for limb. |
| **Plasma sun mesh** (optional) | Visible sun disk | Parallax squash + horizon fade; separate from **light** intensity. |
| **Night magic field** | Bioluminescence / fairies | `IdleCraftNightMagicLPCA`; visibility eased separately. |
| **Stars** | Points layers | Opacity from star phase + storm + perf scale. |
| **Character preview** | Small **rim** point (often near-zero) | Commented as inventory hover accent; not a main outdoor light. |

Fog color and **skydome canvas** drive the **sky appearance**; they are not lights but strongly affect perceived brightness and color.

---

## Problem: sun below horizon but trees / land still “in full sun”

### Symptom

From the player’s view, the **sun disk** (plasma / skydome) has set, but **trees and terrain** still show strong directional shading and specular as if the sun were up.

### Cause

The **directional sun key intensity** was driven mainly by **`dayMix`**, which comes from:

- Clock-hour curves,
- Sun-elevation curve,
- **Real-time EMA smoothing** (so transitions don’t snap).

So **`dayMix` can remain significant for real time after the true sun direction vector has `y < 0`**. The visible disk was already faded (e.g. plasma uses `horizonFade` from `sun.y`), but the **light** did not use the same geometric test—classic **desync between visuals and lighting**.

### Solution (implemented)

Multiply the sun **key** intensity by a factor derived from **geometric sun elevation** (`sun.y`), e.g.:

`smoothstep(sun.y, -0.045, 0.028)` — full key when the sun is clearly above the horizon; falls through twilight; ~0 when the sun is below.

Hemisphere and ambient **keep** using `dayMix` so **civil twilight** (sky glow without a hard beam) still reads. Only the **parallel “sun” key** tracks the horizon tightly.

Sun **shadow** gating also requires this factor so shadows don’t persist from a “logical day” when the sun is already down.

---

## Policy: both directional lights keep `castShadow = true` for the session

### Symptom (2026-04-16)

Hard **2–10 second freeze** at first in-game sunset — ~3–5 seconds **after** the sun plasma faded, **before** the moon rose — then fine on every subsequent sunset.

### Cause

Three.js hashes lit-material programs by `numDirLightShadows`. Previously, `keyLight.castShadow` and `moonLight.castShadow` were toggled based on time-of-day and altitude guards. Between the sun going down and the moon getting high enough, **both** were `false` briefly → count `1 → 0 → 1` → **every** lit `MeshStandardMaterial` recompiled synchronously on the main thread.

### Policy now

**Both** directional lights keep `castShadow = true` from the moment they are created / bound, and are **never** toggled at runtime. Below-horizon contributions are invisible anyway, because Three.js multiplies the shadow factor by the light contribution and `intensity → 0` below the horizon.

| Behaviour | Old | New |
|-----------|-----|------|
| `keyLight.castShadow` at night | flipped to `false` | **always `true`** |
| `moonLight.castShadow` during the day | flipped to `false` | **always `true`** |
| `numDirLightShadows` | `1 → 0 → 1` at twilight | constant `2` |
| Lit-material shader recompiles at sunset | many (first night) | none |
| Shadow render passes / frame | 1 | 2 |
| Visible cost | long first-sunset freeze | ~0.5–2 ms extra / frame |

### Consequences for future changes

- **Do not** reintroduce altitude / `dayMix` / `sunDirectFrac` guards on either `castShadow`. It will bring back the freeze.
- If the extra shadow pass ever shows up in profiling, lower `moonLight.shadow.mapSize` (e.g. 512²) or share a single shadow target with a switched frustum — **never** flip `castShadow` at runtime.

See `LEARNINGS.md` → "First-sunset hard freeze — directional shadow light count churn" for the full diagnostic trail.

---

## Other issues we hit (summary)

### 1. Day/night “stepping” and FXAA

- **Symptom:** Harsh bands or crawl; worse with FXAA on.
- **Cause:** **Fog and lights** update every frame; **skydome** is a Canvas2D texture repainted on an **interval**. Mismatched rates → luminance edges FXAA locks onto.
- **Mitigation:** Faster skydome repaint in twilight; smoother EMA on sunset/dusk/star opacity; wider hour ramps. FXAA **reveals** the mismatch; it is not the root cause.

### 2. Parallax vs lighting at sunset

- **Symptom:** Odd timing when the sun nears the horizon with plasma squash.
- **Cause:** `horizonDiskParallaxScale` changed quickly in a narrow altitude band; **plasma** scale was instant per frame.
- **Mitigation:** Wider altitude blend, **EMA on parallax scale**, soft **horizonFade** on plasma strength.

### 3. Fairies during gather

- **Symptom:** Fairies capped during travel; felt wrong / costly.
- **Change:** Removed gather-time fairy cap; full swarm when enabled.

### 4. Esc menu copy

- Removed internal references (FULL_ENGINE_PIPELINE, TECHNICAL_SPEC, “PBR dock”) from user-facing strings; loading kicker simplified to **“Forging camp”**.

### 5. Post-processing / renderer display

- FXAA **strength** slider; lighting panel (tone mapping, exposure, light multipliers); persistence; lobby + dock sync where applicable.

---

## Files touched (reference)

| Area | Files (non-exhaustive) |
|------|-------------------------|
| Day periods | `src/world/idleCraftDayPeriods.ts` (`horizonBeltWeight`, hour curves) |
| Dock environment | `src/world/idleCraftDockEnvironment.ts` (EMAs, skydome cadence, **sunDirectFrac**, parallax smooth) |
| Celestial / parallax | `src/world/idleCraftCelestialMechanics.ts` |
| Skydome paint | `src/world/idleCraftSkyPaint.ts` |
| Night magic | `src/visual/idleCraftNightMagicLPCA.ts` |
| UI | `src/ui/systemMenu.ts`, `src/ui/expeditionLoadingOverlay.ts` |
| Graphics / display | `src/engine/rendererDisplaySettings.ts`, `src/ui/systemMenuGraphicsPanel.ts`, `src/ui/systemMenuLightingPanel.ts` |

---

## Industry alignment (short)

- **Directional sun × elevation:** Common in engines (fade sun light below horizon; ambient/sky separate).
- **Skydome vs analytical fog:** Either update sky often enough to match, or use analytic/procedural sky in shader to avoid canvas cadence issues.
- **FXAA:** Edge-sensitive; fix **contrast consistency** first.

---

*Last updated to include geometric sun key multiplier and collaboration/research framing.*
