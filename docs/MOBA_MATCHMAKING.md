# Matchmaking — pragmatic approach for MOBA v1

**Best method for you right now:** **not** Hungarian assignment or skill-based global matchmaking. Those need **volume**, **persistent MMR**, and **infra**. For a jam-scale game, optimize for **reliability** and **time-to-match**.

## Tier 0 (ship first) — manual + room code

1. Player opens game → **Create match** or **Join match**.
2. **Create** generates a short code (e.g. 6 chars); host is team captain or auto-assign.
3. **Join** enters code over **WebSocket** to your room server.
4. **Ready** gates; host **Start** loads the same **seed/map** for all clients.

**Why:** Works with **few players**, no queues, easy to debug. Matches [`server/room-server.mjs`](../server/room-server.mjs) patterns already in the fork (protocol can be simplified or replaced).

## Tier 1 — public queue (implemented on MOBA server)

- **FIFO** per mode in [`server/room-server.mjs`](../server/room-server.mjs): **`deathmatch`** waits until **6** players (`MOBA_3V3_QUEUE_SIZE`, default 6), then creates one room; teams **alternate** in join order (positions 0,2,4 → team 0; 1,3,5 → team 1). **`pvp`** still drains **2** at a time for 1v1.
- Clients use **protocol v4** (`ROOM_PROTOCOL_V`); server still accepts v3 hellos.
- **Env:** `MOBA_3V3_QUEUE_SIZE=6` on Fly (optional override for tests).
- **No** skill matching — avoids empty queues.

## Tier 2 (later) — light fairness

- **Party support:** friends join same room code first; backfill with solo queue.
- **Loose buckets:** e.g. “new” vs “experienced” by **games played** stored in `localStorage` — still not true MMR.
- **Hungarian / optimal assignment:** only if you have **measurable skill** and enough concurrent players; treat as **research**, not v1.

## Technical note

- **Authoritative server** for match result and anti-cheat is separate from **matchmaking**. v1 can use **host-as-authority** or **thin server** relay + validation of key events; tighten when cheating matters.

**Summary:** **Room code + ready gate** = best first method. Add **FIFO public queue** when you have traffic. Defer **advanced algorithms** until basics and player counts justify them.
