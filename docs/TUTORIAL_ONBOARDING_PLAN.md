# Tutorial & first-time onboarding — plan

**Status:** Plan only (no implementation in this doc).  
**Game:** IDLE-CRAFT — idle survival, tabs (`gather`, `craft`, `inventory`, `decks`, `idle`, `battle`, `hire`, `portal`), dock WebGL preview, save in `localStorage` (`idle-deck-fusion-v1` via `gameStore`).

---

## 1. Research snapshot (industry + learning science)

These inform *pace*, *copy length*, and *structure* — not a requirement to cite in UI.

| Theme | Takeaway | Sources / anchors |
|--------|-----------|-------------------|
| **FTUE window** | First session (minutes to ~1h) sets retention; hook core loop fast. | Common FTUE framing in games product / UX writing |
| **Cognitive load** | One primary objective per step; avoid long text; mechanics + UI already compete for working memory. | **Cognitive Load Theory**; **Evidence-Centered Design** applied to game-based learning (e.g. Bounajim et al., 2020 — design diagnostics for assistance) |
| **Worked examples** | Showing *one* clear example (e.g. “slot this card here”) beats abstract explanation for novices. | Graz / serious games literature on **worked example effect** (e.g. IEEE / Graz publications on reducing load in game environments) |
| **Progressive disclosure** | Tabs and systems unlock in the tutorial order; don’t explain Hire before player has coin/context. | Standard onboarding UX; Siege-style “competency layering” (GDC-style talks on teaching complex games) |
| **Active > passive** | Steps should require a click / slot / gather where possible, with immediate feedback (glow clears, popup advances). | Cone of experience / active learning — often cited in game tutorial blog posts; aligns with your glow + popup design |

**Practical translation for IDLE-CRAFT:**

- **Short copy** (1–3 sentences per popup; optional “More” for deck rules).
- **Forced focus**: dim non-target nav (optional) + highlight target + block advance until action OR explicit “Skip step”.
- **Survival-first**: thirst/hunger are real — tutorial should *recommend* water/berries early without soft-locking if player ignores (warnings, not hard gates except where teaching a mandatory click).

---

## 2. Product decisions (confirm before build)

| Decision | Recommendation |
|----------|----------------|
| **Skip tutorial** | On first load after new run: modal — **“Guided tour”** vs **“Skip (I know idle games)”**. Skip sets `tutorialState: completed` (or equivalent) and never auto-opens overlays. |
| **Replay** | ESC menu or Settings: **“Replay tutorial”** (resets only tutorial flags, not inventory). |
| **Persistence** | Store in **game save** (`GameState`) so Continue respects completion; optional mirror in `localStorage` key for pre-save edge cases is redundant if save always exists in-run. |
| **Online / PvP** | Tutorial targets **solo run** first; Hunter/room flows: either disable forced nav during online session or use a shorter “online hints” track (phase 2). |
| **Offline idling** | Copy should say progression is **online / active tab** for now; **offline idling** is a future feature — one sentence in Idle step, not repeated every popup. |

---

## 3. Tutorial flow (ordered beats)

Numbers are **beats**, not minutes. Several beats **overlap** (e.g. gather runs while reading Decks).

### Phase A — Shell & camera (first 30–60s)

| Beat | Action | UI |
|------|--------|-----|
| A0 | Welcome + **Guided / Skip** | Full-screen or modal; persist choice |
| A1 | **Nav overview** | Point at `nav` tabs: one line each (Gather, Idle, Decks, Craft, Inventory, Battle, Hire, Portal when relevant) — *light*, not deep |
| A2 | **Dock + camera** | Popup near `#character-dock`: orbit / pan / wheel / double-click reset (restore teaching here since `title` tooltip was removed) |
| A3 | **ESC menu** | Highlight system menu: audio, camera reminder, return to title |

### Phase B — Survival loop (parallel with UI teaching)

| Beat | Action | UI |
|------|--------|-----|
| B1 | Explain **hunger / thirst / HP** (HUD) | Glow on `#app-hud` meters |
| B2 | **Gather: water + berries** (and optionally fiber) | `renderGather`: glow first on water, then berries; short copy on *why* |
| B3 | **Inventory** | Show consumption: berries/water as camp stock; tie to survival |

*Design note:* Starting inventory already includes some water/berries/stone/wood/fiber (`createInitialState`). Tutorial should **still** route player through gather so they learn the **action** and timing, not assume they read inventory first.

### Phase C — Idle automation (your “six slots”)

| Beat | Action | UI |
|------|--------|-----|
| C1 | Open **Idle** tab | `data-nav-page="idle"` glow |
| C2 | Explain **automation vs manual** + **online idling** (one line on future offline) | Popup |
| C3 | **Fill all 6 slots** | `IDLE_SLOT_INITIAL === 6` already — guide to place recommended starter cards (berries, fiber, water if cards exist, + windfall/starter per design) |
| C4 | **Unlock flow** (if coin/slots locked) | Only if mechanics require; keep optional branch |

*Content dependency:* Need a fixed **starter deck list** for “recommended first six” (data-driven from `content.ts` / automation cards).

### Phase D — Decks & progression

| Beat | Action | UI |
|------|--------|-----|
| D1 | **Decks tab**: deck vs hand, drawing, unlock **camp** / **magic** path | Glow on deck areas; 1 worked example (“unlock this blueprint”) |
| D2 | Explain **cards → recipes → stations** link | Short; point to Craft when relevant |

### Phase E — Crafting

| Beat | Action | UI |
|------|--------|-----|
| E1 | Stations (hand / campfire / …) | Tour `renderCraft` |
| E2 | **Goal recipes**: water containers?, cooked food, meat, wood, stone — match *actual* recipe ids in game | Scripted highlights or generic “complete any campfire cook” if too branching |

### Phase F — Battle & Hire

| Beat | Action | UI |
|------|--------|-----|
| F1 | **Battle**: energy, turn order, PvE loop | `renderBattle`; optional “start first fight” nudge |
| F2 | **Hire**: helpers, idle bonus cap mention (`IDLE_HELPER_BONUS_CAP` in store) | `renderHire` |

### Phase G — Consolidation

| Beat | Action | UI |
|------|--------|-----|
| G1 | **Gather again** for stockpile to eat/drink | Reinforce loop |
| G2 | **Completion** | Toast + mark tutorial complete + optional reward (cosmetic only — avoid economy exploit) |

---

## 4. UX toolkit (implementation concepts)

### 4.1 Overlay layer

- Fixed `position` container above `#app-shell` (below system menu if needed): `pointer-events: none` default; **modal** regions `pointer-events: auto`.
- Steps driven by small **state machine** (`tutorialStepId`, `phase`).

### 4.2 Glow / spotlight

- **Preferred:** CSS class on target + `outline` / `box-shadow` pulse + optional `::backdrop` dim on a scrim.
- **Nav buttons:** `button[data-nav-page="idle"]` etc. — stable selectors from `mountApp`.
- **Dynamic lists:** use `data-tutorial-anchor` attributes when rendering rows (gather buttons, idle slots, deck cards).

### 4.3 Popups

- Card near target (`getBoundingClientRect` + flip if off-screen) or bottom sheet on mobile-width.
- Controls: **Next** (if informational), **Got it** (dismiss), **Skip tutorial** (global).

### 4.4 Gating

- **Soft gate:** Next step unlocks when `condition()` true (e.g. `inventory.water >= X` OR `stepSkipped`).
- **Hard gate:** only for destructive actions — avoid locking player in tutorial if survival critical; prefer **warnings** (“Thirst is high — gather water soon”).

### 4.5 Skip behavior

- Sets completion flag; clears overlay; does not delete save.
- Optional: **“Show hints only”** mode (icons on tabs) — phase 2.

---

## 5. Technical integration (codebase)

| Area | Notes |
|------|--------|
| **State** | Extend `GameState` in `types.ts` + migration in `gameStore.ts` e.g. `tutorial: { version: 1, status: 'off' \| 'active' \| 'completed', step: string, skippedAt?: number }` |
| **mountApp** | After `mountApp`, if `tutorial.status === 'active'`, mount `TutorialController` that subscribes to store + `renderPage` callbacks |
| **Nav** | `renderPage` already switches `page`; tutorial can call same nav handler as tab buttons |
| **Character dock** | `scenePreview.setPageContext` already tied to page — tutorial popups for camera should not fight WebGL pointer capture |
| **i18n** | English-only first; structure copy in one `tutorialCopy.ts` for later localization |

---

## 6. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Tutorial fights **view transitions** / full re-render | Tutorial layer persists outside `pageRoot`; anchors re-bound after `renderPageBody` |
| **Online PvP** nav lock | Pause tutorial steps while `onlinePvpNavLock` or skip battle/hire beats |
| **Long gather clips** | Advance “gather” beat on `performGather` / clip start, not only on loot |
| Copy drift vs **real recipes** | Single source of truth: `tutorialCopy.ts` references card/recipe ids validated in CI or unit test |

---

## 7. Implementation phases (suggested)

1. **P0:** State + skip/guided modal + one vertical slice (Idle: 6 slots + one gather).
2. **P1:** Full step machine + nav highlights + HUD survival beat.
3. **P2:** Decks + Craft scripted highlights; battle/hire.
4. **P3:** Polish (animations, sound stinger, replay from ESC).

---

## 8. Locked product decisions (implementation v1)

| Topic | Decision |
|--------|----------|
| **Idle step** | Guide the player to assign **Windfall trail** (`c_idle_windfall`) to **all six** idle automation slots (same card in every slot, not a mixed starter set). |
| **Battle** | **No** forced PvE or PvP start. The tour opens the Battle tab and explains the UI; **if** the player starts combat, the tutorial branches to short in-combat hints (energy, cards, end turn, meds). |
| **Portal** | **Include** the Portal (webring / jam exit) explanation in v1. |
| **Skip** | **Full skip only** — no one-page summary sheet after skipping. |

---

## 9. Sign-off

When this plan is approved:

- [x] Confirm answers to §8
- [x] Lock starter “six cards” list with design — canonical idle tutorial card: **`c_idle_windfall`** (six slots)
- [ ] Implement P0–P1 in branch; playtest FTUE ≤ 15 minutes for guided path
- [ ] Deploy after QA

---

## 10. External references (for deeper reading)

- [GDC Vault — Teaching complex games (Rainbow Six Siege onboarding)](https://www.gdcvault.com/play/1034331/Teaching-Complex-Games-Onboarding-Redesign-for-Rainbow-Six-Siege)
- [GDevelop — Why game tutorials fail (onboarding patterns)](https://gdevelop.io/blog/improve-game-tutorials)
- [UX Collective — Games UX: onboarding experience](https://uxdesign.cc/games-ux-building-the-right-onboarding-experience-a6e99cf4aaea)
- [Sage / HCI — Cognitive Load Theory & Evidence-Centered Design in game-based learning](https://journals.sagepub.com/doi/10.1177/1071181320641192) (paywalled; abstract useful for framing)
- [IEEE Xplore — Worked examples & cognitive load in serious games](https://ieeexplore.ieee.org/document/9155187/) (institutional access)

---

*Document version: 1.0 — 2026-04-14*
