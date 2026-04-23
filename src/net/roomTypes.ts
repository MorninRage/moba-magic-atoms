/**
 * Shared shapes for IDLE-CRAFT lobby / room protocol (mirrors server/room-server.mjs v3).
 */
import type { CharacterPresetId, GameMode } from '../core/types';

export const ROOM_PROTOCOL_V = 4;

export type RoomPhase = 'lobby' | 'locked' | 'active';

export interface RoomPlayerPublic {
  sessionId: string;
  displayName: string;
  characterPresetId: CharacterPresetId;
  team: 0 | 1;
  ready: boolean;
  isHost: boolean;
  eliminated?: boolean;
}

export interface RoomCoopSnapshot {
  inventory: Record<string, number>;
  currency: number;
  /** Monotonic server revision — ignore stale `coop_inventory` / snapshot applies. */
  rev?: number;
}

export interface RoomSnapshot {
  id: string;
  gameMode: GameMode;
  phase: RoomPhase;
  seed: number;
  maxPlayers: number;
  isPublic: boolean;
  players: RoomPlayerPublic[];
  yourSessionId: string;
  /** Room creator — authoritative for shared dock seating (host left, guest right). */
  hostSessionId?: string;
  coop?: RoomCoopSnapshot;
}

export interface PublicRoomSummary {
  id: string;
  gameMode: GameMode;
  phase: RoomPhase;
  playerCount: number;
  maxPlayers: number;
  isPublic: boolean;
}

export interface RoomChatMessage {
  fromSessionId: string;
  displayName: string;
  text: string;
  ts: number;
}

/** Deck UI vs awakened free-roam — drives co-op world peer replication. */
export type PresenceRealmMode = 'deck' | 'awakened';

/** Latest row from {@link RoomHubEvent} `presence_update` (in-memory, not persisted). */
export interface RemotePresenceEntry {
  page: string;
  gatherKey: string | null;
  progress01: number | null;
  seq: number;
  realm: PresenceRealmMode;
  wx: number | null;
  wy: number | null;
  wz: number | null;
  wyaw: number | null;
}

export type VoiceSignalKind = 'offer' | 'answer' | 'candidate';

export type RoomHubEvent =
  | { type: 'snapshot'; room: RoomSnapshot }
  | { type: 'room_list'; rooms: PublicRoomSummary[] }
  | { type: 'queue_status'; position: number; mode: GameMode; queueSize?: number }
  | { type: 'queue_matched'; roomId: string }
  | { type: 'left_queue'; mode: GameMode }
  | { type: 'battle_intent_ok'; echo: Record<string, unknown> }
  | { type: 'room_chat'; message: RoomChatMessage }
  | { type: 'coop_inventory'; inventory: Record<string, number>; currency: number; rev?: number }
  | {
      type: 'pvp_assigned';
      rivalSessionId: string;
      rivalName: string;
      rivalPreset: CharacterPresetId;
      maxHp: number;
    }
  | { type: 'pvp_vote_start'; proposalId: string; proposerName: string }
  | { type: 'pvp_vote_result'; passed: boolean }
  | {
      type: 'pvp_hit';
      fromSessionId: string;
      toSessionId: string;
      damage: number;
      cardName: string;
      strikeSeq: number;
    }
  | {
      type: 'presence_update';
      sessionId: string;
      page: string;
      gatherKey: string | null;
      progress01: number | null;
      seq: number;
      realm?: PresenceRealmMode;
      wx?: number | null;
      wy?: number | null;
      wz?: number | null;
      wyaw?: number | null;
    }
  | {
      type: 'pvp_duel_invite';
      proposalId: string;
      proposerSessionId: string;
      proposerName: string;
    }
  | { type: 'pvp_duel_pending'; proposalId: string; targetSessionId: string }
  | { type: 'pvp_duel_declined'; proposalId: string; bySessionId: string }
  | { type: 'pvp_duel_expired'; proposalId: string }
  | { type: 'pvp_rival_defeated'; loserSessionId: string }
  | {
      type: 'voice_signal';
      fromSessionId: string;
      kind: VoiceSignalKind;
      sdp: string | null;
      candidate: RTCIceCandidateInit | null;
    }
  | { type: 'err'; reason: string };
