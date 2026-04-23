/**
 * WebSocket lobby client — protocol v3 (see server/room-server.mjs).
 * Set VITE_ROOM_WS_URL. Does not auto-join a room; lobby UI drives create/join/queue.
 */
import { CHARACTER_PRESET_IDS } from '../data/characterPresets';
import type { CharacterPresetId, GameMode } from '../core/types';
import {
  ROOM_PROTOCOL_V,
  type PresenceRealmMode,
  type PublicRoomSummary,
  type RoomHubEvent,
  type RoomSnapshot,
  type VoiceSignalKind,
} from './roomTypes';

export { ROOM_PROTOCOL_V };

export type RoomHubConnState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

type ConnListener = (state: RoomHubConnState, detail?: string) => void;
type EventListener = (ev: RoomHubEvent) => void;

let singleton: RoomHub | null = null;

export function getRoomHub(): RoomHub {
  if (!singleton) singleton = new RoomHub();
  return singleton;
}

/** Fly app default when no env is set (production builds). */
const PROD_LOBBY_WSS = 'wss://moba-rooms.fly.dev';

/**
 * WebSocket URL for the lobby server.
 * - `VITE_ROOM_WS_URL` in `.env.local` / Netlify overrides everything.
 * - Dev fallback: `ws://<hostname>:3334` (run `npm start` in `/server`).
 * - Prod fallback: Fly URL above (no Netlify env required).
 */
export function getLobbyWebSocketUrl(): string | undefined {
  const envUrl = import.meta.env.VITE_ROOM_WS_URL;
  if (typeof envUrl === 'string' && envUrl.trim().length > 0) {
    return envUrl.trim();
  }
  if (import.meta.env.DEV) {
    const host = typeof globalThis.location !== 'undefined' ? globalThis.location.hostname : 'localhost';
    return `ws://${host}:3334`;
  }
  return PROD_LOBBY_WSS;
}

/** Connect using {@link getLobbyWebSocketUrl}. */
export function initRoomHubFromEnv(): void {
  const url = getLobbyWebSocketUrl();
  if (url) getRoomHub().connect(url);
}

function normalizeSnapshot(raw: Record<string, unknown>, yourSessionId: string): RoomSnapshot | null {
  const playersRaw = raw.players;
  if (!Array.isArray(playersRaw)) return null;
  const players = playersRaw.map((p) => {
    const o = p as Record<string, unknown>;
    const pid = typeof o.characterPresetId === 'string' ? o.characterPresetId : 'vanguard';
    const preset: CharacterPresetId = CHARACTER_PRESET_IDS.has(pid as CharacterPresetId)
      ? (pid as CharacterPresetId)
      : 'vanguard';
    const team: 0 | 1 = o.team === 1 ? 1 : 0;
    return {
      sessionId: String(o.sessionId ?? ''),
      displayName: String(o.displayName ?? 'Survivor'),
      characterPresetId: preset,
      team,
      ready: !!o.ready,
      isHost: !!o.isHost,
      eliminated: !!o.eliminated,
    };
  });
  const mode = typeof raw.gameMode === 'string' ? raw.gameMode : 'coop';
  const gameMode: GameMode =
    mode === 'solo' || mode === 'coop' || mode === 'pvp' || mode === 'deathmatch' ? mode : 'coop';
  const phase = raw.phase === 'locked' || raw.phase === 'active' ? raw.phase : 'lobby';
  const coopRaw = raw.coop as Record<string, unknown> | undefined;
  let coop: RoomSnapshot['coop'];
  if (coopRaw && typeof coopRaw.inventory === 'object' && coopRaw.inventory != null) {
    const inv: Record<string, number> = {};
    for (const [k, v] of Object.entries(coopRaw.inventory as Record<string, unknown>)) {
      inv[k] = Number(v) || 0;
    }
    const revRaw = coopRaw.rev;
    coop = {
      inventory: inv,
      currency: Number(coopRaw.currency) || 0,
      ...(revRaw !== undefined ? { rev: Number(revRaw) || 0 } : {}),
    };
  }
  const hostSid =
    typeof raw.hostSessionId === 'string' && raw.hostSessionId.length > 0
      ? raw.hostSessionId
      : players.find((p) => p.isHost)?.sessionId ?? '';
  return {
    id: String(raw.id ?? ''),
    gameMode,
    phase,
    seed: Number(raw.seed) >>> 0,
    maxPlayers: Math.max(1, Math.min(6, Number(raw.maxPlayers) || 6)),
    isPublic: !!raw.isPublic,
    players,
    yourSessionId,
    ...(hostSid ? { hostSessionId: hostSid } : {}),
    ...(coop ? { coop } : {}),
  };
}

export class RoomHub {
  private ws: WebSocket | null = null;
  private state: RoomHubConnState = 'idle';
  private connListeners = new Set<ConnListener>();
  private eventListeners = new Set<EventListener>();
  private helloOk = false;
  /** Messages sent before hello_ok (e.g. listRooms on lobby mount). */
  private outbox: Record<string, unknown>[] = [];

  subscribeConnection(fn: ConnListener): () => void {
    this.connListeners.add(fn);
    fn(this.state);
    return () => {
      this.connListeners.delete(fn);
    };
  }

  subscribeEvents(fn: EventListener): () => void {
    this.eventListeners.add(fn);
    return () => {
      this.eventListeners.delete(fn);
    };
  }

  getState(): RoomHubConnState {
    return this.state;
  }

  connect(url: string): void {
    this.disconnect();
    this.helloOk = false;
    this.setConnState('connecting');
    try {
      const socket = new WebSocket(url);
      this.ws = socket;
      socket.addEventListener('open', () => {
        this.setConnState('open');
        socket.send(JSON.stringify({ t: 'hello', v: ROOM_PROTOCOL_V }));
      });
      socket.addEventListener('message', (ev) => {
        this.onMessage(ev.data);
      });
      socket.addEventListener('close', () => {
        this.ws = null;
        this.helloOk = false;
        this.setConnState('closed');
      });
      socket.addEventListener('error', () => {
        this.setConnState('error', 'socket error');
      });
    } catch (e) {
      this.setConnState('error', e instanceof Error ? e.message : 'connect failed');
    }
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.helloOk = false;
    this.outbox = [];
    if (this.state !== 'idle') this.setConnState('idle');
  }

  private send(msg: Record<string, unknown>): void {
    const payload = { ...msg, v: ROOM_PROTOCOL_V };
    if (!this.ws) return;
    const rs = this.ws.readyState;
    if (rs === WebSocket.CLOSING || rs === WebSocket.CLOSED) return;
    /* Queue until socket is open and hello_ok — avoids dropping listRooms / chat during CONNECTING. */
    if (rs === WebSocket.CONNECTING || !this.helloOk) {
      this.outbox.push(payload);
      return;
    }
    if (rs !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  private flushOutbox(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.helloOk) return;
    while (this.outbox.length) {
      const payload = this.outbox.shift()!;
      this.ws.send(JSON.stringify(payload));
    }
  }

  listRooms(gameMode?: GameMode): void {
    this.send({ t: 'listRooms', ...(gameMode ? { gameMode } : {}) });
  }

  createRoom(opts: {
    gameMode: GameMode;
    displayName: string;
    characterPresetId: CharacterPresetId;
    team?: 0 | 1;
    isPublic?: boolean;
  }): void {
    this.send({
      t: 'createRoom',
      gameMode: opts.gameMode,
      displayName: opts.displayName,
      characterPresetId: opts.characterPresetId,
      team: opts.team ?? 0,
      isPublic: opts.isPublic !== false,
    });
  }

  joinRoom(opts: {
    roomId: string;
    displayName: string;
    characterPresetId: CharacterPresetId;
    team?: 0 | 1;
  }): void {
    this.send({
      t: 'joinRoom',
      roomId: opts.roomId,
      displayName: opts.displayName,
      characterPresetId: opts.characterPresetId,
      team: opts.team ?? 0,
    });
  }

  leaveRoom(): void {
    this.send({ t: 'leaveRoom' });
  }

  setReady(ready: boolean): void {
    this.send({ t: 'setReady', ready });
  }

  lockStart(): void {
    this.send({ t: 'lockStart' });
  }

  beginActive(): void {
    this.send({ t: 'beginActive' });
  }

  queueJoin(opts: { gameMode: GameMode; displayName: string; characterPresetId: CharacterPresetId }): void {
    this.send({
      t: 'queueJoin',
      gameMode: opts.gameMode,
      displayName: opts.displayName,
      characterPresetId: opts.characterPresetId,
    });
  }

  queueLeave(): void {
    this.send({ t: 'queueLeave' });
  }

  battleIntent(payload: Record<string, unknown>): void {
    this.send({ t: 'battleIntent', ...payload });
  }

  coopOp(payload: { add?: Record<string, number>; sub?: Record<string, number>; currencyDelta?: number }): void {
    this.send({ t: 'coopOp', ...payload });
  }

  coopReplace(payload: { inventory: Record<string, number>; currency: number }): void {
    this.send({ t: 'coopReplace', ...payload });
  }

  pvpProposeBattle(opts?: { targetSessionId?: string }): void {
    this.send({
      t: 'pvpProposeBattle',
      ...(opts?.targetSessionId ? { targetSessionId: opts.targetSessionId } : {}),
    });
  }

  pvpDuelRespond(proposalId: string, accept: boolean): void {
    this.send({ t: 'pvpDuelRespond', proposalId, accept });
  }

  pvpVoteBattle(accept: boolean): void {
    this.send({ t: 'pvpVoteBattle', accept });
  }

  sendPresence(payload: {
    page: string;
    gatherKey?: string | null;
    progress01?: number | null;
    seq: number;
    realm?: PresenceRealmMode;
    wx?: number;
    wy?: number;
    wz?: number;
    wyaw?: number;
  }): void {
    this.send({
      t: 'presence',
      page: payload.page,
      ...(payload.gatherKey != null ? { gatherKey: payload.gatherKey } : {}),
      ...(payload.progress01 != null ? { progress01: payload.progress01 } : {}),
      seq: payload.seq,
      ...(payload.realm != null ? { realm: payload.realm } : {}),
      ...(payload.wx != null && Number.isFinite(payload.wx) ? { wx: payload.wx } : {}),
      ...(payload.wy != null && Number.isFinite(payload.wy) ? { wy: payload.wy } : {}),
      ...(payload.wz != null && Number.isFinite(payload.wz) ? { wz: payload.wz } : {}),
      ...(payload.wyaw != null && Number.isFinite(payload.wyaw) ? { wyaw: payload.wyaw } : {}),
    });
  }

  pvpStrike(payload: { toSessionId: string; damage: number; cardName: string }): void {
    this.send({ t: 'pvpStrike', ...payload });
  }

  pvpRivalDefeated(loserSessionId: string): void {
    this.send({ t: 'pvpRivalDefeated', loserSessionId });
  }

  sendRoomChat(text: string): void {
    this.send({ t: 'roomChat', text });
  }

  sendVoiceSignal(opts: {
    toSessionId: string;
    kind: VoiceSignalKind;
    sdp?: string;
    candidate?: RTCIceCandidateInit;
  }): void {
    this.send({
      t: 'voiceSignal',
      toSessionId: opts.toSessionId,
      kind: opts.kind,
      ...(opts.sdp != null ? { sdp: opts.sdp } : {}),
      ...(opts.candidate != null ? { candidate: opts.candidate } : {}),
    });
  }

  private emit(ev: RoomHubEvent): void {
    for (const fn of this.eventListeners) fn(ev);
  }

  private onMessage(raw: unknown): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw as ArrayBuffer));
    } catch {
      return;
    }
    const t = msg.t;
    if (t === 'hello_ok') {
      this.helloOk = true;
      this.flushOutbox();
      return;
    }
    if (t === 'room_snapshot') {
      const r = msg.room as Record<string, unknown> | undefined;
      if (!r) return;
      const yid = typeof r.yourSessionId === 'string' ? r.yourSessionId : '';
      if (!yid) return;
      const snap = normalizeSnapshot(r, yid);
      if (snap) this.emit({ type: 'snapshot', room: snap });
      return;
    }
    if (t === 'room_list') {
      const roomsRaw = msg.rooms;
      if (!Array.isArray(roomsRaw)) return;
      const rooms: PublicRoomSummary[] = roomsRaw.map((row) => {
        const o = row as Record<string, unknown>;
        const mode = typeof o.gameMode === 'string' ? o.gameMode : 'coop';
        const gameMode: GameMode =
          mode === 'solo' || mode === 'coop' || mode === 'pvp' || mode === 'deathmatch' ? mode : 'coop';
        const phase = o.phase === 'locked' || o.phase === 'active' ? o.phase : 'lobby';
        return {
          id: String(o.id ?? ''),
          gameMode,
          phase,
          playerCount: Number(o.playerCount) || 0,
          maxPlayers: Number(o.maxPlayers) || 6,
          isPublic: !!o.isPublic,
        };
      });
      this.emit({ type: 'room_list', rooms });
      return;
    }
    if (t === 'queue_status') {
      const mode = typeof msg.mode === 'string' ? msg.mode : 'pvp';
      const gameMode: GameMode =
        mode === 'solo' || mode === 'coop' || mode === 'pvp' || mode === 'deathmatch' ? mode : 'pvp';
      const queueSize = msg.queueSize !== undefined ? Number(msg.queueSize) : undefined;
      this.emit({
        type: 'queue_status',
        position: Number(msg.position) || 0,
        mode: gameMode,
        ...(queueSize !== undefined && Number.isFinite(queueSize) ? { queueSize } : {}),
      });
      return;
    }
    if (t === 'left_queue') {
      const mode = typeof msg.mode === 'string' ? msg.mode : 'pvp';
      const gameMode: GameMode =
        mode === 'solo' || mode === 'coop' || mode === 'pvp' || mode === 'deathmatch' ? mode : 'pvp';
      this.emit({ type: 'left_queue', mode: gameMode });
      return;
    }
    if (t === 'queue_matched') {
      const roomId = String(msg.roomId ?? '');
      if (roomId) this.emit({ type: 'queue_matched', roomId });
      return;
    }
    if (t === 'battle_intent_ok') {
      this.emit({ type: 'battle_intent_ok', echo: msg as Record<string, unknown> });
      return;
    }
    if (t === 'coop_inventory') {
      const invRaw = msg.inventory;
      const inv: Record<string, number> = {};
      if (invRaw && typeof invRaw === 'object') {
        for (const [k, v] of Object.entries(invRaw as Record<string, unknown>)) {
          inv[k] = Number(v) || 0;
        }
      }
      const rev = msg.rev !== undefined ? Number(msg.rev) || 0 : undefined;
      this.emit({
        type: 'coop_inventory',
        inventory: inv,
        currency: Number(msg.currency) || 0,
        ...(rev !== undefined ? { rev } : {}),
      });
      return;
    }
    if (t === 'pvp_assigned') {
      const pid = typeof msg.rivalPreset === 'string' ? msg.rivalPreset : 'vanguard';
      const rivalPreset: CharacterPresetId = CHARACTER_PRESET_IDS.has(pid as CharacterPresetId)
        ? (pid as CharacterPresetId)
        : 'vanguard';
      this.emit({
        type: 'pvp_assigned',
        rivalSessionId: String(msg.rivalSessionId ?? ''),
        rivalName: String(msg.rivalName ?? 'Rival'),
        rivalPreset,
        maxHp: Math.max(1, Math.min(500, Number(msg.maxHp) || 85)),
      });
      return;
    }
    if (t === 'pvp_vote_start') {
      this.emit({
        type: 'pvp_vote_start',
        proposalId: String(msg.proposalId ?? ''),
        proposerName: String(msg.proposerName ?? 'Survivor'),
      });
      return;
    }
    if (t === 'pvp_vote_result') {
      this.emit({ type: 'pvp_vote_result', passed: !!msg.passed });
      return;
    }
    if (t === 'pvp_hit') {
      this.emit({
        type: 'pvp_hit',
        fromSessionId: String(msg.fromSessionId ?? ''),
        toSessionId: String(msg.toSessionId ?? ''),
        damage: Math.max(0, Number(msg.damage) || 0),
        cardName: String(msg.cardName ?? ''),
        strikeSeq: Math.max(0, Number(msg.strikeSeq) || 0),
      });
      return;
    }
    if (t === 'presence_update') {
      const realmRaw = msg.realm;
      const realm = realmRaw === 'awakened' ? 'awakened' : 'deck';
      const clampWorld = (v: unknown): number | null => {
        if (v == null) return null;
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        return Math.max(-800, Math.min(800, n));
      };
      const yawRaw = msg.wyaw;
      const wyaw =
        yawRaw != null && Number.isFinite(Number(yawRaw)) ? Number(yawRaw) : null;
      this.emit({
        type: 'presence_update',
        sessionId: String(msg.sessionId ?? ''),
        page: String(msg.page ?? ''),
        gatherKey: msg.gatherKey != null ? String(msg.gatherKey) : null,
        progress01:
          msg.progress01 != null && !Number.isNaN(Number(msg.progress01))
            ? Math.max(0, Math.min(1, Number(msg.progress01)))
            : null,
        seq: Number(msg.seq) || 0,
        realm,
        wx: realm === 'awakened' ? clampWorld(msg.wx) : null,
        wy: realm === 'awakened' ? clampWorld(msg.wy) : null,
        wz: realm === 'awakened' ? clampWorld(msg.wz) : null,
        wyaw: realm === 'awakened' ? wyaw : null,
      });
      return;
    }
    if (t === 'pvp_duel_invite') {
      this.emit({
        type: 'pvp_duel_invite',
        proposalId: String(msg.proposalId ?? ''),
        proposerSessionId: String(msg.proposerSessionId ?? ''),
        proposerName: String(msg.proposerName ?? 'Survivor'),
      });
      return;
    }
    if (t === 'pvp_duel_pending') {
      this.emit({
        type: 'pvp_duel_pending',
        proposalId: String(msg.proposalId ?? ''),
        targetSessionId: String(msg.targetSessionId ?? ''),
      });
      return;
    }
    if (t === 'pvp_duel_declined') {
      this.emit({
        type: 'pvp_duel_declined',
        proposalId: String(msg.proposalId ?? ''),
        bySessionId: String(msg.bySessionId ?? ''),
      });
      return;
    }
    if (t === 'pvp_duel_expired') {
      this.emit({
        type: 'pvp_duel_expired',
        proposalId: String(msg.proposalId ?? ''),
      });
      return;
    }
    if (t === 'pvp_rival_defeated') {
      this.emit({ type: 'pvp_rival_defeated', loserSessionId: String(msg.loserSessionId ?? '') });
      return;
    }
    if (t === 'room_chat') {
      this.emit({
        type: 'room_chat',
        message: {
          fromSessionId: String(msg.fromSessionId ?? ''),
          displayName: String(msg.displayName ?? 'Survivor'),
          text: String(msg.text ?? ''),
          ts: Number(msg.ts) || Date.now(),
        },
      });
      return;
    }
    if (t === 'voice_signal') {
      const kindRaw = String(msg.kind ?? '');
      const kind: VoiceSignalKind =
        kindRaw === 'offer' || kindRaw === 'answer' || kindRaw === 'candidate' ? kindRaw : 'candidate';
      const cand = msg.candidate;
      const candidate: RTCIceCandidateInit | null =
        cand && typeof cand === 'object'
          ? (cand as RTCIceCandidateInit)
          : typeof cand === 'string'
            ? { candidate: cand }
            : null;
      this.emit({
        type: 'voice_signal',
        fromSessionId: String(msg.fromSessionId ?? ''),
        kind,
        sdp: typeof msg.sdp === 'string' ? msg.sdp : null,
        candidate,
      });
      return;
    }
    if (t === 'err') {
      this.emit({ type: 'err', reason: String(msg.reason ?? 'error') });
    }
  }

  private setConnState(s: RoomHubConnState, detail?: string): void {
    this.state = s;
    for (const fn of this.connListeners) fn(s, detail);
  }
}
