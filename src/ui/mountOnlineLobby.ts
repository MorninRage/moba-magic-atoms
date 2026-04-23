/**
 * Online lobby: browse/create/join, queue for PvP/deathmatch, ready + host lock/start, six-avatar stage.
 */
import type { CharacterPresetId, GameMode } from '../core/types';
import { getRoomHub } from '../net/roomHubBridge';
import type { RoomSnapshot } from '../net/roomTypes';
import { LobbyVoiceMesh } from '../voice/lobbyVoiceMesh';
import { registerRendererDisplaySync } from '../engine/rendererDisplaySettings';
import { registerPostProcessingSync } from '../engine/userPostProcessingSettings';
import { MultiplayerAvatarStage, type LobbyStageSlot } from '../visual/multiplayerAvatarStage';
import './onlineLobby.css';

const DISPLAY_NAME_KEY = 'moba-atoms-display-name';

export type OnlineLaunchSession = {
  roomId: string;
  seed: number;
  team?: 0 | 1;
  partyRoster: string[];
};

/** Tear down lobby UI. Pass `{ leaveRoom: false }` when entering the game so you stay in the active room (chat/voice still work server-side). */
export type DisposeOnlineLobby = (opts?: { leaveRoom?: boolean }) => void;

export type MountOnlineLobbyOptions = {
  gameMode: GameMode;
  characterPresetId: CharacterPresetId;
  onBack: () => void;
  /** Called when the host moves the room to `active` — start the shared expedition locally. */
  onEnterGame: (session: OnlineLaunchSession) => void;
  /** After connect, immediately `queueJoin` (3v3 / Hunter). For Vibe Jam “land and queue” flows. */
  autoJoinQueue?: boolean;
};

export async function mountOnlineLobby(
  container: HTMLElement,
  opts: MountOnlineLobbyOptions,
): Promise<DisposeOnlineLobby> {
  const hub = getRoomHub();
  let stage: MultiplayerAvatarStage | null = null;
  let snap: RoomSnapshot | null = null;
  let enteredActive = false;

  const wrap = document.createElement('div');
  wrap.className = 'online-lobby';
  wrap.innerHTML = `
    <button type="button" class="start-btn start-btn--neon-ghost start-btn--back" data-lobby-back>← Back</button>
    <h2 class="start-step-h">Lobby</h2>
    <p class="start-step-p" data-lobby-mode-desc></p>
    <div class="online-lobby__banner" data-lobby-banner></div>
    <div class="online-lobby__stage-wrap" data-lobby-stage></div>
    <div class="online-lobby__comms">
      <div class="online-lobby__chat">
        <div class="online-lobby__chat-log" data-chat-log></div>
        <div class="online-lobby__chat-row">
          <input type="text" data-chat-input maxlength="500" placeholder="Room chat (join a room first)…" disabled />
          <button type="button" class="start-btn start-btn--neon-primary" data-chat-send disabled>Send</button>
        </div>
      </div>
      <div class="online-lobby__voice">
        <div class="online-lobby__voice-audio-mount" data-voice-audio-mount aria-hidden="true"></div>
        <div class="online-lobby__voice-meta">
          Voice is peer‑to‑peer over WebRTC (STUN only). Use HTTPS or localhost; allow the mic when prompted. Toggle mic before others join for fewest glitches, or tap Reconnect voice.
        </div>
        <div class="online-lobby__voice-actions">
          <button type="button" class="start-btn start-btn--neon-primary" data-voice-mic>Mic on</button>
          <button type="button" class="start-btn start-btn--neon-ghost" data-voice-reconnect>Reconnect voice</button>
        </div>
      </div>
    </div>
    <div class="online-lobby__row">
      <label for="lobby-display-name">Callsign</label>
      <input id="lobby-display-name" type="text" data-display-name maxlength="24" autocomplete="nickname" />
    </div>
    <div class="online-lobby__row" data-team-row hidden>
      <span class="online-lobby__meta" data-team-row-label>Team (3v3)</span>
      <span data-team-pick-wrap>
        <label><input type="radio" name="lobby-team" value="0" checked /> A</label>
        <label><input type="radio" name="lobby-team" value="1" /> B</label>
      </span>
    </div>
    <div class="online-lobby__row">
      <button type="button" class="start-btn start-btn--neon-primary" data-create-room>Create room</button>
      <button type="button" class="start-btn start-btn--neon-ghost" data-list-rooms>Refresh list</button>
      <button type="button" class="start-btn start-btn--neon-primary" data-queue-match hidden>Find match</button>
      <button type="button" class="start-btn start-btn--neon-ghost" data-leave-queue hidden>Leave queue</button>
    </div>
    <div class="online-lobby__row">
      <input type="text" data-join-code placeholder="Room code" maxlength="12" />
      <button type="button" class="start-btn start-btn--neon-primary" data-join-room>Join</button>
      <button type="button" class="start-btn start-btn--neon-ghost" data-leave-room>Leave room</button>
    </div>
    <p class="online-lobby__meta" data-queue-meta hidden></p>
    <ul class="online-lobby__room-list" data-room-list></ul>
    <div class="online-lobby__row">
      <button type="button" class="start-btn start-btn--neon-ghost" data-ready>Toggle ready</button>
      <button type="button" class="start-btn start-btn--neon-ghost" data-lock-start hidden>Lock start</button>
      <button type="button" class="start-btn start-btn--neon-primary" data-begin-active hidden>Launch run</button>
    </div>
    <p class="online-lobby__meta" data-room-meta></p>
  `;
  container.appendChild(wrap);

  const stageHost = wrap.querySelector('[data-lobby-stage]') as HTMLElement;
  stage = await MultiplayerAvatarStage.create(stageHost);
  const lobbyPpUnsub = registerPostProcessingSync(() => {
    stage?.syncPostProcessingFromSettings();
  });
  const lobbyDisplayUnsub = registerRendererDisplaySync(() => {
    stage?.syncRendererDisplayFromSettings();
  });

  const banner = wrap.querySelector('[data-lobby-banner]') as HTMLElement;
  const modeDesc = wrap.querySelector('[data-lobby-mode-desc]') as HTMLElement;
  const nameInput = wrap.querySelector('[data-display-name]') as HTMLInputElement;
  const teamRow = wrap.querySelector('[data-team-row]') as HTMLElement;
  const teamRowLabel = wrap.querySelector('[data-team-row-label]') as HTMLElement;
  const teamPickWrap = wrap.querySelector('[data-team-pick-wrap]') as HTMLElement;
  const queueBtn = wrap.querySelector('[data-queue-match]') as HTMLButtonElement;
  const leaveQueueBtn = wrap.querySelector('[data-leave-queue]') as HTMLButtonElement;
  const queueMeta = wrap.querySelector('[data-queue-meta]') as HTMLElement;
  const NEED_PLAYERS_3V3 = 6;
  const roomListEl = wrap.querySelector('[data-room-list]') as HTMLUListElement;
  const roomMeta = wrap.querySelector('[data-room-meta]') as HTMLElement;
  const readyBtn = wrap.querySelector('[data-ready]') as HTMLButtonElement;
  const lockBtn = wrap.querySelector('[data-lock-start]') as HTMLButtonElement;
  const beginBtn = wrap.querySelector('[data-begin-active]') as HTMLButtonElement;
  const chatLog = wrap.querySelector('[data-chat-log]') as HTMLElement;
  const chatInput = wrap.querySelector('[data-chat-input]') as HTMLInputElement;
  const chatSend = wrap.querySelector('[data-chat-send]') as HTMLButtonElement;
  const voiceAudioMount = wrap.querySelector('[data-voice-audio-mount]') as HTMLElement;
  const voiceMicBtn = wrap.querySelector('[data-voice-mic]') as HTMLButtonElement;
  const voiceReconnectBtn = wrap.querySelector('[data-voice-reconnect]') as HTMLButtonElement;

  const voice = new LobbyVoiceMesh({
    sendSignal: (to, kind, sdp, candidate) => {
      hub.sendVoiceSignal({ toSessionId: to, kind, sdp, candidate });
    },
    audioMount: voiceAudioMount,
  });

  const MAX_CHAT_LINES = 80;
  function appendChatLine(html: string): void {
    const line = document.createElement('div');
    line.className = 'online-lobby__chat-line';
    line.innerHTML = html;
    chatLog.appendChild(line);
    while (chatLog.children.length > MAX_CHAT_LINES) {
      chatLog.removeChild(chatLog.firstChild!);
    }
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function appendChatSystem(text: string): void {
    const line = document.createElement('div');
    line.className = 'online-lobby__chat-line online-lobby__chat-line--system';
    line.textContent = text;
    chatLog.appendChild(line);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** UI capacity: hunter duel is always 2; co-op and Forge clash (deathmatch) use server max (6). */
  function lobbyDisplayMax(gameMode: GameMode, serverMax: number): number {
    return gameMode === 'pvp' ? 2 : serverMax;
  }

  function syncChatRoomState(inRoom: boolean): void {
    chatInput.disabled = !inRoom;
    chatSend.disabled = !inRoom;
    chatInput.placeholder = inRoom ? 'Room chat…' : 'Room chat (join a room first)…';
  }

  function syncVoicePeers(): void {
    const room = snap;
    if (!room) {
      voice.syncPeers(null, []);
      return;
    }
    voice.syncPeers(room.yourSessionId, room.players.map((p) => p.sessionId));
  }

  function updateMicButtonLabel(): void {
    voiceMicBtn.textContent = voice.getMicOn() ? 'Mic off' : 'Mic on';
  }

  nameInput.value = localStorage.getItem(DISPLAY_NAME_KEY) ?? 'Survivor';

  modeDesc.textContent =
    opts.gameMode === 'coop'
      ? 'Create or join a room with friends. When the host launches the run, everyone gets a fresh expedition — same survival loop; use chat or voice to coordinate.'
      : opts.gameMode === 'pvp'
        ? 'Queue for a match or join a room. After launch, play a hunter-style duel run: full idle crafting and battle dock, tuned for competitive pacing.'
        : 'Up to six survivors, teams A or B (three each). When the host locks and launches, everyone starts the same style of run from a shared room code.';

  if (opts.gameMode === 'pvp' || opts.gameMode === 'deathmatch') {
    teamRow.hidden = false;
    if (opts.gameMode === 'pvp') {
      teamRowLabel.textContent = '1v1';
      teamPickWrap.hidden = true;
    } else {
      teamRowLabel.textContent = 'Team (assigned at match found)';
      teamPickWrap.hidden = true;
    }
    queueBtn.hidden = false;
    leaveQueueBtn.hidden = false;
    queueMeta.hidden = false;
  }

  let inMatchmakingQueue = false;
  function syncQueueUi(): void {
    leaveQueueBtn.disabled = !inMatchmakingQueue;
  }
  syncQueueUi();

  function teamPick(): 0 | 1 {
    const r = wrap.querySelector('input[name="lobby-team"]:checked') as HTMLInputElement | null;
    return r?.value === '1' ? 1 : 0;
  }

  function displayName(): string {
    const s = nameInput.value.trim().slice(0, 24) || 'Survivor';
    localStorage.setItem(DISPLAY_NAME_KEY, s);
    return s;
  }

  function syncConnBanner(): void {
    const st = hub.getState();
    if (st === 'open') {
      banner.classList.remove('online-lobby__banner--warn');
      banner.textContent =
        'Connected to the online lobby. Create or join a room — then you can use chat and voice with your party.';
    } else if (st === 'connecting') {
      banner.classList.remove('online-lobby__banner--warn');
      banner.textContent = 'Connecting to the online lobby…';
    } else {
      banner.classList.add('online-lobby__banner--warn');
      banner.textContent =
        'Could not reach the online lobby. Check your internet connection and try again, or refresh the page.';
    }
  }

  function snapshotToSlots(room: RoomSnapshot): LobbyStageSlot[] {
    const slots: LobbyStageSlot[] = [null, null, null, null, null, null];
    room.players.forEach((p, i) => {
      if (i >= 6) return;
      slots[i] = {
        displayName: p.displayName,
        characterPresetId: p.characterPresetId,
        team: p.team,
        ready: p.ready,
        isHost: p.isHost,
      };
    });
    return slots;
  }

  function syncStage(): void {
    if (!snap) {
      stage?.setSlots([], opts.gameMode);
      roomMeta.textContent = '';
      lockBtn.hidden = true;
      beginBtn.hidden = true;
      syncChatRoomState(false);
      syncVoicePeers();
      return;
    }
    const room = snap;
    syncChatRoomState(true);
    syncVoicePeers();
    stage?.setSlots(snapshotToSlots(room), room.gameMode);
    const you = room.players.find((p) => p.sessionId === room.yourSessionId);
    const cap = lobbyDisplayMax(room.gameMode, room.maxPlayers);
    roomMeta.textContent = `Room ${room.id} · phase ${room.phase} · seed ${room.seed} · ${room.players.length}/${cap}`;
    const isHost = !!you?.isHost;
    lockBtn.hidden = !isHost || room.phase !== 'lobby';
    beginBtn.hidden = !isHost || room.phase !== 'locked';
    if (room.phase === 'active' && !enteredActive) {
      enteredActive = true;
      opts.onEnterGame({
        roomId: room.id,
        seed: room.seed,
        ...(room.gameMode === 'deathmatch' && you ? { team: you.team as 0 | 1 } : {}),
        partyRoster: room.players.map((p) => p.displayName),
      });
    }
  }

  function syncRoomList(rooms: { id: string; gameMode: GameMode; playerCount: number; maxPlayers: number }[]): void {
    roomListEl.replaceChildren();
    for (const r of rooms) {
      const li = document.createElement('li');
      const listCap = lobbyDisplayMax(r.gameMode, r.maxPlayers);
      li.innerHTML = `<span>${r.id} · ${r.gameMode} · ${r.playerCount}/${listCap}</span><button type="button" class="start-btn start-btn--neon-ghost" data-join="${r.id}">Join</button>`;
      roomListEl.appendChild(li);
    }
    roomListEl.querySelectorAll('[data-join]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-join') ?? '';
        hub.joinRoom({
          roomId: id,
          displayName: displayName(),
          characterPresetId: opts.characterPresetId,
          team: opts.gameMode === 'deathmatch' ? teamPick() : 0,
        });
      });
    });
  }

  const unsubEv = hub.subscribeEvents((ev) => {
    if (ev.type === 'snapshot') {
      snap = ev.room;
      syncStage();
    } else if (ev.type === 'room_list') {
      syncRoomList(ev.rooms);
    } else if (ev.type === 'queue_status') {
      inMatchmakingQueue = true;
      syncQueueUi();
      if (ev.mode === 'deathmatch' && ev.queueSize != null) {
        queueMeta.textContent = `3v3 matchmaking: #${ev.position} of ${ev.queueSize} waiting (need ${NEED_PLAYERS_3V3} to form a match)`;
      } else if (ev.mode === 'pvp' && ev.queueSize != null) {
        queueMeta.textContent = `1v1 matchmaking: #${ev.position} of ${ev.queueSize} waiting`;
      } else {
        queueMeta.textContent = `Queue position: ${ev.position} (${ev.mode})`;
      }
    } else if (ev.type === 'left_queue') {
      inMatchmakingQueue = false;
      syncQueueUi();
      queueMeta.textContent = 'Left matchmaking queue.';
    } else if (ev.type === 'queue_matched') {
      inMatchmakingQueue = false;
      syncQueueUi();
      queueMeta.textContent = `Matched into room ${ev.roomId}`;
      appendChatSystem(`Match found — room ${ev.roomId}. Toggle ready; host locks, then launches.`);
    } else if (ev.type === 'room_chat') {
      const m = ev.message;
      const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      appendChatLine(
        `<span class="online-lobby__chat-name">${escapeHtml(m.displayName)}</span><span class="online-lobby__chat-time">${escapeHtml(time)}</span> ${escapeHtml(m.text)}`,
      );
    } else if (ev.type === 'voice_signal') {
      void voice.handleSignal(ev.fromSessionId, ev.kind, ev.sdp, ev.candidate);
    } else if (ev.type === 'err') {
      banner.classList.add('online-lobby__banner--warn');
      banner.textContent = `Server: ${ev.reason}`;
    }
  });

  const unsubConn = hub.subscribeConnection(() => syncConnBanner());
  syncConnBanner();

  wrap.querySelector('[data-lobby-back]')?.addEventListener('click', () => {
    hub.leaveRoom();
    opts.onBack();
  });

  wrap.querySelector('[data-create-room]')?.addEventListener('click', () => {
    hub.createRoom({
      gameMode: opts.gameMode,
      displayName: displayName(),
      characterPresetId: opts.characterPresetId,
      team: opts.gameMode === 'deathmatch' ? teamPick() : 0,
    });
  });

  wrap.querySelector('[data-list-rooms]')?.addEventListener('click', () => {
    hub.listRooms(opts.gameMode);
  });

  queueBtn.addEventListener('click', () => {
    hub.queueJoin({
      gameMode: opts.gameMode,
      displayName: displayName(),
      characterPresetId: opts.characterPresetId,
    });
  });

  leaveQueueBtn.addEventListener('click', () => {
    hub.queueLeave();
  });

  wrap.querySelector('[data-join-room]')?.addEventListener('click', () => {
    const code = (wrap.querySelector('[data-join-code]') as HTMLInputElement).value.trim();
    if (!code) return;
    hub.joinRoom({
      roomId: code,
      displayName: displayName(),
      characterPresetId: opts.characterPresetId,
      team: opts.gameMode === 'deathmatch' ? teamPick() : 0,
    });
  });

  wrap.querySelector('[data-leave-room]')?.addEventListener('click', () => {
    hub.leaveRoom();
    snap = null;
    syncStage();
    appendChatSystem('Left room.');
  });

  function sendChat(): void {
    if (!snap) {
      appendChatSystem('Create or join a room first — then you can use chat.');
      return;
    }
    if (hub.getState() !== 'open') {
      appendChatSystem('Not connected to the lobby. Check your connection and try again.');
      return;
    }
    const t = chatInput.value.trim();
    if (!t) return;
    hub.sendRoomChat(t);
    chatInput.value = '';
  }

  chatSend.addEventListener('click', () => {
    sendChat();
  });
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendChat();
    }
  });

  voiceMicBtn.addEventListener('click', () => {
    void (async () => {
      try {
        if (voice.getMicOn()) {
          await voice.setMicEnabled(false);
        } else {
          await voice.setMicEnabled(true);
        }
        updateMicButtonLabel();
        appendChatSystem(voice.getMicOn() ? 'Microphone on.' : 'Microphone off.');
      } catch {
        appendChatSystem('Could not access microphone — check permissions.');
      }
    })();
  });

  voiceReconnectBtn.addEventListener('click', () => {
    voice.reconnect();
    appendChatSystem('Voice mesh reconnecting…');
  });

  readyBtn.addEventListener('click', () => {
    const room = snap;
    if (!room) return;
    const you = room.players.find((p) => p.sessionId === room.yourSessionId);
    hub.setReady(!you?.ready);
  });

  lockBtn.addEventListener('click', () => {
    hub.lockStart();
  });

  beginBtn.addEventListener('click', () => {
    hub.beginActive();
  });

  let autoJoinUnsub: (() => void) | null = null;
  if (opts.autoJoinQueue && (opts.gameMode === 'pvp' || opts.gameMode === 'deathmatch')) {
    let fired = false;
    const runAutoQueue = (): void => {
      if (fired) return;
      if (hub.getState() !== 'open') return;
      fired = true;
      hub.queueJoin({
        gameMode: opts.gameMode,
        displayName: displayName(),
        characterPresetId: opts.characterPresetId,
      });
      appendChatSystem('Joining matchmaking…');
    };
    autoJoinUnsub = hub.subscribeConnection((st) => {
      if (st === 'open') runAutoQueue();
    });
    runAutoQueue();
  }

  hub.listRooms(opts.gameMode);
  appendChatSystem('Room chat and voice work after you join a room.');
  updateMicButtonLabel();

  return (disposeOpts?: { leaveRoom?: boolean }) => {
    const leaveRoom = disposeOpts?.leaveRoom ?? true;
    autoJoinUnsub?.();
    autoJoinUnsub = null;
    lobbyPpUnsub();
    lobbyDisplayUnsub();
    unsubEv();
    unsubConn();
    voice.dispose();
    stage?.dispose();
    stage = null;
    if (leaveRoom) hub.leaveRoom();
    container.replaceChildren();
  };
}
