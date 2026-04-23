# Idle Craft multiplayer roadmap

_Synced from design work — edit here as the project source of truth._

## Grounding: GoE → Idle presence (keep as reference)

GameOfEmpires patterns that still apply: **seed + anchor identity** (not raw coords), **compact snapshots + `seq`/staleness**, **relay vs authority** (cosmetic presence vs server-owned rewards). Transport stays **WSS JSON at low Hz** (~5–10 Hz or on-change), not UDP sim.

- **v0:** room `seed` + stable gather anchor ids (see `src/core/gameStore.ts` `beginOnlineSession`).
- **v1:** `presence`: `{ sessionId, page, gatherKey?, seq }`.
- **v2:** add `progress01` + light lerp on anchor.
- **Touch files:** `server/room-server.mjs`, `src/net/roomHub.ts`, `src/visual/characterScenePreview.ts` / gather UI.

## 1) Co-op: start immediately + join anytime

**A — Shared stash (lighter, do first):** Host-authoritative ledger (`coopReplace` / `coopOp` / `coop_inventory`). Late joiners hydrate from `room_snapshot` + coop payload.

**B — Shared world (heavy, defer):** Server-validated gathers; larger scope.

**Visual goal (co-op, outside battle):** Everyone sees everyone in the scene; camera scaling per **Camera and framing** below.

## Placement: outside battle vs in battle

- Outside battle: camp/gather staging + presence — not duel arcs.
- In battle: separate battle transforms; **1v1** is reference layout; **3v3** extends with arcs + pulled-back camera.

## 2) Hunter 1v1: propose / accept / decline

- `pvpProposeBattle` + `targetSessionId`; target-only Accept/Decline; timeout → decline; no “majority” copy in Hunter mode.
- After accept: force Battle tab + UI; **`pvp_assigned`** wiring exists today.

**Battle visibility (required):** Fan-out all combat events to all clients; **seq** / total order so hits line up; route to slots + remote rig clips (**1v1 + 3v3**).

## Camera and framing (battle + large co-op)

- **1v1** canonical ±X face-off; add players → pull camera back (stronger after **>3** players).
- **Per-player** zoom/pan (local pref, not synced) for 3v3 battle and large co-op.

## 3) Base damage rules (awakened mode)

Authoritative rule for damage to placed cabin pieces, stations, chests/crates, and other player avatars in awakened mode. Full system spec lives in [`BASE_BUILDING_AND_SURVIVAL_PLAN.md`](BASE_BUILDING_AND_SURVIVAL_PLAN.md); this section locks the **network-side ruleset** so the room server and clients agree on what damage events are valid.

**Co-op (`gameMode === 'coop'`):**
- Damage events from one teammate to another teammate are **dropped** at the engine boundary (zero damage applied, no SFX, no visual flinch).
- Same rule applies to teammate-owned structures (cabin pieces, stations, chests). Pieces are tagged with `ownerSessionId`; events whose source `sessionId` matches the owner's team are zeroed out.
- Mob damage to teammate structures is allowed (hostile NPCs, not friendly players).
- Chests: **no locking**. Any teammate may open and take. Activity log inside the chest UI surfaces per-teammate transactions for transparency.

**1v1 PvP (`gameMode === 'hunter'` after `pvp_assigned`):**
- Damage events from the opposing player to the other player AND that player's pieces / stations / chests are **applied normally**. Same `damage` math as mob damage events.
- Destroyed pieces (HP → 0) drop the same fractional material loot the mob system uses (40% of base material cost). The destroying player has no priority claim — first player to walk into the loot pile picks it up.
- Chests are **lockable** in 1v1. A locked chest must be broken open via sustained melee/projectile attack (separate `chestLock_HP` field, ~80 HP at T0, scales with chest tier). Once broken, contents are visible and takeable by either player.

**Network event shape (canonical):**

```ts
type DamageEvent = {
  seq: number;
  fromSessionId: string;
  targetKind: 'player' | 'cabin_piece' | 'station' | 'chest';
  targetId: string;
  amount: number;
  source: 'mob' | 'pvp_melee' | 'pvp_projectile' | 'mob_explosion';
};
```

The host validates each event against the ruleset above before applying + fanning out. Clients trust the host's post-rule events for visual + SFX feedback; never apply damage locally before host confirmation.

**Files (when implemented in Phase 4 / 6):** `server/room-server.mjs` (rule enforcement), `src/net/roomHub.ts` (event marshaling), `src/core/gameStore.ts` (`damageCabinPiece`, `damageChest`, `applyPvpDamageEvent`).

## 4) Face-to-face full characters

- Full survivor path for rival; dual roots → N slots; 3v3 six transforms, battle-only.

## Implementation order (suggested)

1. Co-op path A: solo-host active, snapshot/coop hydrate, conflict rule.
2. Full-room combat feed + alignment (server + client).
3. Hunter 1v1 invite protocol + copy.
4. Battle tab sync on `pvp_assigned`.
5. Camera rig + per-player zoom/pan.
6. Duel / arena viewport.
7. Presence v1/v2 for outside battle.

## Checklist (from planning todos)

- [ ] Gather anchor IDs + room seed alignment
- [ ] WS presence spec + `room-server.mjs` relay
- [ ] `roomHub` + CharacterScenePreview ghost mapping
- [ ] Co-op shared stash v1 (host/revision conflicts)
- [ ] Hunter duel invite + battle tab sync
- [ ] Duel full-character scene + 3v3 battle-only layout
- [ ] Battle full-arena feed (fan-out + aligned playback)
- [ ] Multiplayer camera rig (auto frame + user zoom/pan)
