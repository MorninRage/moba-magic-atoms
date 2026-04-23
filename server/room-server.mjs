/**
 * IDLE-CRAFT room hub — protocol v3 (co-op shared stash, PvP vote + strikes, elimination).
 * HTTP + WebSocket upgrade for Fly.io / Netlify-adjacent hosting.
 * @see README.md
 */
import http from 'http';
import { randomUUID } from 'crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 3334;
/** v4: deathmatch queue drains in batches of {@link MOBA_3V3_QUEUE_SIZE} (default 6). v3 clients still connect. */
const PROTOCOL_VERSION = 4;
const MAX_PLAYERS = 6;
const MAX_PER_TEAM = 3;
/** FIFO matchmaking batch for Forge clash / MOBA 3v3 — override with env `MOBA_3V3_QUEUE_SIZE` for tests. */
const MOBA_3V3_QUEUE_SIZE = Math.max(2, Math.min(12, Number(process.env.MOBA_3V3_QUEUE_SIZE) || 6));

const VALID_PRESETS = new Set([
  'vanguard',
  'artisan',
  'wayfarer',
  'geomancer',
  'ridge_runner',
  'ash_seer',
  'copper_jack',
  'frost_line',
]);

const VALID_MODES = new Set(['solo', 'coop', 'pvp', 'deathmatch']);

/** @param {string} roomId */
function sanitizeRoomId(roomId) {
  return String(roomId ?? '')
    .trim()
    .slice(0, 64)
    .replace(/[^\w-]/g, '');
}

function roomSeed(roomId) {
  let h = 2166136261;
  for (let i = 0; i < roomId.length; i++) {
    h ^= roomId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function minPlayersToStart(gameMode) {
  if (gameMode === 'deathmatch') return 2;
  if (gameMode === 'pvp') return 2;
  if (gameMode === 'coop') return 1;
  return 2;
}

const PRESENCE_MIN_INTERVAL_MS = 85;
const DUEL_INVITE_MS = 45000;

/** @type {Map<string, ReturnType<typeof createRoom>>} */
const roomById = new Map();

/** mode -> sessionIds waiting */
const queueByMode = new Map();

function createRoom(gameMode, hostSessionId, isPublic) {
  let id = makeRoomCode();
  while (roomById.has(id)) id = makeRoomCode();
  /** Hunter duel is 1v1 — cap at 2. Co-op and 3v3 (deathmatch) use six slots. */
  const maxPlayers = gameMode === 'pvp' ? 2 : MAX_PLAYERS;
  const room = {
    id,
    gameMode,
    phase: 'lobby',
    seed: roomSeed(id + gameMode),
    hostSessionId,
    maxPlayers,
    isPublic: !!isPublic,
    /** @type {Map<string, { displayName: string, characterPresetId: string, team: number, ready: boolean, isHost: boolean }>} */
    players: new Map(),
  };
  roomById.set(id, room);
  return room;
}

function deleteRoomIfEmpty(room) {
  if (room.players.size === 0) roomById.delete(room.id);
}

function reassignHost(room) {
  const first = room.players.keys().next().value;
  room.hostSessionId = first ?? null;
  for (const [sid, pl] of room.players) {
    pl.isHost = sid === room.hostSessionId;
  }
}

/** @param {ReturnType<typeof createRoom>} room @param {string} sessionId */
function removePlayerFromRoom(room, sessionId) {
  const wasHost = room.hostSessionId === sessionId;
  room.players.delete(sessionId);
  if (wasHost) reassignHost(room);
  deleteRoomIfEmpty(room);
}

function teamCounts(room) {
  let t0 = 0;
  let t1 = 0;
  for (const p of room.players.values()) {
    if (p.team === 0) t0++;
    else t1++;
  }
  return { t0, t1 };
}

function pickTeam(room, requested) {
  if (room.gameMode !== 'deathmatch') return 0;
  const { t0, t1 } = teamCounts(room);
  if (requested === 0 || requested === 1) {
    if (requested === 0 && t0 < MAX_PER_TEAM) return 0;
    if (requested === 1 && t1 < MAX_PER_TEAM) return 1;
  }
  return t0 <= t1 ? 0 : 1;
}

/** @param {ReturnType<typeof createRoom>} room @param {string} sessionId */
function serializeRoom(room, sessionId) {
  const players = [];
  for (const [sid, pl] of room.players) {
    players.push({
      sessionId: sid,
      displayName: pl.displayName,
      characterPresetId: pl.characterPresetId,
      team: pl.team,
      ready: pl.ready,
      isHost: pl.isHost,
      eliminated: !!pl.eliminated,
    });
  }
  const out = {
    id: room.id,
    gameMode: room.gameMode,
    phase: room.phase,
    seed: room.seed,
    maxPlayers: room.maxPlayers,
    isPublic: room.isPublic,
    players,
    yourSessionId: sessionId,
    hostSessionId: room.hostSessionId ?? '',
  };
  if (room.gameMode === 'coop' && room.phase === 'active' && room.coop) {
    out.coop = {
      inventory: { ...room.coop.inventory },
      currency: room.coop.currency ?? 0,
      rev: room.coop.rev ?? 0,
    };
  }
  return out;
}

function initCoopRuntime(room) {
  if (room.gameMode === 'coop') {
    room.coop = { inventory: {}, currency: 0, rev: 0 };
  }
}

/** @param {ReturnType<typeof createRoom>} room */
function mergeCoopOp(room, add, sub, currencyDelta) {
  if (!room.coop) room.coop = { inventory: {}, currency: 0 };
  const inv = room.coop.inventory;
  for (const [k, v] of Object.entries(add || {})) {
    const n = Number(v) || 0;
    if (n <= 0) continue;
    inv[k] = (inv[k] ?? 0) + n;
  }
   for (const [k, v] of Object.entries(sub || {})) {
    const n = Number(v) || 0;
    if (n <= 0) continue;
    inv[k] = Math.max(0, (inv[k] ?? 0) - n);
  }
  const cd = Number(currencyDelta) || 0;
  if (cd !== 0) {
    if (cd > 0) room.coop.currency = (room.coop.currency ?? 0) + cd;
    else room.coop.currency = Math.max(0, (room.coop.currency ?? 0) + cd);
  }
  room.coop.rev = (room.coop.rev ?? 0) + 1;
}

/** @param {ReturnType<typeof createRoom>} room */
function broadcastCoopInv(room) {
  const payload = JSON.stringify({
    t: 'coop_inventory',
    inventory: { ...room.coop.inventory },
    currency: room.coop.currency ?? 0,
    rev: room.coop.rev ?? 0,
    v: PROTOCOL_VERSION,
  });
  forEachSocketInRoom(room.id, (s) => s.send(payload));
}

/** @param {ReturnType<typeof createRoom>} room */
function broadcastPvpAssignments(room) {
  const list = [...room.players.entries()].filter(([, p]) => !p.eliminated);
  if (room.gameMode === 'pvp' && list.length === 2) {
    const sa = list[0][0];
    const sb = list[1][0];
    for (const s of wss.clients) {
      if (s.readyState !== 1) continue;
      const m = s.icMeta;
      if (m?.roomId !== room.id) continue;
      const rival = m.sessionId === sa ? sb : m.sessionId === sb ? sa : null;
      if (!rival) continue;
      const pl = room.players.get(rival);
      s.send(
        JSON.stringify({
          t: 'pvp_assigned',
          rivalSessionId: rival,
          rivalName: pl?.displayName ?? 'Rival',
          rivalPreset: pl?.characterPresetId ?? 'vanguard',
          maxHp: 85,
          v: PROTOCOL_VERSION,
        }),
      );
    }
  } else if (room.gameMode === 'deathmatch') {
    const t0 = list.filter(([, p]) => p.team === 0);
    const t1 = list.filter(([, p]) => p.team === 1);
    if (t0.length && t1.length) {
      const sa = t0[0][0];
      const sb = t1[0][0];
      for (const s of wss.clients) {
        if (s.readyState !== 1) continue;
        const m = s.icMeta;
        if (m?.roomId !== room.id) continue;
        const myTeam = room.players.get(m.sessionId)?.team;
        let rival = null;
        if (myTeam === 0) rival = sb;
        else if (myTeam === 1) rival = sa;
        if (!rival || m.sessionId === rival) continue;
        const pl = room.players.get(rival);
        s.send(
          JSON.stringify({
            t: 'pvp_assigned',
            rivalSessionId: rival,
            rivalName: pl?.displayName ?? 'Rival',
            rivalPreset: pl?.characterPresetId ?? 'vanguard',
            maxHp: 90,
            v: PROTOCOL_VERSION,
          }),
        );
      }
    }
  }
}

/** @param {ReturnType<typeof createRoom>} room */
function tallyPvpVote(room) {
  const v = room.pvpVote;
  if (!v) return;
  const eligible = [...room.players.values()].filter((p) => !p.eliminated).length;
  let yes = 0;
  let no = 0;
  for (const val of v.votes.values()) {
    if (val === 'yes') yes++;
    else if (val === 'no') no++;
  }
  if (yes + no < eligible) return;
  const pass = yes > no;
  room.pvpVote = null;
  const msg = JSON.stringify({ t: 'pvp_vote_result', passed: pass, v: PROTOCOL_VERSION });
  forEachSocketInRoom(room.id, (s) => s.send(msg));
  if (pass && (room.gameMode === 'pvp' || room.gameMode === 'deathmatch')) {
    broadcastPvpAssignments(room);
  }
}

function broadcastRoom(room, exceptSocket, payload) {
  const data = JSON.stringify(payload);
  for (const s of wss.clients) {
    if (s.readyState !== 1) continue;
    if (s === exceptSocket) continue;
    const m = s.icMeta;
    if (m?.roomId === room.id) s.send(data);
  }
}

/** @param {string} roomId @param {(s: import('ws').WebSocket) => void} fn */
function forEachSocketInRoom(roomId, fn) {
  for (const s of wss.clients) {
    if (s.readyState !== 1) continue;
    if (s.icMeta?.roomId === roomId) fn(s);
  }
}

/** @param {import('ws').WebSocket} socket */
function getMeta(socket) {
  if (!socket.icMeta) {
    socket.icMeta = {
      sessionId: randomUUID(),
      roomId: null,
      helloOk: false,
      protocolVersion: 1,
    };
  }
  return socket.icMeta;
}

function leaveCurrentRoom(socket, broadcast) {
  const meta = getMeta(socket);
  if (!meta.roomId) return;
  const room = roomById.get(meta.roomId);
  meta.roomId = null;
  if (!room) return;
  removePlayerFromRoom(room, meta.sessionId);
  if (broadcast && room.players.size > 0) {
    for (const s of wss.clients) {
      if (s.readyState !== 1) continue;
      const m = s.icMeta;
      if (m?.roomId === room.id) {
        s.send(JSON.stringify({ t: 'room_snapshot', room: serializeRoom(room, m.sessionId), v: PROTOCOL_VERSION }));
      }
    }
  }
}

/** Remove session from every FIFO queue (e.g. after create/join room). */
function dequeueSessionEverywhere(sessionId) {
  for (const [mode, q] of queueByMode) {
    const ix = q.findIndex((e) => e.sessionId === sessionId);
    if (ix >= 0) {
      q.splice(ix, 1);
      if (q.length === 0) queueByMode.delete(mode);
      else notifyQueuePositions(mode);
    }
  }
}

/** Notify every socket still waiting in `mode`'s queue of position and depth (MOBA matchmaking UX). */
function notifyQueuePositions(mode) {
  const q = queueByMode.get(mode);
  if (!q) return;
  const payloadBase = { t: 'queue_status', mode, queueSize: q.length, v: PROTOCOL_VERSION };
  q.forEach((e, i) => {
    if (e.socket.readyState !== 1) return;
    e.socket.send(JSON.stringify({ ...payloadBase, position: i + 1 }));
  });
}

/**
 * @param {'pvp'|'deathmatch'} mode
 * @param {Array<{ sessionId: string, socket: import('ws').WebSocket, name: string, preset: string }>} batch
 */
function createRoomFromQueueBatch(mode, batch) {
  if (batch.length === 0) return;
  const host = batch[0];
  const room = createRoom(mode, host.sessionId, true);
  batch.forEach((entry, i) => {
    const team =
      mode === 'pvp' ? (i === 0 ? 0 : 1) : i % 2 === 0 ? 0 : 1;
    room.players.set(entry.sessionId, {
      displayName: entry.name,
      characterPresetId: entry.preset,
      team,
      ready: false,
      isHost: entry.sessionId === host.sessionId,
      eliminated: false,
    });
    entry.socket.icMeta.roomId = room.id;
  });
  reassignHost(room);
  for (const entry of batch) {
    const s = entry.socket;
    if (s.readyState !== 1) continue;
    const m = s.icMeta;
    s.send(JSON.stringify({ t: 'queue_matched', roomId: room.id, v: PROTOCOL_VERSION }));
    s.send(JSON.stringify({ t: 'room_snapshot', room: serializeRoom(room, m.sessionId), v: PROTOCOL_VERSION }));
  }
}

/** Pop full batches from FIFO queue: 2 for Hunter duel, {@link MOBA_3V3_QUEUE_SIZE} for 3v3. */
function tryDrainMatchmakingQueues(mode) {
  const q = queueByMode.get(mode);
  if (!q || q.length === 0) return;

  if (mode === 'pvp') {
    while (q.length >= 2) {
      const batch = [q.shift(), q.shift()];
      notifyQueuePositions(mode);
      createRoomFromQueueBatch('pvp', batch);
    }
    return;
  }

  if (mode === 'deathmatch') {
    while (q.length >= MOBA_3V3_QUEUE_SIZE) {
      const batch = q.splice(0, MOBA_3V3_QUEUE_SIZE);
      notifyQueuePositions(mode);
      createRoomFromQueueBatch('deathmatch', batch);
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

const wss = new WebSocketServer({ server });

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `[moba-magic-atoms rooms] v${PROTOCOL_VERSION} http+ws :${PORT} (GET /health) 3v3_queue=${MOBA_3V3_QUEUE_SIZE}`,
  );
});

setInterval(() => {
  const now = Date.now();
  for (const room of roomById.values()) {
    const inv = room.pvpDuelInvite;
    if (!inv || now <= inv.deadline) continue;
    room.pvpDuelInvite = null;
    const expired = JSON.stringify({ t: 'pvp_duel_expired', proposalId: inv.id, v: PROTOCOL_VERSION });
    forEachSocketInRoom(room.id, (s) => s.send(expired));
  }
}, 2500);

wss.on('connection', (socket) => {
  const meta = getMeta(socket);
  socket.send(JSON.stringify({ t: 'welcome', v: PROTOCOL_VERSION }));

  socket.on('close', () => {
    leaveCurrentRoom(socket, true);
    for (const [mode, q] of queueByMode) {
      const ix = q.findIndex((e) => e.sessionId === meta.sessionId);
      if (ix >= 0) {
        q.splice(ix, 1);
        if (q.length === 0) queueByMode.delete(mode);
        else notifyQueuePositions(mode);
      }
    }
  });

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      socket.send(JSON.stringify({ t: 'err', reason: 'invalid_json', v: PROTOCOL_VERSION }));
      return;
    }

    if (msg.t === 'hello') {
      meta.helloOk = true;
      meta.protocolVersion = Math.min(Number(msg.v) || 1, PROTOCOL_VERSION);
      socket.send(JSON.stringify({ t: 'hello_ok', v: meta.protocolVersion }));
      return;
    }

    if (!meta.helloOk) {
      socket.send(JSON.stringify({ t: 'err', reason: 'send_hello_first', v: PROTOCOL_VERSION }));
      return;
    }

    if (meta.protocolVersion < 3) {
      socket.send(JSON.stringify({ t: 'err', reason: 'protocol_v3_required', v: PROTOCOL_VERSION }));
      return;
    }

    if (msg.t === 'listRooms') {
      const filterMode = msg.gameMode && VALID_MODES.has(msg.gameMode) ? msg.gameMode : null;
      const rooms = [];
      for (const room of roomById.values()) {
        if (!room.isPublic) continue;
        const inLobby = room.phase === 'lobby';
        const coopLateJoin = room.gameMode === 'coop' && room.phase === 'active';
        if (!inLobby && !coopLateJoin) continue;
        if (filterMode && room.gameMode !== filterMode) continue;
        rooms.push({
          id: room.id,
          gameMode: room.gameMode,
          phase: room.phase,
          playerCount: room.players.size,
          maxPlayers: room.maxPlayers,
          isPublic: room.isPublic,
        });
      }
      socket.send(JSON.stringify({ t: 'room_list', rooms, v: PROTOCOL_VERSION }));
      return;
    }

    if (msg.t === 'createRoom') {
      const gameMode = VALID_MODES.has(msg.gameMode) ? msg.gameMode : 'coop';
      if (gameMode === 'solo') {
        socket.send(JSON.stringify({ t: 'err', reason: 'invalid_mode', v: PROTOCOL_VERSION }));
        return;
      }
      dequeueSessionEverywhere(meta.sessionId);
      leaveCurrentRoom(socket, true);
      const displayName = String(msg.displayName ?? 'Survivor').slice(0, 24);
      const preset = VALID_PRESETS.has(msg.characterPresetId) ? msg.characterPresetId : 'vanguard';
      const shadow = { gameMode, players: new Map() };
      const team = gameMode === 'deathmatch' ? pickTeam(shadow, Number(msg.team)) : 0;
      const room = createRoom(gameMode, meta.sessionId, msg.isPublic !== false);
      room.players.set(meta.sessionId, {
        displayName,
        characterPresetId: preset,
        team,
        ready: false,
        isHost: true,
        eliminated: false,
      });
      meta.roomId = room.id;
      socket.send(JSON.stringify({ t: 'room_snapshot', room: serializeRoom(room, meta.sessionId), v: PROTOCOL_VERSION }));
      return;
    }

    if (msg.t === 'joinRoom') {
      const rid = sanitizeRoomId(msg.roomId);
      if (!rid) {
        socket.send(JSON.stringify({ t: 'err', reason: 'bad_room_id', v: PROTOCOL_VERSION }));
        return;
      }
      const room = roomById.get(rid);
      if (!room) {
        socket.send(JSON.stringify({ t: 'err', reason: 'room_not_found', v: PROTOCOL_VERSION }));
        return;
      }
      if (room.phase !== 'lobby') {
        if (!(room.gameMode === 'coop' && room.phase === 'active')) {
          socket.send(JSON.stringify({ t: 'err', reason: 'room_locked', v: PROTOCOL_VERSION }));
          return;
        }
      }
      if (room.players.size >= room.maxPlayers) {
        socket.send(JSON.stringify({ t: 'err', reason: 'room_full', v: PROTOCOL_VERSION }));
        return;
      }
      dequeueSessionEverywhere(meta.sessionId);
      leaveCurrentRoom(socket, true);
      const displayName = String(msg.displayName ?? 'Survivor').slice(0, 24);
      const preset = VALID_PRESETS.has(msg.characterPresetId) ? msg.characterPresetId : 'vanguard';
      const team = room.gameMode === 'deathmatch' ? pickTeam(room, Number(msg.team)) : 0;
      room.players.set(meta.sessionId, {
        displayName,
        characterPresetId: preset,
        team,
        ready: false,
        isHost: false,
        eliminated: false,
      });
      meta.roomId = room.id;
      for (const s of wss.clients) {
        if (s.readyState !== 1) continue;
        const m = s.icMeta;
        if (m?.roomId === room.id) {
          s.send(JSON.stringify({ t: 'room_snapshot', room: serializeRoom(room, m.sessionId), v: PROTOCOL_VERSION }));
        }
      }
      return;
    }

    if (msg.t === 'leaveRoom') {
      leaveCurrentRoom(socket, true);
      socket.send(JSON.stringify({ t: 'left_room', v: PROTOCOL_VERSION }));
      return;
    }

    if (msg.t === 'setReady') {
      const room = meta.roomId ? roomById.get(meta.roomId) : null;
      if (!room) {
        socket.send(JSON.stringify({ t: 'err', reason: 'not_in_room', v: PROTOCOL_VERSION }));
        return;
      }
      const pl = room.players.get(meta.sessionId);
      if (!pl) {
        socket.send(JSON.stringify({ t: 'err', reason: 'not_in_room', v: PROTOCOL_VERSION }));
        return;
      }
      pl.ready = !!msg.ready;
      for (const s of wss.clients) {
        if (s.readyState !== 1) continue;
        const m = s.icMeta;
        if (m?.roomId === room.id) {
          s.send(JSON.stringify({ t: 'room_snapshot', room: serializeRoom(room, m.sessionId), v: PROTOCOL_VERSION }));
        }
      }
      return;
    }

    if (msg.t === 'lockStart') {
      const room = meta.roomId ? roomById.get(meta.roomId) : null;
      if (!room || room.hostSessionId !== meta.sessionId) {
        socket.send(JSON.stringify({ t: 'err', reason: 'host_only', v: PROTOCOL_VERSION }));
        return;
      }
      const min = minPlayersToStart(room.gameMode);
      if (room.players.size < min) {
        socket.send(JSON.stringify({ t: 'err', reason: 'not_enough_players', v: PROTOCOL_VERSION }));
        return;
      }
      if (room.gameMode === 'coop' && room.players.size === 1) {
        const hostPl = room.players.get(room.hostSessionId);
        if (!hostPl?.ready) {
          socket.send(JSON.stringify({ t: 'err', reason: 'host_not_ready', v: PROTOCOL_VERSION }));
          return;
        }
      } else {
        for (const pl of room.players.values()) {
          if (!pl.ready) {
            socket.send(JSON.stringify({ t: 'err', reason: 'not_all_ready', v: PROTOCOL_VERSION }));
            return;
          }
        }
      }
      room.phase = 'locked';
      for (const s of wss.clients) {
        if (s.readyState !== 1) continue;
        const m = s.icMeta;
        if (m?.roomId === room.id) {
          s.send(JSON.stringify({ t: 'room_snapshot', room: serializeRoom(room, m.sessionId), v: PROTOCOL_VERSION }));
        }
      }
      return;
    }

    if (msg.t === 'beginActive') {
      const room = meta.roomId ? roomById.get(meta.roomId) : null;
      if (!room || room.hostSessionId !== meta.sessionId) {
        socket.send(JSON.stringify({ t: 'err', reason: 'host_only', v: PROTOCOL_VERSION }));
        return;
      }
      if (room.phase !== 'locked') {
        socket.send(JSON.stringify({ t: 'err', reason: 'must_lock_first', v: PROTOCOL_VERSION }));
        return;
      }
      room.phase = 'active';
      room.pvpVote = null;
      initCoopRuntime(room);
      for (const s of wss.clients) {
        if (s.readyState !== 1) continue;
        const m = s.icMeta;
        if (m?.roomId === room.id) {
          s.send(JSON.stringify({ t: 'room_snapshot', room: serializeRoom(room, m.sessionId), v: PROTOCOL_VERSION }));
        }
      }
      if (room.gameMode === 'coop' && room.coop) broadcastCoopInv(room);
      return;
    }

    if (msg.t === 'queueJoin') {
      const mode = VALID_MODES.has(msg.gameMode) ? msg.gameMode : 'pvp';
      if (mode === 'solo' || mode === 'coop') {
        socket.send(JSON.stringify({ t: 'err', reason: 'use_create_room', v: PROTOCOL_VERSION }));
        return;
      }
      leaveCurrentRoom(socket, true);
      let q = queueByMode.get(mode);
      if (!q) {
        q = [];
        queueByMode.set(mode, q);
      }
      if (!q.some((e) => e.sessionId === meta.sessionId)) {
        q.push({
          sessionId: meta.sessionId,
          socket,
          name: String(msg.displayName ?? 'Survivor').slice(0, 24),
          preset: VALID_PRESETS.has(msg.characterPresetId) ? msg.characterPresetId : 'vanguard',
        });
      }
      notifyQueuePositions(mode);
      tryDrainMatchmakingQueues(mode);
      return;
    }

    if (msg.t === 'queueLeave') {
      let left = false;
      for (const [mode, q] of queueByMode) {
        const ix = q.findIndex((e) => e.sessionId === meta.sessionId);
        if (ix >= 0) {
          q.splice(ix, 1);
          left = true;
          if (q.length === 0) queueByMode.delete(mode);
          else notifyQueuePositions(mode);
          socket.send(JSON.stringify({ t: 'left_queue', mode, v: PROTOCOL_VERSION }));
          break;
        }
      }
      if (!left) {
        socket.send(JSON.stringify({ t: 'err', reason: 'not_in_queue', v: PROTOCOL_VERSION }));
      }
      return;
    }

    if (msg.t === 'roomChat') {
      const room = meta.roomId ? roomById.get(meta.roomId) : null;
      if (!room) {
        socket.send(JSON.stringify({ t: 'err', reason: 'not_in_room', v: PROTOCOL_VERSION }));
        return;
      }
      const pl = room.players.get(meta.sessionId);
      const text = String(msg.text ?? '').trim().slice(0, 500);
      if (!text) return;
      const payload = JSON.stringify({
        t: 'room_chat',
        fromSessionId: meta.sessionId,
        displayName: pl?.displayName ?? 'Survivor',
        text,
        ts: Date.now(),
        v: PROTOCOL_VERSION,
      });
      forEachSocketInRoom(room.id, (s) => s.send(payload));
      return;
    }

    if (msg.t === 'voiceSignal') {
      const room = meta.roomId ? roomById.get(meta.roomId) : null;
      if (!room) {
        socket.send(JSON.stringify({ t: 'err', reason: 'not_in_room', v: PROTOCOL_VERSION }));
        return;
      }
      const toSid = String(msg.toSessionId ?? '');
      if (!toSid || !room.players.has(toSid) || !room.players.has(meta.sessionId)) {
        socket.send(JSON.stringify({ t: 'err', reason: 'voice_bad_peer', v: PROTOCOL_VERSION }));
        return;
      }
      const kind = String(msg.kind ?? '');
      if (kind !== 'offer' && kind !== 'answer' && kind !== 'candidate') {
        socket.send(JSON.stringify({ t: 'err', reason: 'voice_bad_kind', v: PROTOCOL_VERSION }));
        return;
      }
      let targetSocket = null;
      for (const s of wss.clients) {
        if (s.readyState !== 1) continue;
        if (s.icMeta?.sessionId === toSid && s.icMeta?.roomId === room.id) {
          targetSocket = s;
          break;
        }
      }
      if (!targetSocket) {
        socket.send(JSON.stringify({ t: 'err', reason: 'voice_peer_offline', v: PROTOCOL_VERSION }));
        return;
      }
      targetSocket.send(
        JSON.stringify({
          t: 'voice_signal',
          fromSessionId: meta.sessionId,
          kind,
          sdp: msg.sdp ?? null,
          candidate: msg.candidate ?? null,
          v: PROTOCOL_VERSION,
        }),
      );
      return;
    }

    if (msg.t === 'coopOp') {
      const room = meta.roomId ? roomById.get(meta.roomId) : null;
      if (!room || room.gameMode !== 'coop' || room.phase !== 'active') {
        socket.send(JSON.stringify({ t: 'err', reason: 'no_coop_session', v: PROTOCOL_VERSION }));
        return;
      }
      mergeCoopOp(room, msg.add ?? {}, msg.sub ?? {}, msg.currencyDelta);
      broadcastCoopInv(room);
      return;
    }

    if (msg.t === 'coopReplace') {
      const room = meta.roomId ? roomById.get(meta.roomId) : null;
      if (!room || room.gameMode !== 'coop' || room.phase !== 'active') {
        socket.send(JSON.stringify({ t: 'err', reason: 'no_coop_session', v: PROTOCOL_VERSION }));
        return;
      }
      if (room.hostSessionId !== meta.sessionId) {
        socket.send(JSON.stringify({ t: 'err', reason: 'host_only_coop_replace', v: PROTOCOL_VERSION }));
        return;
      }
      const inv = msg.inventory && typeof msg.inventory === 'object' ? msg.inventory : {};
      const cur = Number(msg.currency) || 0;
      const nextRev = (room.coop?.rev ?? 0) + 1;
      room.coop = {
        inventory: { ...inv },
        currency: Math.max(0, cur),
        rev: nextRev,
      };
      broadcastCoopInv(room);
      return;
    }

    if (msg.t === 'presence') {
      const room = meta.roomId ? roomById.get(meta.roomId) : null;
      if (!room || room.phase !== 'active') {
        socket.send(JSON.stringify({ t: 'err', reason: 'presence_bad_room', v: PROTOCOL_VERSION }));
        return;
      }
      if (!room.players.has(meta.sessionId)) {
        socket.send(JSON.stringify({ t: 'err', reason: 'not_in_room', v: PROTOCOL_VERSION }));
        return;
      }
      const now = Date.now();
      if (!room.presenceLast) room.presenceLast = new Map();
      const last = room.presenceLast.get(meta.sessionId) ?? 0;
      if (now - last < PRESENCE_MIN_INTERVAL_MS) return;
      room.presenceLast.set(meta.sessionId, now);
      const page = String(msg.page ?? '').slice(0, 24);
      const gk = msg.gatherKey != null ? String(msg.gatherKey).slice(0, 48) : null;
      let p01 = null;
      if (msg.progress01 != null) {
        const p = Number(msg.progress01);
        if (!Number.isNaN(p)) p01 = Math.max(0, Math.min(1, p));
      }
      const seq = Number(msg.seq) || 0;
      const realm = msg.realm === 'awakened' ? 'awakened' : 'deck';
      const clampW = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(-800, Math.min(800, n)) : null;
      };
      /** @type {Record<string, unknown>} */
      const row = {
        t: 'presence_update',
        sessionId: meta.sessionId,
        page,
        gatherKey: gk,
        progress01: p01,
        seq,
        realm,
        v: PROTOCOL_VERSION,
      };
      if (realm === 'awakened') {
        row.wx = clampW(msg.wx);
        row.wy = clampW(msg.wy);
        row.wz = clampW(msg.wz);
        const yaw = Number(msg.wyaw);
        row.wyaw = Number.isFinite(yaw) ? yaw : null;
      }
      const payload = JSON.stringify(row);
      forEachSocketInRoom(room.id, (s) => s.send(payload));
      return;
    }

    if (msg.t === 'pvpProposeBattle') {
      const room = meta.roomId ? roomById.get(meta.roomId) : null;
      if (!room || room.phase !== 'active' || (room.gameMode !== 'pvp' && room.gameMode !== 'deathmatch')) {
        socket.send(JSON.stringify({ t: 'err', reason: 'pvp_vote_bad_room', v: PROTOCOL_VERSION }));
        return;
      }
      const targetSid = String(msg.targetSessionId ?? '');
      if (room.gameMode === 'pvp') {
        const activeList = [...room.players.entries()].filter(([, p]) => !p.eliminated);
        if (activeList.length !== 2) {
          socket.send(JSON.stringify({ t: 'err', reason: 'pvp_need_two', v: PROTOCOL_VERSION }));
          return;
        }
        if (!targetSid || targetSid === meta.sessionId || !room.players.has(targetSid)) {
          socket.send(JSON.stringify({ t: 'err', reason: 'pvp_bad_target', v: PROTOCOL_VERSION }));
          return;
        }
        room.pvpDuelInvite = {
          id: randomUUID(),
          proposer: meta.sessionId,
          target: targetSid,
          deadline: Date.now() + DUEL_INVITE_MS,
        };
        const proposerPl = room.players.get(meta.sessionId);
        const invitePayload = JSON.stringify({
          t: 'pvp_duel_invite',
          proposalId: room.pvpDuelInvite.id,
          proposerSessionId: meta.sessionId,
          proposerName: proposerPl?.displayName ?? 'Survivor',
          v: PROTOCOL_VERSION,
        });
        const pendingPayload = JSON.stringify({
          t: 'pvp_duel_pending',
          proposalId: room.pvpDuelInvite.id,
          targetSessionId: targetSid,
          v: PROTOCOL_VERSION,
        });
        for (const s of wss.clients) {
          if (s.readyState !== 1) continue;
          const m = s.icMeta;
          if (m?.roomId !== room.id) continue;
          if (m.sessionId === targetSid) s.send(invitePayload);
          else if (m.sessionId === meta.sessionId) s.send(pendingPayload);
        }
        return;
      }
      room.pvpVote = {
        id: randomUUID(),
        proposer: meta.sessionId,
        votes: new Map(),
      };
      const pl = room.players.get(meta.sessionId);
      const start = JSON.stringify({
        t: 'pvp_vote_start',
        proposalId: room.pvpVote.id,
        proposerName: pl?.displayName ?? 'Survivor',
        v: PROTOCOL_VERSION,
      });
      forEachSocketInRoom(room.id, (s) => s.send(start));
      return;
    }

    if (msg.t === 'pvpDuelRespond') {
      const room = meta.roomId ? roomById.get(meta.roomId) : null;
      if (!room || room.gameMode !== 'pvp') {
        socket.send(JSON.stringify({ t: 'err', reason: 'pvp_duel_bad_room', v: PROTOCOL_VERSION }));
        return;
      }
      const inv = room.pvpDuelInvite;
      const pid = String(msg.proposalId ?? '');
      if (!inv || inv.id !== pid) {
        socket.send(JSON.stringify({ t: 'err', reason: 'pvp_no_invite', v: PROTOCOL_VERSION }));
        return;
      }
      if (meta.sessionId !== inv.target) {
        socket.send(JSON.stringify({ t: 'err', reason: 'pvp_not_invitee', v: PROTOCOL_VERSION }));
        return;
      }
      if (Date.now() > inv.deadline) {
        room.pvpDuelInvite = null;
        socket.send(JSON.stringify({ t: 'err', reason: 'pvp_invite_expired', v: PROTOCOL_VERSION }));
        return;
      }
      const accept = !!msg.accept;
      room.pvpDuelInvite = null;
      if (!accept) {
        const decline = JSON.stringify({
          t: 'pvp_duel_declined',
          proposalId: pid,
          bySessionId: meta.sessionId,
          v: PROTOCOL_VERSION,
        });
        forEachSocketInRoom(room.id, (s) => s.send(decline));
        return;
      }
      broadcastPvpAssignments(room);
      return;
    }

    if (msg.t === 'pvpVoteBattle') {
      const room = meta.roomId ? roomById.get(meta.roomId) : null;
      if (!room || !room.pvpVote) {
        socket.send(JSON.stringify({ t: 'err', reason: 'no_active_vote', v: PROTOCOL_VERSION }));
        return;
      }
      const accept = !!msg.accept;
      room.pvpVote.votes.set(meta.sessionId, accept ? 'yes' : 'no');
      tallyPvpVote(room);
      return;
    }

    if (msg.t === 'pvpStrike') {
      const room = meta.roomId ? roomById.get(meta.roomId) : null;
      if (!room || room.phase !== 'active') {
        socket.send(JSON.stringify({ t: 'err', reason: 'no_active_match', v: PROTOCOL_VERSION }));
        return;
      }
      const toSid = String(msg.toSessionId ?? '');
      const dmg = Math.max(0, Math.min(500, Number(msg.damage) || 0));
      if (!toSid || !room.players.has(toSid) || !room.players.has(meta.sessionId)) {
        socket.send(JSON.stringify({ t: 'err', reason: 'pvp_bad_target', v: PROTOCOL_VERSION }));
        return;
      }
      const cardName = String(msg.cardName ?? '').slice(0, 48);
      if (!room.pvpStrikeSeq) room.pvpStrikeSeq = 0;
      room.pvpStrikeSeq += 1;
      const strikeSeq = room.pvpStrikeSeq;
      const hit = JSON.stringify({
        t: 'pvp_hit',
        fromSessionId: meta.sessionId,
        toSessionId: toSid,
        damage: dmg,
        cardName,
        strikeSeq,
        v: PROTOCOL_VERSION,
      });
      forEachSocketInRoom(room.id, (s) => s.send(hit));
      return;
    }

    if (msg.t === 'pvpRivalDefeated') {
      const room = meta.roomId ? roomById.get(meta.roomId) : null;
      if (!room || room.phase !== 'active') return;
      const loser = String(msg.loserSessionId ?? '');
      if (!room.players.has(loser)) return;
      const pl = room.players.get(loser);
      if (pl) pl.eliminated = true;
      const note = JSON.stringify({
        t: 'pvp_rival_defeated',
        loserSessionId: loser,
        v: PROTOCOL_VERSION,
      });
      forEachSocketInRoom(room.id, (s) => s.send(note));
      for (const s of wss.clients) {
        if (s.readyState !== 1) continue;
        const m = s.icMeta;
        if (m?.roomId === room.id) {
          s.send(JSON.stringify({ t: 'room_snapshot', room: serializeRoom(room, m.sessionId), v: PROTOCOL_VERSION }));
        }
      }
      return;
    }

    if (msg.t === 'battleIntent') {
      const room = meta.roomId ? roomById.get(meta.roomId) : null;
      if (!room || room.phase !== 'active') {
        socket.send(JSON.stringify({ t: 'err', reason: 'no_active_match', v: PROTOCOL_VERSION }));
        return;
      }
      if (room.gameMode === 'coop') {
        socket.send(JSON.stringify({ t: 'battle_intent_ok', accepted: true, coopShared: true, v: PROTOCOL_VERSION }));
        return;
      }
      socket.send(JSON.stringify({ t: 'battle_intent_ok', accepted: true, validated: 'stub_authority', v: PROTOCOL_VERSION }));
      return;
    }

    socket.send(JSON.stringify({ t: 'echo', body: msg, v: PROTOCOL_VERSION }));
  });
});
