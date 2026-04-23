# Gather anchors and room seed

This document ties **manual gather actions** (presence / ghost UI) to **stable string ids** and the **online room seed**.

## Room seed

- **Server:** Each room gets `seed = roomSeed(roomId + gameMode)` (32-bit FNV-style hash) in `server/room-server.mjs`.
- **Client:** `GameStore.beginOnlineSession` stores `onlineSession.seed` from the lobby snapshot.
- **PvE waves:** `startPveBattle` uses `seed` to rotate the enemy index: `waveOffset = (seed * 1103515245) >>> 0 % n`.
- **Future shared-world / deterministic nodes:** Use the same `seed` (or `seed ^ anchorSalt`) in a PRNG **only** for cosmetic or agreed layouts—**not** for co-op stash authority (path A).

## Gather anchor ids (`gatherKey`)

Use the **`GatherActionDef.id`** strings from `GameStore.listGatherActionGroups()` / `performGather(actionId)`. These are stable across builds unless a card is renamed in `content.ts`.

| Group (conceptual) | Example `gatherKey` / `actionId` |
|--------------------|----------------------------------|
| Wood / fiber | `wood`, `fiber` |
| Stone / ores | `stone`, `mine_iron_ore`, `mine_coal`, `mine_copper_ore`, `mine_tin_ore`, `mine_zinc_ore`, `mine_silver_ore`, `mine_gold_ore`, `mine_platinum_ore` |
| Food / water | `water`, `berries`, `hunt`, `tend_garden` |
| Other | (any future ids added to gather groups) |

## App pages (`page` for presence)

Use short page ids aligned with `mountApp` routing:

- `gather`, `craft`, `inventory`, `decks`, `idle`, `battle`, `hire`, `portal`

## Wire format (v3+)

See `presence` / `presence_update` in `server/room-server.mjs` and `RoomHub.sendPresence` in `src/net/roomHub.ts`:

- `page`, optional `gatherKey`, optional `progress01` (0–1), client `seq` (monotonic per sender for stale drops).
