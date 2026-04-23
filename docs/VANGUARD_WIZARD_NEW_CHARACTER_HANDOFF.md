# Vanguard wizard — new character intent & session handoff

**Purpose:** This document fixes scope after prior work drifted. Use it when opening a **new chat** so the assistant does not repeat the wrong task.

---

## What we are actually building

- **A new vanguard wizard character**, designed **from scratch** in **LPCA style** (procedural geometry in code, EmpireEngine patterns where appropriate).
- The design should be grounded in **research**: find a **schematic, reference sheet, or clear visual breakdown online** (proportions, silhouette, costume read, hat/robe/staff relationship) and translate that into a **written schematic** before writing lathe profiles or heavy mesh code.
- **Third-person dock only** (orbit, full body) unless product direction changes — no first-person viewmodel layer for this task unless explicitly requested later.

This is **not** “make the existing generic dock male slightly nicer.” It is **not** “refactor the old body into a factory module while keeping the same look.”

---

## What went wrong (drift to avoid repeating)

Earlier implementation focused on:

- Moving the **existing** dock body construction (generic male + shared forge/vanguard attachments) into `dockHeroFigureLPCA.ts` and wiring `CharacterScenePreview` to call a factory.
- Preserving **peer clone** parity and the **same** mesh topology/order as before.

That work **does not** satisfy the **vanguard wizard** goal above. It **revives and reorganizes** the old concept instead of **replacing** it with a **new** wizard built from a **researched schematic**.

**Do not treat that refactor as the “new character.”** Treat it as infrastructure that may stay or be revised once the **real** wizard LPCA exists.

---

## Mandatory stance on the “old vanguard”

- The **current** vanguard wizard presentation (robe/hat/staff layers on top of the generic dock, `vanguardWizardLPCA.ts`, palette toggles, etc.) is **legacy relative to this goal**.
- The target end state is: **the vanguard wizard is completely redone** — either **rebuilt as a dedicated LPCA figure** that matches the researched schematic, or **replaced** so the dock shows a **different** construction path for that preset, **not** a light retexture or small tweak of the old silhouette.
- **Do not** optimize for “minimal diff” or “keep the old mesh blocks.” Optimize for **correct design from research**.

---

## Correct workflow (LPCA discipline)

1. **Research** — Collect 1–3 strong references (character sheet, concept orthographics, or labeled schematic). Lock **head units**, height, sole/ground rule, +Z forward, key costume volumes (hat brim, robe hem, staff length).
2. **Schematic** — Numbers on paper (or markdown): layer stack bottom → top, pivot names, merge strategy **after** topology is stable.
3. **Build** — New module(s), e.g. dedicated **vanguard wizard figure** factory (not shared generic male trunk unless you deliberately reuse a base).
4. **Motion** — Data-driven poses for wizard-specific clips where it matters; thin applier in preview.
5. **Integrate** — Preset `vanguard_wizard` selects **this** figure + palette; remove or bypass obsolete branches once parity is acceptable.

---

## Files that exist today (context for the next session)

| Area | Notes |
|------|--------|
| `src/visual/vanguardWizardLPCA.ts` | Current procedural robe/hat/staff — **candidate for full replacement**, not the final “new character” by itself. |
| `src/visual/dockHeroFigureLPCA.ts` | Generic dock factory from the drifted pass — **not** the researched wizard schematic build. |
| `docs/DOCK_HERO_FIGURE_BLUEPRINT.md` | Dock-wide geometry notes; **wizard-specific** blueprint should be a **separate** doc (e.g. `VANGUARD_WIZARD_SCHEMATIC.md`) once research is locked. |
| `docs/IDLE_CRAFT_ENGINE_AND_LPCA_ROADMAP.md` | Engine/LPCA tooling reference. |

---

## First questions for the next assistant

1. Paste a link or attach the **reference schematic** (or three references) the user chose for the new wizard.
2. Confirm: **replace** old vanguard topology vs. **parallel** new figure behind a flag until approval.
3. Confirm scope: **wizard preset only** first, or entire dock male also rebuilt (user intent here was **wizard**, not necessarily the whole dock).

---

## User-facing summary (copy into chat if needed)

> We are **not** reviving or incrementally modifying the old vanguard concept. We are **researching a new wizard online**, locking a **schematic**, then building a **new LPCA vanguard from scratch**. Prior work that only refactored the generic dock into a factory was **off-scope** for that goal.

---

*Last updated: handoff after scope clarification (new window / fresh context).*
