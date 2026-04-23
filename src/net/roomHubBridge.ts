/**
 * Lazy façade over `./roomHub`.
 *
 * **Why this exists:** `roomHub.ts` is the WebSocket lobby client (~7 KB
 * gzipped on its own, plus the dependency closure of `roomTypes`,
 * `characterPresets`, etc.). It only matters once the player either reaches
 * the title screen's lobby status line or opens the online lobby. Forcing
 * it into the main boot chunk delays first paint for every player —
 * including pure-solo runs that never touch online play.
 *
 * `core/gameStore.ts`, `ui/mountStartFlow.ts`, and `ui/mountOnlineLobby.ts`
 * are reachable from `src/main.ts`'s static import graph (directly or via
 * `mountStartFlow` → `mountOnlineLobby`). Routing them through this façade
 * cuts the static path so Vite can emit `roomHub` as a separate chunk that
 * loads on first hub call (or when `main.ts` proactively kicks
 * `initRoomHubFromEnv` after first paint).
 *
 * **Method semantics:**
 * - **`getState`** returns `'idle'` until the real module loads. Existing
 *   callers (`getRoomHub().getState() !== 'open'`) bail correctly.
 * - **`subscribeConnection`** mimics the real hub's immediate-fire contract
 *   by invoking the listener with `'idle'` synchronously, then attaching the
 *   real subscription once the module resolves. The returned unsubscribe is
 *   safe to call before the module loads (cancels the pending attach).
 * - **`subscribeEvents`** queues the subscription; the real hub only fires
 *   on incoming server messages, so no immediate-fire is needed.
 * - **All `send*` / action methods** queue the call until the module loads,
 *   then forward. If the WebSocket isn't connected, the real hub buffers
 *   into its own `outbox` so messages aren't dropped.
 */
import type { CharacterPresetId, GameMode } from '../core/types';
import {
  ROOM_PROTOCOL_V,
  type PresenceRealmMode,
  type RoomHubEvent,
  type VoiceSignalKind,
} from './roomTypes';

export { ROOM_PROTOCOL_V };

export type RoomHubConnState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

type ConnListener = (state: RoomHubConnState, detail?: string) => void;
type EventListener = (ev: RoomHubEvent) => void;

type RoomHubModule = typeof import('./roomHub');

let modulePromise: Promise<RoomHubModule> | null = null;
let loadedModule: RoomHubModule | null = null;

function loadRoomHub(): Promise<RoomHubModule> {
  if (!modulePromise) {
    modulePromise = import('./roomHub').then((m) => {
      loadedModule = m;
      return m;
    });
  }
  return modulePromise;
}

const PROD_LOBBY_WSS = 'wss://moba-rooms.fly.dev';

/**
 * Inlined here so this small env-only helper does not pull in the full
 * `roomHub` module. Mirrors the implementation in `roomHub.ts`; keep them in
 * sync if the URL fallback policy changes.
 */
export function getLobbyWebSocketUrl(): string | undefined {
  const envUrl = import.meta.env.VITE_ROOM_WS_URL;
  if (typeof envUrl === 'string' && envUrl.trim().length > 0) return envUrl.trim();
  if (import.meta.env.DEV) {
    const host =
      typeof globalThis.location !== 'undefined' ? globalThis.location.hostname : 'localhost';
    return `ws://${host}:3334`;
  }
  return PROD_LOBBY_WSS;
}

class RoomHubFacade {
  getState(): RoomHubConnState {
    if (loadedModule) return loadedModule.getRoomHub().getState();
    return 'idle';
  }

  subscribeConnection(fn: ConnListener): () => void {
    if (loadedModule) return loadedModule.getRoomHub().subscribeConnection(fn);
    /* Mimic real hub's immediate-fire contract so callers that paint UI from
     * the first invocation (e.g. start-flow lobby status line) don't see a
     * blank state until the module resolves. */
    fn('idle');
    let unsubReal: (() => void) | null = null;
    let cancelled = false;
    void loadRoomHub().then((m) => {
      if (cancelled) return;
      unsubReal = m.getRoomHub().subscribeConnection(fn);
    });
    return () => {
      cancelled = true;
      if (unsubReal) {
        unsubReal();
        unsubReal = null;
      }
    };
  }

  subscribeEvents(fn: EventListener): () => void {
    if (loadedModule) return loadedModule.getRoomHub().subscribeEvents(fn);
    let unsubReal: (() => void) | null = null;
    let cancelled = false;
    void loadRoomHub().then((m) => {
      if (cancelled) return;
      unsubReal = m.getRoomHub().subscribeEvents(fn);
    });
    return () => {
      cancelled = true;
      if (unsubReal) {
        unsubReal();
        unsubReal = null;
      }
    };
  }

  connect(url: string): void {
    if (loadedModule) {
      loadedModule.getRoomHub().connect(url);
      return;
    }
    void loadRoomHub().then((m) => m.getRoomHub().connect(url));
  }

  disconnect(): void {
    if (loadedModule) {
      loadedModule.getRoomHub().disconnect();
      return;
    }
    void loadRoomHub().then((m) => m.getRoomHub().disconnect());
  }

  listRooms(gameMode?: GameMode): void {
    if (loadedModule) {
      loadedModule.getRoomHub().listRooms(gameMode);
      return;
    }
    void loadRoomHub().then((m) => m.getRoomHub().listRooms(gameMode));
  }

  createRoom(opts: {
    gameMode: GameMode;
    displayName: string;
    characterPresetId: CharacterPresetId;
    team?: 0 | 1;
    isPublic?: boolean;
  }): void {
    if (loadedModule) {
      loadedModule.getRoomHub().createRoom(opts);
      return;
    }
    void loadRoomHub().then((m) => m.getRoomHub().createRoom(opts));
  }

  joinRoom(opts: {
    roomId: string;
    displayName: string;
    characterPresetId: CharacterPresetId;
    team?: 0 | 1;
  }): void {
    if (loadedModule) {
      loadedModule.getRoomHub().joinRoom(opts);
      return;
    }
    void loadRoomHub().then((m) => m.getRoomHub().joinRoom(opts));
  }

  leaveRoom(): void {
    if (loadedModule) {
      loadedModule.getRoomHub().leaveRoom();
      return;
    }
    void loadRoomHub().then((m) => m.getRoomHub().leaveRoom());
  }

  setReady(ready: boolean): void {
    if (loadedModule) {
      loadedModule.getRoomHub().setReady(ready);
      return;
    }
    void loadRoomHub().then((m) => m.getRoomHub().setReady(ready));
  }

  lockStart(): void {
    if (loadedModule) {
      loadedModule.getRoomHub().lockStart();
      return;
    }
    void loadRoomHub().then((m) => m.getRoomHub().lockStart());
  }

  beginActive(): void {
    if (loadedModule) {
      loadedModule.getRoomHub().beginActive();
      return;
    }
    void loadRoomHub().then((m) => m.getRoomHub().beginActive());
  }

  queueJoin(opts: {
    gameMode: GameMode;
    displayName: string;
    characterPresetId: CharacterPresetId;
  }): void {
    if (loadedModule) {
      loadedModule.getRoomHub().queueJoin(opts);
      return;
    }
    void loadRoomHub().then((m) => m.getRoomHub().queueJoin(opts));
  }

  queueLeave(): void {
    if (loadedModule) {
      loadedModule.getRoomHub().queueLeave();
      return;
    }
    void loadRoomHub().then((m) => m.getRoomHub().queueLeave());
  }

  coopOp(payload: {
    add?: Record<string, number>;
    sub?: Record<string, number>;
    currencyDelta?: number;
  }): void {
    if (loadedModule) {
      loadedModule.getRoomHub().coopOp(payload);
      return;
    }
    void loadRoomHub().then((m) => m.getRoomHub().coopOp(payload));
  }

  pvpProposeBattle(opts?: { targetSessionId?: string }): void {
    if (loadedModule) {
      loadedModule.getRoomHub().pvpProposeBattle(opts);
      return;
    }
    void loadRoomHub().then((m) => m.getRoomHub().pvpProposeBattle(opts));
  }

  pvpDuelRespond(proposalId: string, accept: boolean): void {
    if (loadedModule) {
      loadedModule.getRoomHub().pvpDuelRespond(proposalId, accept);
      return;
    }
    void loadRoomHub().then((m) => m.getRoomHub().pvpDuelRespond(proposalId, accept));
  }

  pvpVoteBattle(accept: boolean): void {
    if (loadedModule) {
      loadedModule.getRoomHub().pvpVoteBattle(accept);
      return;
    }
    void loadRoomHub().then((m) => m.getRoomHub().pvpVoteBattle(accept));
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
    if (loadedModule) {
      loadedModule.getRoomHub().sendPresence(payload);
      return;
    }
    void loadRoomHub().then((m) => m.getRoomHub().sendPresence(payload));
  }

  pvpStrike(payload: { toSessionId: string; damage: number; cardName: string }): void {
    if (loadedModule) {
      loadedModule.getRoomHub().pvpStrike(payload);
      return;
    }
    void loadRoomHub().then((m) => m.getRoomHub().pvpStrike(payload));
  }

  pvpRivalDefeated(loserSessionId: string): void {
    if (loadedModule) {
      loadedModule.getRoomHub().pvpRivalDefeated(loserSessionId);
      return;
    }
    void loadRoomHub().then((m) => m.getRoomHub().pvpRivalDefeated(loserSessionId));
  }

  sendRoomChat(text: string): void {
    if (loadedModule) {
      loadedModule.getRoomHub().sendRoomChat(text);
      return;
    }
    void loadRoomHub().then((m) => m.getRoomHub().sendRoomChat(text));
  }

  sendVoiceSignal(opts: {
    toSessionId: string;
    kind: VoiceSignalKind;
    sdp?: string;
    candidate?: RTCIceCandidateInit;
  }): void {
    if (loadedModule) {
      loadedModule.getRoomHub().sendVoiceSignal(opts);
      return;
    }
    void loadRoomHub().then((m) => m.getRoomHub().sendVoiceSignal(opts));
  }
}

let facadeSingleton: RoomHubFacade | null = null;

export function getRoomHub(): RoomHubFacade {
  return (facadeSingleton ??= new RoomHubFacade());
}
