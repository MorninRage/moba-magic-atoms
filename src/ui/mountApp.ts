import { GameStore, allCards, allHelpers, allRecipes, cabinPieceCost, cabinPieceMaxHp } from '../core/gameStore';
import {
  CABIN_TIER_LABEL,
  CABIN_TIER_ORDER,
  CABIN_TIER_UNLOCK_CARD,
} from '../visual/magicalCabinMaterials';
import type { CabinPieceKind } from '../core/types';
import {
  BATTLE_HEAL_BANDAGE,
  BATTLE_HEAL_STIM,
  cardById,
  DURABILITY_ITEM_IDS,
  EQUIPPABLE_PICK_IDS,
  EQUIPPABLE_WEAPON_IDS,
  IDLE_SLOT_MAX,
  isDurabilityItemId,
} from '../data/content';
import type { CardDef, CraftStation, DeckTree, GameMode, HelperDef, HelperRole } from '../core/types';
import { VIBEJAM_PORTAL_HUB_2026 } from '../vibeJamPortal';
import {
  playHarvestBreakSound,
  playHarvestProgressSound,
  playWaterGatherSound,
  prewarmAudioModule,
  setBattleMusicMode,
} from '../audio/audioBridge';
import type { CharacterDockPreview, IdleCraftDockBundle } from '../engine/dockPreload';
import { CharacterScenePreview, type AppPageContext } from '../visual/characterScenePreview';
import { CharacterSceneHost } from '../visual/characterSceneHost';
import { isDockVisualLowBudget } from '../world/idleCraftDockInteractionBudget';
import { startIdleCraftFpsMonitor } from './fpsMonitor';
import { schedulePostTask, yieldToEventLoop } from '../util/mainThreadYield';
import './app.css';
import gameShellBg from '../../assets/ui/game-shell-bg.webp';
import { openIdleCraftConfirm } from './idleCraftConfirmModal';
import { renderAwakening } from './awakeningPage';
import { mountAwakenedHotbar } from './awakenedHotbar';
import { attachFreeRoamControls, type FreeRoamHandle } from '../world/freeRoamControls';
import {
  attachDockForestBatchedScene,
  type DockForestHandle,
  type DockForestHarvestNode,
} from '../world/dockForestBatchedScene';
import { attachFreeRoamHarvestNodes, type FreeRoamHarvestHandle } from '../world/freeRoamHarvestNodes';
import { attachCabinBuilder, type CabinBuildHandle } from '../world/cabinBuilder';
import {
  createBuildModeController,
  createStationBuildModeController,
  type BuildModeController,
  type StationBuildModeController,
} from '../world/buildModeController';
import {
  attachCraftStationBuilder,
  type CraftStationBuildHandle,
} from '../world/craftStationBuilder';
import type { PlacedCraftStationKind } from '../core/types';
import { getOrCreateSceneCollisionWorld, type CollisionWorldHandle } from '../world/collisionWorld';
import { createCameraLockController, type CameraLockHandle } from '../world/cameraLockController';
import { attachAwakenedMobs, MOB_LOOT, type AwakenedMobsHandle } from '../world/awakenedMobs';
import { createWorkerProxyAwakenedMobsHandle } from '../world/workerProxyAwakenedMobs';
import {
  attachAwakenedBouncyMushrooms,
  type AwakenedBouncyMushroomsHandle,
} from '../world/awakenedBouncyMushrooms';
import { attachMagicProjectiles, type MagicProjectilesHandle } from '../world/magicProjectiles';
import { attachLockOnController, type LockOnHandle } from '../world/lockOnController';
import { attachAwakenedCombat, type AwakenedCombatHandle } from '../world/awakenedCombat';
import { attachDamageFloaters, type DamageFloatersHandle } from '../world/damageFloaters';
import { attachMagicalReticle, type MagicalReticleHandle } from '../world/magicalReticle';
import { attachDefensiveWard, type DefensiveWardHandle } from '../world/defensiveWard';
import { fillPerspectiveCameraFromSharedState } from '../worker/dockSharedRenderReadback';
import type { WorkerMobAuthorityMessage } from '../worker/protocol';
import { FLAG } from '../worker/sharedState';
import { mountShortcutBar, type ShortcutBarHandle } from './shortcutBar';
import { mountConsumableHotbar, type ConsumableHotbarHandle } from './consumableHotbar';
import { mountQuickEquipPanel, type QuickEquipPanelHandle } from './quickEquipPanel';
import { getRoomHub } from '../net/roomHub';
import type { RoomHubEvent } from '../net/roomTypes';
import { LobbyVoiceMesh } from '../voice/lobbyVoiceMesh';
import { registerCharacterCameraForSystemMenu } from './systemMenuStub';
import { registerRendererDisplaySync } from '../engine/rendererDisplaySettings';
import { registerPostProcessingSync } from '../engine/userPostProcessingSettings';
import { destroyTutorial, mountTutorial, syncTutorialAfterRender } from './tutorial/mountTutorial';
import type { HarvestNodeKind } from '../world/idleCraftHarvestNodes';
import { HARVEST_NODE_KINDS } from '../world/idleCraftHarvestNodes';
import {
  gatherClipDurationFactor,
  harvestYieldMultiplier,
  HARVEST_KIND_LABEL,
  HARVEST_MASTERY_MAX_TIER,
  masteryUpgradeCost,
  MASTERY_BRANCH_BLURB,
  regrowthTimeMultiplier,
  RPG_ROADMAP_IDEAS,
  SEAL_STRAIN_CAP,
  travelTowardHome01,
  veinStrainPerGather,
  type MasteryBranch,
} from '../data/rpgHarvestMastery';
import {
  canSellResourceToMerchant,
  MERCHANT_OFFERS,
  merchantCardPrereqsMet,
  merchantSellPayout,
  type MerchantOfferDef,
} from '../data/wanderingMerchant';

type Page = 'gather' | 'craft' | 'inventory' | 'decks' | 'idle' | 'rpg' | 'battle' | 'hire' | 'awakening' | 'portal';

const TREE_LABEL: Record<DeckTree, string> = {
  building: 'Building & industry',
  survival: 'Survival & food',
  combat: 'Combat',
  magic: 'Magic — ley & spells',
};

const STATION_ORDER: CraftStation[] = ['hand', 'campfire', 'workbench', 'forge', 'kitchen'];
const STATION_TITLE: Record<CraftStation, string> = {
  hand: 'Hand — field crafts',
  campfire: 'Campfire — food & warmth',
  workbench: 'Workbench — tools & structures',
  forge: 'Forge — metal',
  kitchen: 'Kitchen — meals',
};

const HELPER_ROLE_ORDER: HelperRole[] = [
  'general',
  'gathering',
  'industry',
  'kitchen',
  'battle',
  'arcane',
];

function formatAutomationRates(c: CardDef): string {
  if (!c.automation) return '';
  const mult = c.automation.perSecond;
  const parts = Object.entries(c.automation.outputs).map(([k, v]) => {
    const label = k.replace(/_/g, ' ');
    const rate = mult !== 1 ? (v * mult).toFixed(3) : v.toFixed(3);
    return `${label} +${rate}/s`;
  });
  return parts.join(' · ');
}

const HELPER_ROLE_TITLE: Record<HelperRole, string> = {
  general: 'Camp & general',
  gathering: 'Gathering hands',
  industry: 'Industry & materials',
  kitchen: 'Kitchen & provisions',
  battle: 'Battle companions',
  arcane: 'Arcane attendants',
};

const HELPER_ROLE_BLURB: Record<HelperRole, string> = {
  general: 'Broad idle bonuses; good first hires. All hired workers try to feed you from stockpile (cooked meat → berries; water) each minute.',
  gathering: 'Passive wood, stone, water, berries, meat — stacks with your slotted automation cards.',
  industry: 'Coal, ore, leather, and strong idle multipliers for metal age.',
  kitchen: 'Strongest ration service — keeps hunger/thirst up if the pot and skins stay full.',
  battle: 'Flat damage and block in PvE while hired (fist/weapon attacks get damage assist).',
  arcane: 'Dust trickle and light combat help once magic unlocks.',
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Drop the dock WebGL scene so remount / title return does not stack GPU contexts (avoids “context blocked”). */
let activeDockScenePreview: CharacterDockPreview | null = null;
/** Visible worker canvas when {@link CharacterSceneHost} is active (`?worker=1` + capable browser). */
let activeDockWorkerHost: CharacterSceneHost | null = null;
let dockPostProcessingUnsub: (() => void) | null = null;
let dockRendererDisplayUnsub: (() => void) | null = null;

export function disposeIdleCraftDockScene(): void {
  dockPostProcessingUnsub?.();
  dockPostProcessingUnsub = null;
  dockRendererDisplayUnsub?.();
  dockRendererDisplayUnsub = null;
  destroyTutorial();
  void activeDockWorkerHost?.dispose();
  activeDockWorkerHost = null;
  activeDockScenePreview?.dispose();
  activeDockScenePreview = null;
  /* Clear any cached extended-preload handles so the next boot's title-screen
   * extended preload starts fresh (the actual handles' resources were owned
   * by the disposed dock scene). Lazy-import: only present in builds where
   * extended preload was actually used. */
  void import('../engine/dockExtendedPreload')
    .then((m) => m.clearDockExtendedPreloadCache())
    .catch(() => {
      /* never imported in this session — no cache to clear, no-op */
    });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeIdleCraftDockScene();
  });
}

export type MountAppOptions = {
  /** 0–1 overall load; shown on expedition entry loading veil. */
  onLoadProgress?: (fraction: number, status: string) => void;
  /**
   * Preloaded dock bundle — if a boot-time preload ({@link ../engine/dockPreload})
   * has finished (or is in flight) by the time the user clicks "Enter world",
   * `mountApp` consumes it instead of building a fresh scene → near-instant entry.
   * Returns `{ preview, gameplayHandles }`; mountApp adopts both. `gameplayHandles`
   * is `null` when extended attach failed — falls through to inline ensure*.
   */
  consumePreloadedDock?: (target: HTMLElement) => Promise<IdleCraftDockBundle | null>;
};

export async function mountApp(root: HTMLElement, store: GameStore, opts?: MountAppOptions): Promise<void> {
  let workerMobAuthoritySinkWired = false;
  /* Start FPS monitor early — it auto-shows the corner HUD if the player previously
   * enabled it, and the system menu queries it for the live readout. */
  startIdleCraftFpsMonitor();
  const prog = opts?.onLoadProgress;
  const p = (f: number, s: string) => {
    prog?.(f, s);
  };

  p(0.03, 'Assembling camp interface…');

  let page: Page = 'gather';
  let presenceSeq = 0;
  let lastInvHoverKey = '';
  /** When PvP battle UI state changes over the wire, re-render the Battle tab (subscribe does not call renderPage by default). */
  let lastOnlinePvpBattleSig = '';
  let gatherPresenceRaf = 0;
  let lastGatherHarvestSig = '';
  let lastMerchantGatherSig = '';
  let lastRpgPanelSig = '';
  /** Track active gather state so the busy class flips off when the gather completes. */
  let lastActiveGatherSig = '';
  /** Tracks the inventory shape on inventory-display pages so a mid-gather grant
   * (which fires from `tick()` regardless of which page is mounted) re-renders. */
  let lastInventoryPageSig = '';
  /** Equipment signature so `renderPage` skips the expensive `scenePreview.syncEquipment`
   * (dispose 4 hand groups + rebuild axe/sword/pick/shield meshes) when the player
   * hasn't actually swapped gear since the last render. Initial mount populates this
   * once; subsequent renders only rebuild the meshes on a real equipment change. */
  let lastEquipmentSig = '';
  /** When the dock is in visual low-budget mode, coalesce HUD DOM updates to one frame. */
  let hudRefreshRaf = 0;
  let scenePreview!: CharacterDockPreview;

  const shell = document.createElement('div');
  shell.id = 'app-shell';
  shell.innerHTML = `
    <h1 class="game-title">
      <span class="game-title-inner">
        <span class="game-title-idle">IDLE</span>
        <span class="game-title-rivet" aria-hidden="true"></span>
        <span class="game-title-craft">CRAFT</span>
      </span>
    </h1>
    <div id="app-hud" class="app-hud"></div>
    <nav class="nav"></nav>
    <div id="page-root" class="page-root"></div>
    <aside id="character-dock" class="character-dock" aria-label="Character scene">
      <div class="character-dock-title">Your character</div>
      <div id="character-preview-root" class="character-preview-root"></div>
    </aside>
  `;
  shell.style.setProperty('--game-shell-bg-image', `url(${gameShellBg})`);
  root.appendChild(shell);

  const ingameComm = document.createElement('div');
  ingameComm.id = 'ingame-comm';
  ingameComm.className = 'ingame-comm';
  ingameComm.hidden = true;
  ingameComm.innerHTML = `
    <div class="ingame-comm__panel">
      <div class="ingame-comm__head">
        <span class="ingame-comm__title">Session comms</span>
        <button type="button" class="btn ingame-comm__close" aria-label="Close chat">×</button>
      </div>
      <p class="ingame-comm__hint">Press <kbd>Enter</kbd> to toggle · text + optional voice while in an online session</p>
      <div class="ingame-comm__log" data-ingame-chat-log></div>
      <div class="ingame-comm__row">
        <input type="text" class="ingame-comm__input" data-ingame-chat-input maxlength="500" placeholder="Message your party…" autocomplete="off" />
        <button type="button" class="btn btn-primary" data-ingame-chat-send>Send</button>
      </div>
      <div class="ingame-comm__voice">
        <span class="ingame-comm__voice-label">Voice chat</span>
        <button type="button" class="btn" data-ingame-voice-mic type="button">Mic off</button>
      </div>
      <div data-ingame-voice-audio class="ingame-comm__audio-mount" aria-hidden="true"></div>
    </div>
  `;
  root.appendChild(ingameComm);
  p(0.07, 'Connecting party channels…');

  const ingameChatLog = ingameComm.querySelector('[data-ingame-chat-log]') as HTMLElement;
  const ingameChatInput = ingameComm.querySelector('[data-ingame-chat-input]') as HTMLInputElement;
  const ingameVoiceAudioMount = ingameComm.querySelector('[data-ingame-voice-audio]') as HTMLElement;
  const ingameVoiceMic = ingameComm.querySelector('[data-ingame-voice-mic]') as HTMLButtonElement;

  function appendIngameChatLine(name: string, text: string, system = false): void {
    const line = document.createElement('div');
    line.className = 'ingame-comm__line' + (system ? ' ingame-comm__line--system' : '');
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    line.innerHTML = system
      ? `<span class="ingame-comm__text">${escapeHtml(text)}</span>`
      : `<span class="ingame-comm__name">${escapeHtml(name)}</span><span class="ingame-comm__time">${escapeHtml(time)}</span> <span class="ingame-comm__text">${escapeHtml(text)}</span>`;
    ingameChatLog.appendChild(line);
    ingameChatLog.scrollTop = ingameChatLog.scrollHeight;
  }

  function updateIngameMicLabel(): void {
    ingameVoiceMic.textContent = ingameVoice.getMicOn() ? 'Mic on' : 'Mic off';
  }

  const ingameVoice = new LobbyVoiceMesh({
    sendSignal(toSessionId, kind, sdp, candidate) {
      getRoomHub().sendVoiceSignal({
        toSessionId,
        kind,
        ...(sdp != null ? { sdp } : {}),
        ...(candidate != null ? { candidate } : {}),
      });
    },
    audioMount: ingameVoiceAudioMount,
  });

  function refreshVoicePeers(): void {
    const st = store.getState();
    if (!st.onlineSession || getRoomHub().getState() !== 'open') {
      ingameVoice.syncPeers(null, []);
      return;
    }
    ingameVoice.syncPeers(store.getYourRoomSessionId(), store.getRoomPeerSessionIds());
  }

  ingameComm.querySelector('.ingame-comm__close')?.addEventListener('click', () => {
    ingameComm.hidden = true;
  });
  ingameComm.querySelector('[data-ingame-chat-send]')?.addEventListener('click', () => {
    const st = store.getState();
    if (!st.onlineSession) {
      appendIngameChatLine('', 'Join an online session to use party chat.', true);
      return;
    }
    const t = ingameChatInput.value.trim();
    if (!t) return;
    getRoomHub().sendRoomChat(t);
    ingameChatInput.value = '';
  });
  ingameChatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      ingameComm.querySelector<HTMLButtonElement>('[data-ingame-chat-send]')?.click();
    }
  });
  ingameVoiceMic.addEventListener('click', () => {
    void (async () => {
      try {
        if (ingameVoice.getMicOn()) await ingameVoice.setMicEnabled(false);
        else await ingameVoice.setMicEnabled(true);
        updateIngameMicLabel();
      } catch {
        appendIngameChatLine('', 'Microphone permission denied.', true);
      }
    })();
  });

  let pvpVoteBoundEl: HTMLElement | null = null;
  let pvpDuelInviteBoundEl: HTMLElement | null = null;
  /** Throttles awakened world pose on top of server presence rate limits. */
  let lastAwakenCoopPresenceMs = 0;

  function sendOnlinePresence(gatherKey?: string | null, progress01?: number | null): void {
    const st = store.getState();
    if (!st.onlineSession || st.gameMode === 'solo') return;
    if (getRoomHub().getState() !== 'open') return;
    const realm = store.getRealmMode() === 'awakened' ? 'awakened' : 'deck';
    const pose = realm === 'awakened' ? scenePreview.getAwakenPresencePose() : null;
    getRoomHub().sendPresence({
      page,
      gatherKey: gatherKey ?? null,
      progress01: progress01 ?? null,
      seq: ++presenceSeq,
      realm,
      ...(pose
        ? { wx: pose.x, wy: pose.y, wz: pose.z, wyaw: pose.yaw }
        : {}),
    });
  }

  function stopGatherPresencePump(): void {
    if (gatherPresenceRaf) cancelAnimationFrame(gatherPresenceRaf);
    gatherPresenceRaf = 0;
  }

  /** Stream gather clip progress so the Hunter 1v1 peer walks the node in real time. */
  function pumpGatherPresence(actionId: string): void {
    const u = scenePreview.getGatherClipProgress01();
    if (u == null) {
      gatherPresenceRaf = 0;
      return;
    }
    sendOnlinePresence(actionId, u);
    gatherPresenceRaf = requestAnimationFrame(() => pumpGatherPresence(actionId));
  }

  function onlinePresenceDockOpts(hunterSharedWorld: boolean): {
    gatherMiniGhosts: boolean;
    hunterDuoWorld: boolean;
    awakenCoopPeers: boolean;
  } {
    const st = store.getState();
    const coopOnline = st.gameMode === 'coop' && !!st.onlineSession;
    return {
      gatherMiniGhosts: page === 'gather' && !hunterSharedWorld,
      hunterDuoWorld: hunterSharedWorld,
      awakenCoopPeers: coopOnline && !hunterSharedWorld && store.getRealmMode() === 'awakened',
    };
  }

  function syncPvpVoteOverlay(): void {
    if (store.getState().gameMode !== 'deathmatch') {
      pvpVoteBoundEl?.remove();
      pvpVoteBoundEl = null;
      return;
    }
    const pr = store.getPvpVotePrompt();
    if (!pr) {
      pvpVoteBoundEl?.remove();
      pvpVoteBoundEl = null;
      return;
    }
    if (!pvpVoteBoundEl) {
      const o = document.createElement('div');
      o.className = 'pvp-vote-overlay';
      o.innerHTML = `
        <div class="pvp-vote-overlay__card">
          <h3 class="pvp-vote-overlay__title">Bracket battle vote</h3>
          <p class="pvp-vote-overlay__desc" data-pvp-vote-desc></p>
          <div class="pvp-vote-overlay__actions">
            <button type="button" class="btn btn-primary" data-pvp-vote="yes">Accept — duel</button>
            <button type="button" class="btn" data-pvp-vote="no">Keep preparing</button>
          </div>
        </div>`;
      o.addEventListener('click', (e) => {
        const t = (e.target as HTMLElement).closest('[data-pvp-vote]') as HTMLElement | null;
        if (!t) return;
        const v = t.dataset.pvpVote;
        if (v === 'yes') getRoomHub().pvpVoteBattle(true);
        else if (v === 'no') getRoomHub().pvpVoteBattle(false);
      });
      root.appendChild(o);
      pvpVoteBoundEl = o;
    }
    const desc = pvpVoteBoundEl.querySelector('[data-pvp-vote-desc]') as HTMLElement;
    desc.innerHTML = `<strong>${escapeHtml(pr.proposerName)}</strong> wants to open a bracket duel. <strong>Everyone in the room votes</strong> — majority decides.`;
  }

  function syncPvpDuelInviteOverlay(): void {
    const inv = store.getPvpDuelInvitePrompt();
    if (!inv) {
      pvpDuelInviteBoundEl?.remove();
      pvpDuelInviteBoundEl = null;
      return;
    }
    if (!pvpDuelInviteBoundEl) {
      const o = document.createElement('div');
      o.className = 'pvp-vote-overlay';
      o.innerHTML = `
        <div class="pvp-vote-overlay__card">
          <h3 class="pvp-vote-overlay__title">Duel invite</h3>
          <p class="pvp-vote-overlay__desc" data-duel-invite-desc></p>
          <div class="pvp-vote-overlay__actions">
            <button type="button" class="btn btn-primary" data-duel-invite="yes">Accept duel</button>
            <button type="button" class="btn" data-duel-invite="no">Decline</button>
          </div>
        </div>`;
      o.addEventListener('click', (e) => {
        const t = (e.target as HTMLElement).closest('[data-duel-invite]') as HTMLElement | null;
        if (!t) return;
        const pr = store.getPvpDuelInvitePrompt();
        if (!pr) return;
        const v = t.dataset.duelInvite;
        if (v === 'yes') getRoomHub().pvpDuelRespond(pr.proposalId, true);
        else if (v === 'no') getRoomHub().pvpDuelRespond(pr.proposalId, false);
        store.dismissPvpDuelInvitePrompt();
        pvpDuelInviteBoundEl?.remove();
        pvpDuelInviteBoundEl = null;
      });
      root.appendChild(o);
      pvpDuelInviteBoundEl = o;
    }
    const desc = pvpDuelInviteBoundEl.querySelector('[data-duel-invite-desc]') as HTMLElement;
    desc.innerHTML = `<strong>${escapeHtml(inv.proposerName)}</strong> challenged you to a <strong>Hunter duel</strong>. Accept to pair for battle, or decline.`;
  }

  getRoomHub().subscribeEvents((ev: RoomHubEvent) => {
    if (ev.type === 'voice_signal') {
      void ingameVoice.handleSignal(ev.fromSessionId, ev.kind, ev.sdp, ev.candidate);
      return;
    }
    if (ev.type === 'room_chat') {
      appendIngameChatLine(ev.message.displayName, ev.message.text);
    }
    store.ingestRoomHubEvent(ev);
    syncPvpVoteOverlay();
    syncPvpDuelInviteOverlay();
  });

  document.addEventListener('idlecraft-open-battle-tab', () => {
    const st = store.getState();
    if (!st.onlineSession || (st.gameMode !== 'pvp' && st.gameMode !== 'deathmatch')) return;
    if (!st.onlineSession.pvpRival) return;
    page = 'battle';
    store.startPveBattle();
    renderPage();
    refreshHud();
  });

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter') {
        const t = e.target as HTMLElement;
        if (t.closest('.ingame-comm__input') || t.closest('#ingame-comm')) return;
        if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
        if (!store.getState().onlineSession) return;
        e.preventDefault();
        ingameComm.hidden = !ingameComm.hidden;
        if (!ingameComm.hidden) {
          updateIngameMicLabel();
          ingameChatInput.focus();
        }
      }
      if (e.key === 'Escape' && !ingameComm.hidden) {
        ingameComm.hidden = true;
      }
    },
    true,
  );

  const previewMount = shell.querySelector('#character-preview-root') as HTMLElement;
  disposeIdleCraftDockScene();
  p(0.1, 'Initializing procedural dock…');
  /* If a boot-time preload finished while the title was up, consume the FULL
   * bundle (preview + gameplay handles built into preview.scene) and skip both
   * the create() AND the inline gameplay-attach path. Single-promise pipeline
   * eliminates the previous race-condition surface area (see 2026-04-20
   * LEARNINGS — "ghost mesh" bug).
   *
   * Falls back to `create()` + inline ensure* path if preload was never
   * started, never reached this `consume`, or the gameplay-attach phase failed
   * (rare — `gameplayHandles` is null, handles get built fresh inline). */
  let preloaded = (await opts?.consumePreloadedDock?.(previewMount)) ?? null;
  let prebuiltGameplayHandles: import('../engine/dockExtendedPreload').DockExtendedPreloadHandles | null = null;
  activeDockWorkerHost = null;
  if (preloaded) {
    if (preloaded.preview instanceof CharacterSceneHost) {
      activeDockWorkerHost = preloaded.preview;
    } else {
      activeDockWorkerHost = null;
    }
    scenePreview = preloaded.preview;
    prebuiltGameplayHandles = preloaded.gameplayHandles;
    p(0.92, 'Dock ready from preload…');
  } else {
    scenePreview = await CharacterScenePreview.create(previewMount, {
      onProgress: (t, msg) => p(0.1 + Math.min(1, t) * 0.82, msg),
    });
  }
  activeDockScenePreview = scenePreview;
  /** Worker-visible cabin/station meshes (retained host) stay aligned with store. */
  const syncWorkerDockBuildablesFromStore = (): void => {
    const host = activeDockWorkerHost;
    if (!host) return;
    try {
      host.syncCabinPiecesFromMain(store.getPlacedCabinPieces());
      host.syncCraftStationsFromMain(store.getPlacedCraftStations());
    } catch {
      /* Gameplay attach may not have completed yet. */
    }
  };
  if (activeDockWorkerHost) syncWorkerDockBuildablesFromStore();

  dockPostProcessingUnsub = registerPostProcessingSync(() => {
    activeDockWorkerHost?.applyDockPostProcessing();
    activeDockScenePreview?.applyDockPostProcessing();
  });
  dockRendererDisplayUnsub = registerRendererDisplaySync(() => {
    activeDockWorkerHost?.applyDockRendererDisplay();
    activeDockScenePreview?.applyDockRendererDisplay();
    /* Awakened-quality tier lives in the same display patch and changes
     * which post passes the budget enables/disables → rebuild the post
     * stack + re-apply DPR cap whenever any display setting changes.
     * (Cheap when nothing affecting the post stack actually changed —
     * `applyPostProcessingOptionsToStack` diffs internally.) */
    activeDockWorkerHost?.applyDockPostProcessing();
    activeDockScenePreview?.applyDockPostProcessing();
    activeDockWorkerHost?.refreshPixelRatio();
    activeDockScenePreview?.refreshPixelRatio();
  });
  registerCharacterCameraForSystemMenu(() => scenePreview.resetDockCameraView());
  /* === 2026-04-20 fine-grained progress + yields ===
   *
   * Player report: "becomes unresponsive at 94% Applying survivor & gear".
   * Root cause: there was a 3700-line synchronous gap between the
   * `p(0.94, …)` emission and the next `p(0.97, …)` near the tutorial
   * mount. Even though most of those lines are function definitions /
   * subscribe registrations (individually cheap), the cumulative cost
   * (200–1000 ms on slower devices) made the veil look frozen at 94%
   * with no visible bar movement.
   *
   * Fix: split the dock-sync work into 4 yielded micro-phases with
   * per-step progress emissions. The compositor veil animates throughout,
   * the bar physically moves through 0.93 → 0.945 → 0.95 → 0.955, and
   * each step's `await yieldAnimationFrame()` gives the browser a paint
   * + input-drain slot. */
  /* === 2026-04-20 getStateRef batch ===
   *
   * Capture state ONCE for the boot setup batch instead of three separate
   * `store.getState()` deep-clones. Each call cost 1-10 ms; consolidating
   * removes that triple tax from the highest-traffic phase of mountApp's
   * post-cutscene window. */
  const bootState = store.getStateRef();
  /* === 2026-04-22 single yield after the heavy block ===
   *
   * Pre-cutscene-removal these four steps were each separated by a
   * `yieldToEventLoop()` to keep video decoder + cutscene overlay UI
   * responsive. With no video to protect, three of those four yields are
   * pure scheduler-hop overhead (each ~1 ms + V8 boundary cost) for no
   * benefit — only `syncEquipment` is heavy enough (~10-100 ms; disposes
   * 4 hand groups + rebuilds 1-3 LPCA weapon meshes) to merit a yield
   * after it. The other three (`applyCharacterPreset`, `setPageContext`,
   * `syncGatherMasteryToPreview`) are single-digit ms each.
   *
   * Progress is emitted as a single batched `p(0.95, ...)` covering the
   * whole micro-phase block — the bar still moves cleanly, and the player
   * sees the heavy `syncEquipment` step labelled instead of pretending
   * three separate phases happened. */
  scenePreview.applyCharacterPreset(bootState.characterPresetId);
  scenePreview.syncEquipment(bootState.equipment);
  scenePreview.setPageContext('gather');
  setBattleMusicMode(!!bootState.battle);
  syncGatherMasteryToPreview();
  p(0.95, 'Mounting survivor, weapons & gear…');
  await yieldToEventLoop();

  const deathModal = document.createElement('div');
  deathModal.className = 'death-modal';
  deathModal.setAttribute('aria-hidden', 'true');
  deathModal.innerHTML = `
    <div class="death-modal-backdrop" tabindex="-1" aria-hidden="true"></div>
    <div class="death-modal-card" role="alertdialog" aria-modal="true" aria-labelledby="death-modal-title" aria-describedby="death-modal-desc">
      <h2 id="death-modal-title" class="death-modal-title"></h2>
      <p id="death-modal-desc" class="death-modal-desc"></p>
      <div class="death-modal-actions">
        <button type="button" class="btn btn-primary" id="death-modal-ok">Continue — new run</button>
        <button type="button" class="btn" id="death-modal-leave" hidden>Leave online session</button>
      </div>
    </div>
  `;
  root.appendChild(deathModal);
  const deathTitleEl = deathModal.querySelector('#death-modal-title') as HTMLElement;
  const deathBodyEl = deathModal.querySelector('#death-modal-desc') as HTMLElement;

  const deathLeaveBtn = deathModal.querySelector('#death-modal-leave') as HTMLButtonElement;

  /** Tracks whether the death modal is currently open, so we can detect the
   * just-died transition (closed → open) and clean up awakened-mode HUD overlays
   * (damage floaters left over from the killing blow, the over-the-shoulder
   * camera, the magical reticle). Without this, "you took 11 / 6 / 3" damage
   * numbers stayed frozen on top of the death modal — exactly the player report. */
  let deathModalWasOpen = false;
  function syncDeathModal(): void {
    const st = store.getState();
    const open = st.lastDeathHeadline != null && st.lastDeathBody != null;
    deathModal.classList.toggle('death-modal--open', open);
    deathModal.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) {
      deathTitleEl.textContent = st.lastDeathHeadline ?? '';
      deathBodyEl.textContent = st.lastDeathBody ?? '';
      const pvp = st.lastDeathHeadline === 'Defeated in PvP' && st.onlineSession != null;
      deathLeaveBtn.hidden = !pvp;
    }
    /* On the closed→open transition, recycle every active damage floater so the
     * incoming-damage stack from the killing blow doesn't linger over the death
     * screen. Cheap when no floaters are active. The respawn flow also re-clears
     * via the awakened-mob orphan-cleanup path so a player who just respawned
     * can't see ghost damage numbers from the previous run. */
    if (open && !deathModalWasOpen) {
      damageFloatersHandle?.clearAll();
    }
    deathModalWasOpen = open;
  }

  function dismissDeathModal(): void {
    store.clearDeathMessage();
    syncDeathModal();
    refreshHud();
    renderPage();
  }

  deathModal.querySelector('#death-modal-ok')?.addEventListener('click', dismissDeathModal);
  deathLeaveBtn.addEventListener('click', () => {
    getRoomHub().leaveRoom();
    store.clearOnlineSession();
    dismissDeathModal();
  });
  deathModal.querySelector('.death-modal-backdrop')?.addEventListener('click', dismissDeathModal);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && deathModal.classList.contains('death-modal--open')) {
      e.preventDefault();
      dismissDeathModal();
    }
  });

  const nav = shell.querySelector('nav')!;
  const pageRoot = shell.querySelector('#page-root') as HTMLElement;
  const hudEl = shell.querySelector('#app-hud') as HTMLElement;

  const pages: { id: Page; label: string }[] = [
    { id: 'gather', label: 'Gather' },
    { id: 'craft', label: 'Craft' },
    { id: 'inventory', label: 'Inventory' },
    { id: 'decks', label: 'Decks' },
    { id: 'idle', label: 'Idle' },
    { id: 'rpg', label: 'RPG' },
    { id: 'battle', label: 'Battle' },
    { id: 'hire', label: 'Hire' },
    { id: 'awakening', label: 'Awakening' },
    {
      id: 'portal',
      label: 'Vibe Jam portal — use only for switching games',
    },
  ];

  function setPage(p: Page): void {
    const st = store.getState();
    const b = st.battle;
    const onlinePvpNavLock =
      !!b &&
      b.mode === 'pvp' &&
      st.onlineSession != null &&
      b.turn !== 'victory' &&
      b.turn !== 'defeat';
    if (onlinePvpNavLock && p !== 'battle') {
      return;
    }
    page = p;
    renderPage();
  }

  pages.forEach(({ id, label }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'nav-page-btn';
    b.dataset.navPage = id;
    b.textContent = label;
    if (id === 'portal') b.classList.add('nav-page-btn--portal');
    if (id === 'awakening') b.classList.add('nav-page-btn--awakening');
    b.addEventListener('click', () => setPage(id));
    nav.appendChild(b);
    if (id === 'hire') {
      const rb = document.createElement('button');
      rb.type = 'button';
      rb.className = 'nav-reset-btn';
      rb.textContent = 'Reset all progress';
      rb.title = 'Wipe save data and start a new run';
      rb.addEventListener('click', () => {
        void openIdleCraftConfirm({
          title: 'Reset all progress?',
          message:
            'Permanently wipe this browser’s Idle Craft save — you’ll keep the app shell but lose inventory, decks, helpers, and battle state.',
          confirmLabel: 'Wipe everything',
          cancelLabel: 'Cancel',
          variant: 'danger',
        }).then((ok) => {
          if (ok) {
            store.reset();
            scenePreview.applyCharacterPreset(store.getState().characterPresetId);
            renderPage();
          }
        });
      });
      nav.appendChild(rb);
    }
  });

  type MeterKind = 'hp' | 'hunger' | 'thirst' | 'mana';

  /** Survival meters: show danger styling when this low (percent0–100). */
  function meterIsCritical(kind: MeterKind, pct: number): boolean {
    const p = Math.max(0, Math.min(100, pct));
    if (kind === 'hp') return p <= 28;
    if (kind === 'mana') return p <= 18;
    return p <= 22;
  }

  function bar(label: string, pct: number, kind: MeterKind): string {
    const p = Math.max(0, Math.min(100, pct));
    const n = Math.round(p);
    const crit = meterIsCritical(kind, p);
    const critClass = crit ? ' meter--critical' : '';
    const slash = crit ? '<span class="meter-warn-slash" aria-hidden="true"></span>' : '';
    return `<div class="meter meter--${kind}${critClass}" role="group" aria-label="${label} ${n} percent${crit ? ' — low' : ''}">
      <span class="meter-label">${label}</span>
      <div class="meter-ornate">
        <span class="meter-corner meter-corner--tl" aria-hidden="true"></span>
        <span class="meter-corner meter-corner--tr" aria-hidden="true"></span>
        <span class="meter-corner meter-corner--bl" aria-hidden="true"></span>
        <span class="meter-corner meter-corner--br" aria-hidden="true"></span>
        <div class="meter-track">
          ${slash}
          <span class="meter-fill" style="width:${p}%"></span>
          <span class="meter-specular" aria-hidden="true"></span>
        </div>
      </div>
      <span class="meter-val">${n}</span>
    </div>`;
  }

  function onlineModeLabel(mode: GameMode): string | null {
    if (mode === 'coop') return 'Co-op';
    if (mode === 'pvp') return 'Hunter duel';
    if (mode === 'deathmatch') return '3v3 clash';
    return null;
  }

  function refreshHudImmediate(): void {
    /* getStateRef = no-clone read. refreshHud fires on every store emit
     * (gather tick, currency update, inventory grant, etc.) — was paying
     * a 1-10 ms deep-clone tax per emit. */
    const s = store.getStateRef();
    scenePreview.setCraftDecorAvailability(
      (s.inventory.campfire ?? 0) > 0,
      (s.inventory.workbench ?? 0) > 0,
    );
    scenePreview.setTorchInventory((s.inventory.torch ?? 0) > 0);
    scenePreview.setTorchEquipped(s.torchEquipped);
    const sessionRow =
      s.onlineSession != null
        ? (() => {
            const lab = onlineModeLabel(s.gameMode);
            if (!lab) return '';
            const rid = String(s.onlineSession.roomId).replace(/[^A-Z0-9-]/gi, '');
            const team =
              s.gameMode === 'deathmatch'
                ? s.onlineSession.team === 0
                  ? '<span class="hud-session__team">Team A</span>'
                  : s.onlineSession.team === 1
                    ? '<span class="hud-session__team">Team B</span>'
                    : ''
                : '';
            const nParty = s.onlineSession.partyRoster?.length ?? 0;
            const party =
              nParty > 0
                ? `<span class="hud-session__party">${nParty} in party</span>`
                : '';
            return `<div class="hud-session" role="status"><span class="hud-session__badge">${lab}</span><span class="hud-session__room">Room ${rid}</span>${team}${party}</div>`;
          })()
        : '';
    hudEl.innerHTML = `
      ${sessionRow}
      <div class="hud-stats">
        <div class="hud-meters">
          ${bar('HP', (s.playerHp / s.playerMaxHp) * 100, 'hp')}
          ${bar('HUNGER', s.hunger, 'hunger')}
          ${bar('THIRST', s.thirst, 'thirst')}
          ${bar('MANA', (s.mana / Math.max(1, store.getEffectiveMaxMana())) * 100, 'mana')}
        </div>
        <div class="hud-meta">
          <span class="hud-combat-stat hud-combat-stat--atk" role="group" aria-label="Attack bonus ${store.getWeaponDamageBonus()}">
            <span class="hud-combat-stat__ledge" aria-hidden="true"></span>
            <span class="hud-combat-stat__label">ATK</span>
            <span class="hud-combat-stat__val">+${store.getWeaponDamageBonus()}</span>
          </span>
          <span class="hud-combat-stat hud-combat-stat--arm" role="group" aria-label="Armor mitigation ${store.getArmorMitigation()}">
            <span class="hud-combat-stat__ledge" aria-hidden="true"></span>
            <span class="hud-combat-stat__label">ARM</span>
            <span class="hud-combat-stat__val">${store.getArmorMitigation()}</span>
          </span>
          <span class="hud-chip hud-chip--coin">¤ ${Math.floor(s.currency)}</span>
          ${
            (s.inventory.cooler ?? 0) > 0
              ? '<span class="hud-cooler hud-cooler--on" role="status"><span class="hud-cooler__therm" aria-hidden="true"></span><span class="hud-cooler__text"><strong>Cooler</strong> · slower spoil</span></span>'
              : '<span class="hud-cooler hud-cooler--off" role="status"><span class="hud-cooler__therm" aria-hidden="true"></span><span class="hud-cooler__text">No cooler · faster spoil</span></span>'
          }
        </div>
      </div>
    `;
    syncDeathModal();
  }

  function refreshHud(): void {
    if (!isDockVisualLowBudget()) {
      refreshHudImmediate();
      return;
    }
    if (hudRefreshRaf !== 0) return;
    hudRefreshRaf = requestAnimationFrame(() => {
      hudRefreshRaf = 0;
      refreshHudImmediate();
    });
  }

  function refreshGatherInv(s: ReturnType<GameStore['getState']>): void {
    const invEl = pageRoot.querySelector('.inv') as HTMLElement | null;
    if (!invEl) return;
    const rows = Object.entries(s.inventory)
      .filter(([, v]) => v > 0.01)
      .sort((a, b) => a[0].localeCompare(b[0]));
    invEl.innerHTML =
      rows.map(([k, v]) => invQuickRowHtml(k, v)).join('') ||
      '<span class="inv-quick-empty">Nothing stocked</span>';
    bindInvQuickResourceHover(invEl);
  }

  function harvestPatchesSig(s: ReturnType<GameStore['getState']>): string {
    return JSON.stringify(s.harvestPatches ?? {});
  }

  /**
   * Signature of resource-bearing inventory state. Used by the store-subscribe handler
   * to detect that a mid-gather grant landed (`tick` → `performGather` → `emit`) while
   * the player is on the Inventory tab, so the inventory list refreshes without needing
   * a manual tab change. Bucketed to one decimal so float drift from idle slots / spoilage
   * doesn't trigger constant re-renders.
   */
  function inventoryPageSig(s: ReturnType<GameStore['getState']>): string {
    const parts: string[] = [];
    const keys = Object.keys(s.inventory).sort();
    for (const k of keys) {
      const v = s.inventory[k] ?? 0;
      if (v <= 0.005) continue;
      parts.push(`${k}:${Math.round(v * 10) / 10}`);
    }
    parts.push(`$:${Math.round(s.currency)}`);
    return parts.join('|');
  }

  function rpgPanelSig(s: ReturnType<GameStore['getState']>): string {
    return JSON.stringify({
      mastery: s.harvestMastery,
      currency: s.currency,
      patches: s.harvestPatches,
    });
  }

  function syncGatherMasteryToPreview(): void {
    const st = store.getState();
    const toward: Partial<Record<HarvestNodeKind, number>> = {};
    const clip: Partial<Record<HarvestNodeKind, number>> = {};
    for (const k of HARVEST_NODE_KINDS) {
      const tr = st.harvestMastery[k]?.travel ?? 0;
      toward[k] = travelTowardHome01(tr);
      clip[k] = gatherClipDurationFactor(tr);
    }
    scenePreview.syncGatherRpgVisuals(toward, clip);
  }

  /** Update gather button enabled/detail when harvest nodes respawn (full page is not re-mounted). */
  function refreshGatherActionButtons(): void {
    const layout = pageRoot.querySelector('.gather-page-layout') as HTMLElement | null;
    if (!layout) return;
    /* Busy state is now sourced from the store so it stays consistent across tab switches:
     * even if the gather page was re-mounted mid-gather, the buttons reflect the in-flight
     * gather instead of the freshly-rendered (non-busy) DOM dataset. */
    const busy = !!store.getActiveGather();
    layout.dataset.gatherBusy = busy ? '1' : '';
    const btns = layout.querySelectorAll<HTMLButtonElement>('.gather-action-btn');
    let ix = 0;
    for (const group of store.listGatherActionGroups()) {
      for (const a of group.actions) {
        const btn = btns[ix++];
        if (!btn) return;
        const locked = !a.enabled;
        btn.classList.toggle('gather-action-btn--locked', locked);
        btn.disabled = busy || locked;
        const titleEl = btn.querySelector('.gather-btn-title');
        const detailEl = btn.querySelector('.gather-btn-detail');
        if (titleEl) titleEl.textContent = `${a.title}${a.enabled ? '' : ' (locked)'}`;
        if (detailEl) detailEl.textContent = a.detail;
      }
    }
  }

  function bindInvQuickResourceHover(container: HTMLElement): void {
    container
      .querySelectorAll<HTMLElement>('.inv-quick-row[data-res], .inv-cell--grid[data-res]')
      .forEach((row) => {
        row.addEventListener('mouseenter', () => {
          const key = row.dataset.res ?? '';
          if (key !== lastInvHoverKey) {
            scenePreview.setResourceHover(key);
            lastInvHoverKey = key;
          }
        });
        row.addEventListener('mouseleave', () => {
          if (lastInvHoverKey !== '') {
            scenePreview.setResourceHover('');
            lastInvHoverKey = '';
          }
        });
      });
  }

  function fmtMerchantDur(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  function updateGatherMerchantClock(): void {
    if (page !== 'gather') return;
    const el = pageRoot.querySelector('.merchant-visit-clock');
    if (!el) return;
    const st = store.getState();
    const mer = st.merchant;
    const now = Date.now();
    if (mer.presentUntilMs > now) {
      el.textContent = `Departs in ${fmtMerchantDur(mer.presentUntilMs - now)}`;
    } else {
      el.textContent = `Arrives in ${fmtMerchantDur(Math.max(0, mer.nextVisitAtMs - now))}`;
    }
  }

  function merchantGatherSig(st: ReturnType<GameStore['getState']>): string {
    return JSON.stringify({ m: st.merchant, c: Math.floor(st.currency) });
  }

  function shouldShowMerchantOffer(o: MerchantOfferDef, st: ReturnType<GameStore['getState']>): boolean {
    if (st.pveWave < o.minPveWave) return false;
    if (o.kind === 'card' && o.cardId) {
      if (st.unlockedCardIds.includes(o.cardId)) return false;
      const c = cardById.get(o.cardId);
      if (!c) return false;
      if (!merchantCardPrereqsMet(c, new Set(st.unlockedCardIds))) return false;
    }
    return true;
  }

  function refreshSoft(): void {
    refreshHud();
    if (page === 'gather') {
      refreshGatherInv(store.getState());
      updateGatherMerchantClock();
    }
  }

  /** True if this client is the room host (dock-left / “solo hero” side in Hunter 1v1). */
  function localClientIsRoomHost(): boolean {
    const youSid = store.getYourRoomSessionId();
    if (!youSid) return true;
    const hostSid = store.getRoomHostSessionId();
    if (hostSid) return youSid === hostSid;
    const youRow = store.getLastRoomPlayers().find((p) => p.sessionId === youSid);
    if (youRow) return !!youRow.isHost;
    const hostRow = store.getLastRoomPlayers().find((p) => p.isHost);
    if (hostRow) return hostRow.sessionId === youSid;
    return true;
  }

  /**
   * Hunter / PvP dock layout + presence — must run after every room_snapshot, not only full renderPage,
   * or the guest keeps default host-side seats until the next tab click.
   */
  function applyOnlineCharacterDockVisuals(): void {
    const sOnline = store.getStateRef();
    const inPvpBattle = page === 'battle' && sOnline.battle?.mode === 'pvp';
    const hunterSharedWorld =
      sOnline.gameMode === 'pvp' &&
      !!sOnline.onlineSession &&
      !inPvpBattle &&
      page !== 'portal';
    const localIsRoomHost = localClientIsRoomHost();
    const hunterGuestSeat = hunterSharedWorld && !localIsRoomHost;
    scenePreview.setHunterSharedWorldActive(hunterSharedWorld, hunterGuestSeat);

    if (page === 'battle' && sOnline.battle) {
      if (sOnline.battle.mode === 'pvp' && sOnline.battle.enemy.rivalCharacterPresetId) {
        scenePreview.syncPvpDockRivalPreset(sOnline.battle.enemy.rivalCharacterPresetId);
      }
      scenePreview.syncBattleContext(sOnline.battle.enemy.id);
    } else {
      scenePreview.syncBattleContext(null);
    }

    if (sOnline.onlineSession && sOnline.gameMode !== 'solo') {
      if (page === 'battle' && sOnline.battle?.mode === 'pvp') {
        const alive = store.getLastRoomPlayers().filter((p) => !p.eliminated).length;
        scenePreview.setPvpDuelDockLayout(
          sOnline.gameMode === 'deathmatch' ? 'bracket' : 'duel',
          alive,
          !localIsRoomHost,
        );
      } else {
        scenePreview.setPvpDuelDockLayout('off');
      }
      const hunterW =
        sOnline.gameMode === 'pvp' && !!sOnline.onlineSession && !inPvpBattle && page !== 'portal';
      scenePreview.syncOnlinePresence(
        store.getRemotePresenceSnapshot(),
        store.getYourRoomSessionId(),
        store.getLastRoomPlayers(),
        onlinePresenceDockOpts(hunterW),
      );
    } else {
      scenePreview.setHunterSharedWorldActive(false);
      scenePreview.setPvpDuelDockLayout('off');
      scenePreview.syncOnlinePresence(new Map(), null, [], {
        gatherMiniGhosts: false,
        hunterDuoWorld: false,
        awakenCoopPeers: false,
      });
    }
    scenePreview.setPageContext(page as AppPageContext);
  }

  function renderPageBody(): void {
    const s = store.getState();
    const bn = s.battle;
    const onlinePvpNavLock =
      !!bn &&
      bn.mode === 'pvp' &&
      s.onlineSession != null &&
      bn.turn !== 'victory' &&
      bn.turn !== 'defeat';
    const awakeningVisible = store.getAwakeningVisible();
    const realmAwakened = store.getRealmMode() === 'awakened';
    nav.querySelectorAll<HTMLButtonElement>('button[data-nav-page]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.navPage === page);
      const id = btn.dataset.navPage as Page;
      btn.disabled = onlinePvpNavLock && id !== 'battle';
      /* Awakening tab: hidden until at least one shard recovered (or dev flag on). */
      if (id === 'awakening') {
        btn.style.display = awakeningVisible ? '' : 'none';
      }
    });
    /* Phase A debug banner — Phase C replaces this with full mode-aware nav hiding +
     * WASD free-roam. For now we just show a small chip so the realmMode flip is
     * visibly confirmed when the player clicks Break. */
    shell.classList.toggle('realm-awakened', realmAwakened);

    pageRoot.innerHTML = '';
    refreshHud();

    if (page === 'gather') renderGather(pageRoot, s);
    else if (page === 'craft') renderCraft(pageRoot, s);
    else if (page === 'inventory') renderInventory(pageRoot, s);
    else if (page === 'decks') renderDecks(pageRoot, s);
    else if (page === 'idle') renderIdle(pageRoot, s);
    else if (page === 'rpg') renderRpg(pageRoot, s);
    else if (page === 'battle') renderBattle(pageRoot, s);
    else if (page === 'hire') renderHire(pageRoot, s);
    else if (page === 'awakening') renderAwakening(pageRoot, store);
    else if (page === 'portal') renderPortal(pageRoot, s);

    /* === 2026-04-20 skip-redundant syncEquipment ===
     *
     * `scenePreview.syncEquipment` disposes 4 hand-mount groups and rebuilds
     * weapon/pick/shield meshes. It was running on EVERY `renderPage` call
     * (every tab switch + every store emit that triggered a re-render),
     * but equipment changes are rare. Skip when the equipment signature is
     * unchanged — drops the 5-50ms mesh-rebuild cost from the hot
     * `renderPage` path while keeping correct behavior the moment the
     * player swaps gear. */
    const eqSig = `${s.equipment.weapon ?? ''}|${s.equipment.pick ?? ''}|${s.equipment.shield ?? ''}`;
    if (eqSig !== lastEquipmentSig) {
      lastEquipmentSig = eqSig;
      scenePreview.syncEquipment(s.equipment);
    }
    applyOnlineCharacterDockVisuals();
    if (page === 'gather' || page === 'rpg') syncGatherMasteryToPreview();
    if (page === 'rpg') lastRpgPanelSig = rpgPanelSig(s);
    /* Seed the inventory signature on every page mount — the store-subscribe handler
     * uses it to detect mid-gather grants that landed during a tab switch. Without this
     * seed, the first emit after a tab switch would always trigger a redundant re-render. */
    lastInventoryPageSig = inventoryPageSig(s);
    sendOnlinePresence();
    syncTutorialAfterRender();
  }

  function renderPage(): void {
    /* Awakened mode: SKIP the view-transition animation. `document.startViewTransition`
     * snapshots the entire viewport (including the dock canvas), runs the DOM update,
     * then cross-fades old → new for ~250ms. During the fade the canvas is frozen
     * showing the captured frame — exactly what looks like a "scene reset / freeze /
     * blur" when the player is in fullscreen free-roam. The deck pages are hidden
     * behind the awakened canvas anyway, so the page-transition animation is invisible.
     * Render the body directly so the canvas keeps animating live.
     *
     * Deck mode keeps the smooth view transition for navigations between gather / craft
     * / inventory / etc. — that's the whole point of the API and there's no canvas-freeze
     * concern there because the canvas is a small embedded preview, not the main view. */
    if (store.getRealmMode() === 'awakened') {
      renderPageBody();
      return;
    }
    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => {
        /** Resolves when the cross-fade animation completes; rejects with
         *  AbortError if a newer transition supersedes this one. */
        finished: Promise<void>;
        /** Resolves when the snapshot is ready; can reject independently of
         *  `finished` when the transition is cancelled before snapshot. */
        ready?: Promise<void>;
        /** Resolves when the DOM-update callback completes; rejects on
         *  callback error OR supersession. */
        updateCallbackDone?: Promise<void>;
      };
    };
    if (typeof doc.startViewTransition === 'function') {
      try {
        const transition = doc.startViewTransition(() => renderPageBody());
        /* Swallow `AbortError: Transition was skipped` — fires whenever a NEW
         * `startViewTransition` is invoked before this one's animation
         * completes (which is normal during fast page-switch sequences like
         * cutscene-end → renderPage from store-emit → another renderPage from
         * a different subscriber). The page DOM update still happens; only
         * the cross-fade animation is cancelled. The View Transitions API
         * exposes THREE promises (`finished`, `ready`, `updateCallbackDone`)
         * that can independently reject on supersession; catching all three
         * silences every code path. */
        const swallow = (): void => { /* superseded transition — benign */ };
        transition.finished.catch(swallow);
        transition.ready?.catch(swallow);
        transition.updateCallbackDone?.catch(swallow);
      } catch {
        /* Some browsers throw synchronously on certain transition states.
         * The DOM update still needs to happen — fall through to direct render. */
        renderPageBody();
      }
    } else {
      renderPageBody();
    }
  }

  function renderRpg(el: HTMLElement, s: ReturnType<GameStore['getState']>): void {
    const wrap = document.createElement('div');
    wrap.className = 'rpg-page-layout';
    wrap.dataset.tutorialRpgAnchor = '';

    const intro = document.createElement('div');
    intro.className = 'panel-block rpg-intro';
    intro.innerHTML = `
      <h2>Harvest mastery</h2>
      <p class="desc">
        Each manual vein has three paths: <strong>pathfinding</strong> (props sit closer to camp, shorter walks and gather clips),
        <strong>bounty</strong> (more resources per successful gather), and <strong>regrowth sense</strong> (depleted nodes return faster; each harvest adds slightly less strain).
        Stress builds on the vein; at the cap it <strong>seals</strong> — no more respawns for that vein this expedition.
      </p>
      <p class="desc rpg-currency-line">Coin: <strong>¤ ${Math.floor(s.currency)}</strong></p>
    `;
    wrap.appendChild(intro);

    const grid = document.createElement('div');
    grid.className = 'rpg-vein-grid';

    const branches: MasteryBranch[] = ['travel', 'yield', 'regrowth'];

    for (const kind of HARVEST_NODE_KINDS) {
      const card = document.createElement('div');
      card.className = 'panel-block rpg-vein-card';
      const patch = s.harvestPatches[kind];
      const strain = patch?.strain ?? 0;
      const sealed = !!patch?.sealed;
      const m = s.harvestMastery[kind] ?? { travel: 0, yield: 0, regrowth: 0 };
      const strainPct = Math.min(100, (strain / SEAL_STRAIN_CAP) * 100);

      const branchHtml = branches
        .map((br) => {
          const tier = m[br];
          const maxed = tier >= HARVEST_MASTERY_MAX_TIER;
          const cost = masteryUpgradeCost(br, tier);
          const blurb = MASTERY_BRANCH_BLURB[br];
          const affordable = Number.isFinite(cost) && s.currency >= cost;
          const disabled = maxed || !affordable;
          const btnLabel = maxed ? 'Maxed' : `Upgrade — ¤ ${cost}`;
          const statLine =
            br === 'travel'
              ? `Walk lerp ${(travelTowardHome01(tier) * 100).toFixed(0)}% toward camp · clip ×${gatherClipDurationFactor(tier).toFixed(2)}`
              : br === 'yield'
                ? `Loot ×${harvestYieldMultiplier(tier).toFixed(2)}`
                : `Respawn time ×${regrowthTimeMultiplier(tier).toFixed(2)} (lower is faster)`;

          return `
            <div class="rpg-branch" data-branch="${br}">
              <div class="rpg-branch-head">
                <strong>${escapeHtml(blurb.title)}</strong>
                <span class="rpg-tier">Tier ${tier} / ${HARVEST_MASTERY_MAX_TIER}</span>
              </div>
              <p class="rpg-branch-body">${escapeHtml(blurb.body)}</p>
              <p class="rpg-branch-stat">${escapeHtml(statLine)}</p>
              <button type="button" class="btn btn-primary rpg-upgrade-btn${disabled ? ' rpg-upgrade-btn--disabled' : ''}" data-kind="${kind}" data-branch="${br}" ${disabled ? 'disabled' : ''}>${escapeHtml(btnLabel)}</button>
            </div>
          `;
        })
        .join('');

      card.innerHTML = `
        <div class="rpg-vein-head">
          <h3>${escapeHtml(HARVEST_KIND_LABEL[kind])}</h3>
          ${sealed ? '<span class="rpg-sealed-badge" title="This vein no longer respawns this run">Sealed</span>' : ''}
        </div>
        <div class="rpg-strain-wrap" role="group" aria-label="Vein strain toward seal">
          <div class="rpg-strain-label">Strain <span class="rpg-strain-num">${Math.floor(strain)}</span> / ${SEAL_STRAIN_CAP}</div>
          <div class="rpg-strain-bar" aria-hidden="true"><div class="rpg-strain-fill" style="width:${strainPct}%"></div></div>
          <p class="rpg-strain-hint">+${veinStrainPerGather(m.travel, m.regrowth)} strain per successful gather (pathfinding &amp; regrowth mastery reduce this).</p>
        </div>
        <div class="rpg-branch-list">
          ${branchHtml}
        </div>
      `;
      grid.appendChild(card);
    }

    wrap.appendChild(grid);

    const roadmap = document.createElement('div');
    roadmap.className = 'panel-block rpg-roadmap';
    roadmap.innerHTML = `
      <h2>More RPG we could add</h2>
      <p class="desc">Ideas for later — not simulated in this build.</p>
      <ul class="rpg-roadmap-list">
        ${RPG_ROADMAP_IDEAS.map((idea) => `<li>${escapeHtml(idea)}</li>`).join('')}
      </ul>
    `;
    wrap.appendChild(roadmap);

    el.appendChild(wrap);

    wrap.querySelectorAll<HTMLButtonElement>('.rpg-upgrade-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        const k = btn.dataset.kind as HarvestNodeKind;
        const b = btn.dataset.branch as MasteryBranch;
        if (store.upgradeHarvestMastery(k, b)) renderPage();
      });
    });
  }

  function renderPortal(el: HTMLElement, s: ReturnType<GameStore['getState']>): void {
    const wrap = document.createElement('div');
    wrap.className = 'portal-page-layout';
    wrap.dataset.tutorialPortalAnchor = '';

    const intro = document.createElement('div');
    intro.className = 'panel-block portal-panel';
    intro.innerHTML = `
      <h2>Vibe Jam portal</h2>
      <p class="portal-purpose-callout">Vibe Jam portal — use only for switching games.</p>
      <p class="desc">
        Official <strong>webring exit</strong>: when your character <strong>finishes walking into the ring</strong> in the dock,
        this app sends you to <code class="portal-code">${VIBEJAM_PORTAL_HUB_2026}</code> with your <code>ref</code> (this host),
        <code>hp</code>, and a few continuity fields. The <strong>hub picks the next jam game</strong> and opens it — you don’t choose from a list here.
      </p>
      <p class="desc portal-desc-second">
        Arriving from another game? You’ll have <code>?portal=true</code> in the URL; add a return portal later if you want players to hop back using the same params (see jam rules).
      </p>
      <p class="portal-meta">Wins: <strong>${s.pveWave}</strong> · Rules: <a href="https://vibej.am/2026" target="_blank" rel="noopener noreferrer">vibej.am/2026</a></p>
    `;
    wrap.appendChild(intro);
    el.appendChild(wrap);
  }

  function renderGather(el: HTMLElement, s: ReturnType<GameStore['getState']>): void {
    const wrap = document.createElement('div');
    wrap.className = 'gather-page-layout';
    wrap.dataset.tutorialGatherLayout = '';
    const merchantHere = store.isMerchantPresent();
    const now = Date.now();
    const mer = s.merchant;
    let clockText: string;
    if (mer.presentUntilMs > now) {
      clockText = `Departs in ${fmtMerchantDur(mer.presentUntilMs - now)}`;
    } else {
      clockText = `Arrives in ${fmtMerchantDur(Math.max(0, mer.nextVisitAtMs - now))}`;
    }

    const sellable = Object.entries(s.inventory)
      .filter(([, v]) => v > 0.01)
      .filter(([k]) => canSellResourceToMerchant(k))
      .sort((a, b) => a[0].localeCompare(b[0]));

    const offerRows = MERCHANT_OFFERS.filter((o) => shouldShowMerchantOffer(o, s))
      .map((o) => {
        const avail = store.merchantOfferAvailable(o.id);
        const sold = s.merchant.soldThisVisit[o.id] ?? 0;
        const stockLeft = Math.max(0, o.maxPerVisit - sold);
        const kindTag = o.kind === 'card' ? '<span class="merchant-offer-tag">Charter</span>' : '';
        return `
          <div class="merchant-offer${avail ? '' : ' merchant-offer--na'}" data-offer="${o.id}">
            <div class="merchant-offer-head">
              <strong>${escapeHtml(o.label)}</strong> ${kindTag}
              <span class="merchant-offer-price">¤ ${o.price}</span>
            </div>
            <p class="merchant-offer-desc">${escapeHtml(o.description)}</p>
            <p class="merchant-offer-meta">Stock this visit: ${stockLeft} / ${o.maxPerVisit}</p>
            <button type="button" class="btn btn-primary merchant-buy-btn" data-offer="${o.id}" ${avail ? '' : 'disabled'}>
              ${avail ? 'Buy' : s.currency < o.price ? 'Not enough coin' : 'Sold out / unavailable'}
            </button>
          </div>
        `;
      })
      .join('');

    const sellRows =
      merchantHere && sellable.length > 0
        ? sellable
            .map(([resId, qty]) => {
              const q = Math.floor(qty * 100) / 100;
              const p1 = merchantSellPayout(resId, 1);
              const p10 = merchantSellPayout(resId, Math.min(10, q));
              const pall = merchantSellPayout(resId, q);
              return `
            <div class="merchant-sell-row" data-sell-res="${resId}">
              <span class="merchant-sell-name">${escapeHtml(formatRes(resId))}</span>
              <span class="merchant-sell-qty">${formatNum(q)}</span>
              <span class="merchant-sell-actions">
                <button type="button" class="btn merchant-sell-btn" data-amt="1" ${p1 <= 0 ? 'disabled' : ''}>Sell 1 (+${p1}¤)</button>
                <button type="button" class="btn merchant-sell-btn" data-amt="10" ${p10 <= 0 ? 'disabled' : ''}>10 (+${p10}¤)</button>
                <button type="button" class="btn merchant-sell-btn" data-amt="all" ${pall <= 0 ? 'disabled' : ''}>All (+${pall}¤)</button>
              </span>
            </div>`;
            })
            .join('')
        : '';

    wrap.innerHTML = `
      <div class="panel-block merchant-panel" data-tutorial-merchant>
        <h2>Wandering merchant</h2>
        <p class="merchant-visit-clock">${clockText}</p>
        <p class="desc merchant-panel-blurb">
          ${
            merchantHere
              ? 'A loaded caravan buys surplus and sells oddities — <strong>coin only</strong>. When they leave, the next run is a while out.'
              : 'The next caravan is on the road. When they arrive, you can <strong>sell resources</strong> and browse <strong>special stock</strong> (bundles and rare deck charters).'
          }
        </p>
        ${
          merchantHere
            ? `<div class="merchant-sections">
          <div class="merchant-sell-block">
            <h3>Sell surplus</h3>
            ${
              sellRows
                ? `<div class="merchant-sell-rows">${sellRows}</div>`
                : '<p class="merchant-empty">Nothing eligible to sell (tools, structures, and bandages stay with you).</p>'
            }
          </div>
          <div class="merchant-buy-block">
            <h3>Special stock</h3>
            <div class="merchant-offer-grid">${offerRows || '<p class="merchant-empty">Nothing offered this visit.</p>'}</div>
          </div>
        </div>`
            : ''
        }
      </div>
      <div class="panel-block">
        <h2>Manual gathering</h2>
        <div class="gather-btns"></div>
      </div>
      <div class="panel-block">
        <h2>Quick inventory</h2>
        <div class="inv inv-quick"></div>
      </div>
    `;
    el.appendChild(wrap);
    refreshGatherInv(s);

    const btns = wrap.querySelector('.gather-btns')!;
    for (const group of store.listGatherActionGroups()) {
      const gh = document.createElement('h3');
      gh.className = 'gather-group-title';
      gh.textContent = group.title;
      btns.appendChild(gh);
      for (const a of group.actions) {
        const b = document.createElement('button');
        b.className = 'btn gather-action-btn' + (a.enabled ? '' : ' gather-action-btn--locked');
        b.type = 'button';
        b.dataset.tutorialGather = a.id;
        b.disabled = !a.enabled;
        b.innerHTML = `<span class="gather-btn-title">${a.title}${a.enabled ? '' : ' (locked)'}</span><span class="gather-btn-detail">${a.detail}</span>`;
        b.addEventListener('click', () => {
          if (!a.enabled) return;
          /* Reject if a gather is already in flight — the store rejects too, but bailing
           * here saves the slot reservation and avoids visual stutter on the dock. */
          if (store.getActiveGather()) return;
          const wxz = scenePreview.getGatherWaterBankXZ();
          const { x: ax, z: az } = scenePreview.getAvatarGroundXZ();
          const slot = store.reserveHarvestSlot(a.id, ax, az, wxz);
          if (slot === null) return;
          const ms = scenePreview.getGatherClipDurationMs(a.id);
          const sfxMs = scenePreview.getGatherSfxDelayMs(a.id);
          /* Dock animation lives independently of the page DOM — it runs on the WebGL scene
           * and survives any tab switch. The grant + SFX timing is now owned by the store
           * (`startGather` → `tick` advances it), so a mid-gather tab switch can no longer
           * lose the resource: `tick` fires regardless of which page is mounted, and the
           * store-subscribe handler below re-renders whichever page is currently visible. */
          scenePreview.playGatherAction(a.id, slot);
          sendOnlinePresence(a.id, 0);
          stopGatherPresencePump();
          gatherPresenceRaf = requestAnimationFrame(() => pumpGatherPresence(a.id));
          store.startGather(a.id, slot, ms, sfxMs);
          if (ms <= 0) {
            /* Instant gather (rare; no clip) — refresh immediately for responsive feel. */
            stopGatherPresencePump();
            sendOnlinePresence(null, null);
            refreshHud();
            refreshGatherInv(store.getState());
          }
        });
        btns.appendChild(b);
      }
    }

    /* Sync initial busy state from store: covers the case where the gather page is
     * rendered fresh while a gather is mid-flight (e.g. user switched tabs and back). */
    refreshGatherActionButtons();

    wrap.querySelectorAll<HTMLElement>('.merchant-sell-row').forEach((row) => {
      const resId = row.dataset.sellRes;
      if (!resId) return;
      row.querySelectorAll<HTMLButtonElement>('.merchant-sell-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const amt = btn.dataset.amt;
          const have = store.getState().inventory[resId] ?? 0;
          let n = 1;
          if (amt === '10') n = Math.min(10, have);
          else if (amt === 'all') n = have;
          if (n <= 0) return;
          if (store.sellResourceToMerchant(resId, n)) renderPage();
        });
      });
    });
    wrap.querySelectorAll<HTMLButtonElement>('.merchant-buy-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.offer;
        if (!id || btn.disabled) return;
        if (store.buyMerchantOffer(id)) renderPage();
      });
    });

    lastGatherHarvestSig = harvestPatchesSig(s);
    lastMerchantGatherSig = merchantGatherSig(s);
  }

  function renderCraft(el: HTMLElement, s: ReturnType<GameStore['getState']>): void {
    const intro = document.createElement('div');
    intro.className = 'panel-block';
    intro.dataset.tutorialCraftAnchor = '';
    intro.innerHTML = `<h2>Craft — by station deck</h2>
      <p style="color:var(--muted);font-size:0.85rem">Stations use items in your camp counts (campfire / workbench / forge in <strong>Inventory</strong>). <strong>Campfire</strong> cooking only lists when you have a crafted campfire. Spoilage makes food fractional — material counts below truncate down so they match the craft check.</p>`;
    el.appendChild(intro);

    const mats = document.createElement('div');
    mats.className = 'panel-block';
    const matRows = Object.entries(s.inventory)
      .filter(([, v]) => v > 0.01)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => invQuickRowHtml(k, v))
      .join('');
    mats.innerHTML = `<h2>Materials in camp</h2>
      <p style="color:var(--muted);font-size:0.78rem;margin:0 0 0.5rem">Same numbers crafting uses (integer recipes need at least that much after decay).</p>
      <div class="inv-quick">${matRows || '<span class="inv-quick-empty">Nothing in camp</span>'}</div>`;
    bindInvQuickResourceHover(mats);
    el.appendChild(mats);

    const avail = store.availableRecipes();
    const byStation = new Map<CraftStation, typeof avail>();
    for (const st of STATION_ORDER) byStation.set(st, []);
    for (const r of avail) {
      byStation.get(r.station)?.push(r);
    }

    for (const st of STATION_ORDER) {
      const list = byStation.get(st) ?? [];
      const deck = document.createElement('div');
      deck.className = 'craft-deck';
      deck.innerHTML = `<div class="craft-deck-head"><h3>${STATION_TITLE[st]}</h3><span class="craft-deck-meta">${list.length} recipe(s)</span></div>`;
      const body = document.createElement('div');
      body.className = 'craft-deck-body';
      if (list.length === 0) {
        body.innerHTML = `<p class="craft-deck-empty">Nothing here yet — unlock cards in Decks or build the right station (see Inventory for campfire / workbench counts).</p>`;
      } else {
        for (const r of list) {
          const can = store.canCraft(r.id);
          const row = document.createElement('div');
          row.className = 'recipe-row';
          row.innerHTML = `
            <div style="flex:1;min-width:200px">
              <strong>${r.name}</strong>
              <div style="font-size:0.75rem;color:var(--muted);margin-top:0.2rem">${r.description}</div>
              <div style="font-size:0.72rem;color:var(--muted);margin-top:0.25rem">${fmtIO(r.inputs)} → ${fmtIO(r.outputs)}</div>
            </div>
            <span style="color:var(--muted);font-size:0.75rem">${r.timeSeconds}s</span>
          `;
          const btn = document.createElement('button');
          btn.className = 'btn btn-primary';
          btn.textContent = can ? 'Craft' : 'Need mats';
          btn.disabled = !can;
          btn.addEventListener('click', () => {
            scenePreview.playCraftHammer(r.station, r.id);
            store.craft(r.id);
            refreshHud();
            renderPage();
          });
          row.appendChild(btn);
          body.appendChild(row);
        }
      }
      deck.appendChild(body);
      el.appendChild(deck);
    }

    const locked = document.createElement('div');
    locked.className = 'panel-block';
    const lockedRecipes = allRecipes.filter((r) => !avail.some((a) => a.id === r.id));
    locked.innerHTML = `<h2>Locked recipes (${lockedRecipes.length})</h2>
      <p style="color:var(--muted);font-size:0.8rem">Unlock blueprint cards in Decks or build stations to reveal these here.</p>`;
    const ul = document.createElement('ul');
    ul.className = 'locked-list';
    for (const r of lockedRecipes.slice(0, 24)) {
      const li = document.createElement('li');
      li.textContent = `${r.name} (${r.station})`;
      ul.appendChild(li);
    }
    if (lockedRecipes.length > 24) {
      const li = document.createElement('li');
      li.textContent = `…and ${lockedRecipes.length - 24} more`;
      ul.appendChild(li);
    }
    locked.appendChild(ul);
    el.appendChild(locked);
  }

  function renderInventory(el: HTMLElement, s: ReturnType<GameStore['getState']>): void {
    /* Magic shortcut bar — same two slots as the awakened-mode hotbar, surfaced here
     * so the player can equip / swap their offensive / defensive spells from inside
     * the Inventory tab without having to enter awakened mode first. The bar is
     * dispose-and-rebuilt per render so each fresh inventory render gets a clean
     * subscription (the previous one's store-unsub fires on dispose). The bar's own
     * sig-gated refresh keeps redraw cost minimal between equips. Two keys tracked
     * so the deck-mode page and the awakened-overlay page get separate handles
     * (both can be live simultaneously when the player Tab-opens the overlay). */
    const isAwakenedOverlay = el === awakenedOverlayBodyEl;
    const handleKey = isAwakenedOverlay ? 'inventoryAwakened' : 'inventoryDeck';
    disposeShortcutBar(handleKey);
    shortcutBarHandles[handleKey] = mountShortcutBar(el, store, {
      modalHost: shell,
      helperText: 'Awakened-mode magic shortcuts. Click a slot to pick from your unlocked spells.',
    });

    /* 6-slot consumable hotbar — read-only preview. Assigning happens via the
     * inline `quickEquipPanel` directly below it (one-click slot buttons next
     * to each consumable). Hotbar slot clicks here are intentionally NOT wired
     * to a modal anymore — the user reported the modal felt like "going to
     * another page" which obscured the inventory grid + hotbar simultaneously.
     * Right-click still falls back to the modal as a power-user shortcut.
     * `useOnFilledClick: false` so left-click on a filled slot is also a
     * preview-only action (no accidental consume). */
    disposeConsumableHotbar(handleKey);
    consumableHotbarHandles[handleKey] = mountConsumableHotbar(el, store, {
      modalHost: shell,
      useOnFilledClick: false,
      helperText: 'Hotbar preview — these are the slots active in awakened mode. Use the Quick-equip panel below to assign.',
    });
    /* Quick-equip panel — per-consumable rows with inline 1-6 slot buttons.
     * Single-click assigns; click an already-equipped slot to unequip. This is
     * the primary inventory-page assignment surface — no modal, never leaves
     * the page. */
    disposeQuickEquip(handleKey);
    quickEquipHandles[handleKey] = mountQuickEquipPanel(el, store);

    const eq = document.createElement('div');
    eq.className = 'panel-block equip-panel';
    eq.dataset.tutorialInventoryAnchor = '';
    eq.innerHTML = `<h2 class="forge-section-title">Equipment</h2>
      <p style="color:var(--muted);font-size:0.85rem">Equip <strong>weapon</strong> for wood/combat, <strong>pick</strong> for mining (separate gather buttons for stone, iron ore, coal). If you don’t equip a pick, the best pick in your <strong>bag</strong> is used. Shields reduce damage. Durability drops from use; repair with a <strong>repair bench</strong>.</p>`;
    const slots = document.createElement('div');
    slots.className = 'equip-row';
    const weaponOpts = EQUIPPABLE_WEAPONS(s);
    const shieldOpts = EQUIPPABLE_SHIELDS(s);
    const pickOpts = EQUIPPABLE_PICKS(s);
    slots.innerHTML = `
      <div class="equip-slot equip-slot--plate"><span class="equip-slot-label">Weapon</span><div class="equip-current equip-current-readout">${s.equipment.weapon ? formatRes(s.equipment.weapon) : '—'}</div></div>
      <div class="equip-slot equip-slot--plate"><span class="equip-slot-label">Pick</span><div class="equip-current equip-current-readout">${s.equipment.pick ? formatRes(s.equipment.pick) : '— (bag auto)'}</div></div>
      <div class="equip-slot equip-slot--plate"><span class="equip-slot-label">Shield</span><div class="equip-current equip-current-readout">${s.equipment.shield ? formatRes(s.equipment.shield) : '—'}</div></div>
    `;
    eq.appendChild(slots);

    const btnRow = document.createElement('div');
    btnRow.className = 'equip-actions';
    weaponOpts.forEach((id) => {
      if ((s.inventory[id] ?? 0) < 1) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-equip-forge btn-equip-forge--weapon';
      b.innerHTML = `<span class="btn-equip-forge__verb">Equip</span><span class="btn-equip-forge__item">${formatRes(id)}</span><span class="btn-equip-forge__pct">${Math.round(store.getToolDurabilityPercent(id))}%</span>`;
      b.addEventListener('click', () => {
        store.equip('weapon', id);
        scenePreview.playEquipAdjust();
        renderPage();
      });
      btnRow.appendChild(b);
    });
    const uW = document.createElement('button');
    uW.type = 'button';
    uW.className = 'btn btn-equip-uneq';
    uW.innerHTML = `<span class="btn-equip-uneq__text">Unequip weapon</span>`;
    uW.addEventListener('click', () => {
      store.equip('weapon', null);
      scenePreview.playEquipAdjust();
      renderPage();
    });
    btnRow.appendChild(uW);

    pickOpts.forEach((id) => {
      if ((s.inventory[id] ?? 0) < 1) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-equip-forge btn-equip-forge--pick';
      b.innerHTML = `<span class="btn-equip-forge__verb">Equip</span><span class="btn-equip-forge__item">${formatRes(id)}</span><span class="btn-equip-forge__pct">${Math.round(store.getToolDurabilityPercent(id))}%</span>`;
      b.addEventListener('click', () => {
        store.equip('pick', id);
        scenePreview.playEquipAdjust();
        renderPage();
      });
      btnRow.appendChild(b);
    });
    const uP = document.createElement('button');
    uP.type = 'button';
    uP.className = 'btn btn-equip-uneq';
    uP.innerHTML = `<span class="btn-equip-uneq__text">Unequip pick · use bag</span>`;
    uP.addEventListener('click', () => {
      store.equip('pick', null);
      scenePreview.playEquipAdjust();
      renderPage();
    });
    btnRow.appendChild(uP);

    shieldOpts.forEach((id) => {
      if ((s.inventory[id] ?? 0) < 1) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-equip-forge btn-equip-forge--shield';
      b.innerHTML = `<span class="btn-equip-forge__verb">Equip</span><span class="btn-equip-forge__item">${formatRes(id)}</span><span class="btn-equip-forge__pct">${Math.round(store.getToolDurabilityPercent(id))}%</span>`;
      b.addEventListener('click', () => {
        store.equip('shield', id);
        scenePreview.playEquipAdjust();
        renderPage();
      });
      btnRow.appendChild(b);
    });
    const uS = document.createElement('button');
    uS.type = 'button';
    uS.className = 'btn btn-equip-uneq';
    uS.innerHTML = `<span class="btn-equip-uneq__text">Unequip shield</span>`;
    uS.addEventListener('click', () => {
      store.equip('shield', null);
      scenePreview.playEquipAdjust();
      renderPage();
    });
    btnRow.appendChild(uS);
    eq.appendChild(btnRow);
    el.appendChild(eq);

    const use = document.createElement('div');
    use.className = 'panel-block';
    use.innerHTML = `<h2>Use consumables</h2>`;
    const urow = document.createElement('div');
    urow.className = 'recipe-row';
    const eat = document.createElement('button');
    eat.className = 'btn btn-use-consume';
    eat.textContent = 'Eat rations (cooked meat ×1)';
    eat.disabled = (s.inventory.cooked_meat ?? 0) < 1;
    eat.addEventListener('click', () => {
      scenePreview.playEatCookedMeat();
      store.consumeFood('cooked_meat', 1);
      renderPage();
    });
    const berry = document.createElement('button');
    berry.className = 'btn btn-use-consume';
    berry.textContent = 'Snack berries ×1';
    berry.disabled = (s.inventory.berries ?? 0) < 1;
    berry.addEventListener('click', () => {
      scenePreview.playEatBerriesSnack();
      store.consumeFood('berries', 1);
      renderPage();
    });
    const drink = document.createElement('button');
    drink.className = 'btn btn-use-consume';
    drink.textContent = 'Drink water ×1';
    drink.disabled = (s.inventory.water ?? 0) < 1;
    drink.addEventListener('click', () => {
      scenePreview.playDrinkWater();
      store.drinkWater(1);
      renderPage();
    });
    urow.appendChild(eat);
    urow.appendChild(berry);
    urow.appendChild(drink);
    use.appendChild(urow);
    el.appendChild(use);

    const inv = document.createElement('div');
    inv.className = 'panel-block inv-all-panel';
    inv.innerHTML = `<h2 class="forge-section-title">All items</h2>`;
    const grid = document.createElement('div');
    grid.className = 'inv-grid inv-grid--all';
    const entries = Object.entries(s.inventory)
      .filter(([, v]) => v > 0.01)
      .sort((a, b) => a[0].localeCompare(b[0]));
    if (entries.length === 0) {
      grid.innerHTML = '<p class="inv-grid-empty">Nothing carried</p>';
    } else {
      for (const [k, v] of entries) {
        const cell = document.createElement('div');
        cell.className = 'inv-cell inv-cell--grid';
        cell.dataset.res = k;
        cell.dataset.invTone = invQuickTone(k);
        const dur =
          isDurabilityItemId(k) && (s.inventory[k] ?? 0) >= 1
            ? `<div class="inv-grid-dur"><div class="dur-bar"><div class="dur-fill" style="width:${store.getToolDurabilityPercent(k)}%"></div></div><span class="dur-txt">${Math.round(store.getToolDurabilityPercent(k))}%</span></div>`
            : '';
        cell.innerHTML = `<span class="inv-grid-name">${formatRes(k)}</span><span class="inv-grid-qty">${formatNum(v)}</span>${dur}`;
        grid.appendChild(cell);
      }
    }
    inv.appendChild(grid);
    bindInvQuickResourceHover(inv);
    el.appendChild(inv);

    const repair = document.createElement('div');
    repair.className = 'panel-block';
    const hasBench = (s.inventory.repair_bench ?? 0) >= 1;
    repair.innerHTML = `<h2>Repair (${hasBench ? 'bench ready' : 'craft a repair bench'})</h2>
      <p style="color:var(--muted);font-size:0.8rem">Costs 2 wood + 1 fiber per repair. Restores ~35 durability.</p>`;
    const rgrid = document.createElement('div');
    rgrid.className = 'gather-btns';
    for (const id of DURABILITY_KEYS) {
      if ((s.inventory[id] ?? 0) < 1) continue;
      const b = document.createElement('button');
      b.className = 'btn';
      b.disabled = !hasBench;
      b.textContent = `Repair ${formatRes(id)} (${Math.round(store.getToolDurabilityPercent(id))}%)`;
      b.addEventListener('click', () => {
        scenePreview.playRepairItem();
        store.repairItem(id);
        renderPage();
      });
      rgrid.appendChild(b);
    }
    repair.appendChild(rgrid);
    el.appendChild(repair);
  }

  function renderDecks(el: HTMLElement, s: ReturnType<GameStore['getState']>): void {
    /* Magic shortcut bar at the top of the Decks page — gives the player a one-glance
     * view of which spells they have equipped while they're browsing the magic tree
     * to craft new ones. Click a slot opens the picker modal (same UX as the awakened
     * hotbar). See the inventory render for the dispose-on-rerender pattern. */
    const isAwakenedOverlay = el === awakenedOverlayBodyEl;
    const handleKey = isAwakenedOverlay ? 'decksAwakened' : 'decksDeck';
    disposeShortcutBar(handleKey);
    shortcutBarHandles[handleKey] = mountShortcutBar(el, store, {
      modalHost: shell,
      helperText: 'Awakened-mode magic shortcuts. Click a slot to pick a spell, OR use the Equip buttons on each unlocked card below.',
    });

    const trees: DeckTree[] = ['building', 'survival', 'combat', 'magic'];
    for (const tree of trees) {
      const block = document.createElement('div');
      block.className = 'panel-block';
      if (tree === 'building') block.dataset.tutorialDecksAnchor = '';
      const magicIntro =
        tree === 'magic'
          ? `<p style="color:var(--muted);font-size:0.8rem;margin:0 0 0.65rem">Open with <strong>Wild awakening</strong> (after campfire). You start weak — stack <strong>dust</strong> via idle lines + Gather → <strong>Channel residue</strong>, and grow <strong>mana</strong> (cards add pool + regen). Tiers: bolts & wards → reservoir → arc / mend → aegis. Combat spells auto-join PvE.</p>`
          : '';
      block.innerHTML = `<h2>${TREE_LABEL[tree]}</h2>${magicIntro}`;
      const grid = document.createElement('div');
      grid.className = 'card-grid';
      const deckCards = allCards
        .filter((x) => x.tree === tree)
        .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
      for (const c of deckCards) {
        const owned = s.unlockedCardIds.includes(c.id);
        const can = store.canUnlockCard(c.id);
        const tile = document.createElement('div');
        tile.className = 'card-tile';
        const unlocks =
          c.unlocksRecipes && c.unlocksRecipes.length > 0
            ? `<div style="font-size:0.72rem;color:var(--accent2);margin-top:0.35rem">Unlocks craft: ${c.unlocksRecipes.map((id) => allRecipes.find((r) => r.id === id)?.name ?? id).join(', ')}</div>`
            : '';
        const mm = c.maxManaBonus ?? 0;
        const mr = c.manaRegenBonus ?? 0;
        const magicPass =
          c.tree === 'magic' && (mm > 0 || mr > 0)
            ? `<div style="font-size:0.7rem;color:var(--magic);margin-top:0.3rem">Mana passives:${mm > 0 ? ` +${mm} max` : ''}${
                mr > 0 ? ` +${mr.toFixed(3)}/s regen` : ''
              }</div>`
            : '';
        const magicAuto =
          c.tree === 'magic' && c.automation
            ? `<div style="font-size:0.7rem;color:var(--magic);margin-top:0.25rem">Idle: magic dust (slot in Automation)</div>`
            : '';
        const bt = c.battle;
        const magicBattle =
          c.tree === 'magic' && bt
            ? `<div style="font-size:0.7rem;color:var(--magic);margin-top:0.3rem">PvE · ${bt.energyCost}⚡${bt.manaCost != null ? ` ${bt.manaCost} mana` : ''}${
                bt.damage ? ` · ${bt.damage} dmg` : ''
              }${bt.heal ? ` · +${bt.heal} HP` : ''}${bt.wardFlat ? ` · ward +${bt.wardFlat}` : ''}</div>`
            : '';
        tile.innerHTML = `
          <span class="tag ${tree}">${c.tree === 'magic' ? `T${c.tier} · ` : ''}${tree}</span>
          <h3>${c.name}</h3>
          <p>${c.description}</p>
          ${formatCardUnlockHtml(c)}
          ${magicPass}${magicAuto}${magicBattle}
          ${unlocks}
        `;
        if (owned) {
          const ok = document.createElement('span');
          ok.style.color = 'var(--success)';
          ok.textContent = 'Unlocked';
          tile.appendChild(ok);
          /* Equip-as-shortcut buttons for unlocked spell cards. Shows "Equip as
           * offensive" when the card has positive `damage`, and/or "Equip as
           * defensive" when it has positive `wardFlat`. Some spells could appear in
           * both lists (a hypothetical heal-and-ward card) — both buttons render so
           * the player picks. PASSIVE cards (no `battle` field, just `maxManaBonus`
           * / `manaRegenBonus` / `automation` etc.) DON'T get equip buttons —
           * they're auto-applied at unlock and don't take a shortcut slot. */
          const isOffenseSpell = bt?.attackStyle === 'spell'
            && typeof bt.damage === 'number' && bt.damage > 0;
          const isDefenseSpell = bt?.attackStyle === 'spell'
            && typeof bt.wardFlat === 'number' && bt.wardFlat > 0;
          if (isOffenseSpell || isDefenseSpell) {
            const equipRow = document.createElement('div');
            equipRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px';
            if (isOffenseSpell) {
              const isEquipped = s.equippedOffensiveSpellId === c.id;
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'btn';
              btn.style.cssText = 'font-size:0.78rem;padding:4px 10px';
              btn.textContent = isEquipped ? 'Equipped — offense' : 'Equip as offensive';
              btn.disabled = isEquipped;
              btn.addEventListener('click', () => {
                store.equipOffensiveSpell(c.id);
                renderPage();
              });
              equipRow.appendChild(btn);
            }
            if (isDefenseSpell) {
              const isEquipped = s.equippedDefensiveSpellId === c.id;
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'btn';
              btn.style.cssText = 'font-size:0.78rem;padding:4px 10px';
              btn.textContent = isEquipped ? 'Equipped — defense' : 'Equip as defensive';
              btn.disabled = isEquipped;
              btn.addEventListener('click', () => {
                store.equipDefensiveSpell(c.id);
                renderPage();
              });
              equipRow.appendChild(btn);
            }
            tile.appendChild(equipRow);
          }
        } else {
          const btn = document.createElement('button');
          btn.className = 'btn';
          btn.textContent = can ? 'Unlock' : 'Requirements not met';
          btn.disabled = !can;
          btn.addEventListener('click', () => {
            store.unlockCard(c.id);
            scenePreview.playDeckUnlock();
            renderPage();
          });
          tile.appendChild(btn);
        }
        grid.appendChild(tile);
      }
      block.appendChild(grid);
      el.appendChild(block);
    }
  }

  function renderIdle(el: HTMLElement, s: ReturnType<GameStore['getState']>): void {
    const block = document.createElement('div');
    block.className = 'panel-block';
    const idleM = store.getIdleAutomationMult().toFixed(2);
    const cap = store.getIdleSlotCapacity();
    block.innerHTML = `<h2>Automation slots</h2>
      <p style="color:var(--muted);font-size:0.85rem">Slot cards with automation. Hired helpers add together toward one idle multiplier (cap +190%) — currently <strong>×${idleM}</strong> on all slotted lines. Many helpers also passively gather resources every second.</p>
      <p style="color:var(--muted);font-size:0.82rem;margin-top:0.35rem">Slots: <strong>${cap.used}</strong> / ${cap.max} · Spend coin to unlock more (up to ${IDLE_SLOT_MAX}).</p>`;
    const slots = document.createElement('div');
    slots.className = 'idle-slots';
    slots.dataset.tutorialIdleSlots = '';
    const autoCards = allCards.filter((c) => c.automation && s.unlockedCardIds.includes(c.id));
    for (let i = 0; i < s.idleSlots.length; i++) {
      const slot = document.createElement('div');
      const id = s.idleSlots[i];
      slot.className = 'idle-slot' + (id ? ' filled' : '');
      slot.innerHTML = id
        ? `<strong>${cardById.get(id)?.name ?? id}</strong><br/><span style="font-size:0.7rem">click to clear</span>`
        : `Slot ${i + 1}<br/><span style="font-size:0.7rem">empty</span>`;
      slot.addEventListener('click', () => {
        if (id) {
          store.setIdleSlot(i, null);
          renderPage();
        }
      });
      slots.appendChild(slot);
    }
    block.appendChild(slots);

    const unlockRow = document.createElement('div');
    unlockRow.className = 'idle-unlock-row';
    const nextCost = store.nextIdleSlotUnlockCost();
    if (nextCost != null) {
      const can = store.canUnlockIdleSlot();
      const ub = document.createElement('button');
      ub.className = 'btn';
      ub.type = 'button';
      ub.textContent = `Unlock next slot (${nextCost} coin)`;
      ub.disabled = !can;
      ub.title = can ? 'Adds one empty automation slot' : `Need ${nextCost} coin (you have ${s.currency})`;
      ub.addEventListener('click', () => {
        if (store.unlockIdleSlot()) renderPage();
      });
      unlockRow.appendChild(ub);
      if (!can && s.currency < nextCost) {
        const hint = document.createElement('span');
        hint.className = 'idle-unlock-hint';
        hint.textContent = ` You have ${s.currency} coin.`;
        unlockRow.appendChild(hint);
      }
    } else {
      const done = document.createElement('span');
      done.className = 'idle-unlock-hint';
      done.textContent = 'All automation slots unlocked.';
      unlockRow.appendChild(done);
    }
    block.appendChild(unlockRow);

    const pick = document.createElement('div');
    pick.className = 'idle-assign-section';
    const freeIx = s.idleSlots.findIndex((x) => x === null);
    pick.innerHTML =
      '<h3 class="idle-assign-heading">Assign to first free slot</h3><p class="idle-assign-lead">Each card includes its description and passive rates (before helper ×).</p>';

    const list = document.createElement('div');
    list.className = 'idle-assign-list';

    if (autoCards.length === 0) {
      list.innerHTML = '<span style="color:var(--muted)">No automation cards unlocked.</span>';
    } else {
      for (const c of autoCards) {
        const row = document.createElement('div');
        row.className = 'idle-assign-row';
        const rates = formatAutomationRates(c);
        const h = document.createElement('h4');
        h.textContent = c.name;
        const desc = document.createElement('p');
        desc.className = 'desc';
        desc.textContent = c.description;
        const rateEl = document.createElement('p');
        rateEl.className = 'rates';
        rateEl.textContent = rates || 'Automation';
        const b = document.createElement('button');
        b.className = 'btn';
        b.type = 'button';
        b.textContent = freeIx >= 0 ? 'Assign to first free slot' : 'All slots full';
        b.disabled = freeIx < 0;
        b.addEventListener('click', () => {
          const idx = store.getState().idleSlots.findIndex((x) => x === null);
          if (idx >= 0) store.setIdleSlot(idx, c.id);
          renderPage();
        });
        if (c.id === 'c_idle_windfall') b.dataset.tutorialWindfall = '';
        row.appendChild(h);
        row.appendChild(desc);
        row.appendChild(rateEl);
        row.appendChild(b);
        list.appendChild(row);
      }
    }
    pick.appendChild(list);
    block.appendChild(pick);
    el.appendChild(block);
  }

  function renderBattle(el: HTMLElement, s: ReturnType<GameStore['getState']>): void {
    const b = s.battle;
    const block = document.createElement('div');
    block.className = 'panel-block';

    if (!b) {
      block.dataset.tutorialBattleLobby = '';
      const bd = store.getBattleHelperDamageBonus();
      const bb = store.getBattleHelperBlockBonus();
      const assist =
        bd > 0 || bb > 0
          ? ` Hired battle helpers: <strong>+${bd}</strong> damage on fist/weapon hits, <strong>−${bb}</strong> from enemy swings before armor.`
          : ' Hire battle companions on the Hire tab for flat damage and block.';
      const onlineBattle =
        s.onlineSession && s.gameMode === 'coop'
          ? ' <strong>Co-op run:</strong> shared camp stash syncs through the lobby server; PvE encounters use the room seed.'
          : s.onlineSession && s.gameMode === 'pvp'
            ? ' <strong>Hunter duel:</strong> real PvP — your rival is another player from the room. The dock shows both survivors. Lose the duel and you wipe this run (stay in lobby or leave from the defeat modal / chat).'
            : s.onlineSession && s.gameMode === 'deathmatch'
              ? ' <strong>3v3 bracket:</strong> you duel an assigned rival from the other team. If you are eliminated you sit out until a new match.'
              : '';
      const battleH2 =
        s.onlineSession && s.gameMode === 'pvp'
          ? 'Hunter duel — battle dock'
          : s.onlineSession && s.gameMode === 'deathmatch'
            ? '3v3 bracket — battle dock'
            : 'Turn-based PvE';
      const pvpOnline =
        s.onlineSession && (s.gameMode === 'pvp' || s.gameMode === 'deathmatch');
      const scaleNote = pvpOnline
        ? '<p style="color:var(--muted);font-size:0.82rem;margin:0.35rem 0 0.75rem">Bracket wins: <strong>' +
          s.pveWave +
          '</strong>.</p>'
        : '<p style="color:var(--muted);font-size:0.82rem;margin:0.35rem 0 0.75rem">Victories: <strong>' +
          s.pveWave +
          '</strong> — each win scales up the next enemy.</p>';
      block.innerHTML = `<h2>${battleH2}</h2>
        <p style="color:var(--muted);font-size:0.88rem"><strong>0 HP = permadeath</strong> — full run wipe. Hunger and thirst also kill you in the world. HP carries from the HUD. Equip axe or iron sword for bonus damage; shield reduces hits and loses durability.${assist}${onlineBattle}</p>
        ${scaleNote}`;
      if (pvpOnline) {
        if (store.getOnlineSelfEliminated()) {
          const p = document.createElement('p');
          p.style.cssText = 'color:var(--danger);font-size:0.88rem';
          p.textContent =
            'You are eliminated from the current bracket. Wait for your party to finish or start a new lobby.';
          block.appendChild(p);
          el.appendChild(block);
          return;
        }
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;flex-wrap:wrap;gap:0.5rem;margin-top:0.5rem';
        const propose = document.createElement('button');
        propose.className = 'btn';
        propose.type = 'button';
        propose.textContent =
          s.gameMode === 'deathmatch' ? 'Propose bracket vote' : 'Invite to Hunter duel';
        propose.addEventListener('click', () => {
          if (s.gameMode === 'pvp') {
            const you = store.getYourRoomSessionId();
            const other = store.getLastRoomPlayers().find((p) => p.sessionId !== you);
            if (!other) return;
            getRoomHub().pvpProposeBattle({ targetSessionId: other.sessionId });
          } else {
            getRoomHub().pvpProposeBattle();
          }
        });
        const start = document.createElement('button');
        start.className = 'btn btn-primary';
        start.type = 'button';
        start.textContent = 'Enter duel';
        const rival = s.onlineSession?.pvpRival;
        start.disabled = !rival;
        start.title = rival
          ? `Face ${rival.displayName} (${rival.maxHp} HP).`
          : 'Vote to engage first — then the server pairs you with a rival.';
        start.addEventListener('click', () => {
          if (store.startPveBattle()) renderPage();
        });
        row.appendChild(propose);
        row.appendChild(start);
        block.appendChild(row);
        el.appendChild(block);
        return;
      }
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = 'Start encounter';
      btn.addEventListener('click', () => {
        store.startPveBattle();
        renderPage();
      });
      block.appendChild(btn);
      el.appendChild(block);
      return;
    }

    block.dataset.tutorialBattleCombat = '';

    const hbD = store.getBattleHelperDamageBonus();
    const hbB = store.getBattleHelperBlockBonus();
    const hbLine =
      hbD > 0 || hbB > 0
        ? `<span>Helpers: <strong>+${hbD}</strong> dmg · <strong>−${hbB}</strong> block</span>`
        : '';

    block.innerHTML = `<h2>Combat</h2>
      <p class="battle-vitals-hint" style="font-size:0.78rem;color:var(--muted);margin:0 0 0.5rem;line-height:1.35">These meters are your <strong>real</strong> camp stats (same as the top bar). Hunger and thirst keep falling during the fight — at zero you die. Damage reduces the same HP pool.</p>
      <div class="hud-row battle-vitals-row" style="margin-bottom:0.65rem">
        ${bar('HP', (s.playerHp / s.playerMaxHp) * 100, 'hp')}
        ${bar('MANA', (s.mana / Math.max(1, store.getEffectiveMaxMana())) * 100, 'mana')}
        ${bar('HUNGER', s.hunger, 'hunger')}
        ${bar('THIRST', s.thirst, 'thirst')}
      </div>
      <div class="stat-row">
        <span>Energy: <strong>${b.playerEnergy}</strong> / ${b.playerMaxEnergy}</span>
        <span>${b.enemy.name}: <strong>${Math.ceil(b.enemyHp)}</strong> / ${b.enemy.maxHp} HP</span>
        <span>Wins: <strong>${s.pveWave}</strong></span>
        ${(b.spellWard ?? 0) > 0.01 ? `<span>Ward: <strong>${Math.ceil(b.spellWard ?? 0)}</strong></span>` : ''}
        ${hbLine}
      </div>`;

    const log = document.createElement('div');
    log.className = 'battle-log';
    log.innerHTML = b.log.map((l) => `<div>${l}</div>`).join('');
    block.appendChild(log);

    if (b.turn === 'player') {
      const row = document.createElement('div');
      row.style.marginTop = '0.5rem';
      store.sortCombatDeckDisplayOrder(s.combatDeck).forEach((cid) => {
        const c = cardById.get(cid);
        if (!c?.battle) return;
        const btn = document.createElement('button');
        btn.className = 'btn';
        const mc = c.battle.manaCost ?? 0;
        const costLbl =
          mc > 0 ? `${c.battle.energyCost}⚡ ${mc} mana` : `${c.battle.energyCost}⚡`;
        btn.textContent = `${c.name} (${costLbl})`;
        btn.addEventListener('click', () => {
          const b0 = store.getState().battle;
          const prevEnemyHp = b0?.enemyHp;
          scenePreview.playBattleAction(cid);
          store.battlePlayCard(cid);
          const b1 = store.getState().battle;
          if (
            prevEnemyHp != null &&
            b1 &&
            prevEnemyHp > b1.enemyHp
          ) {
            scenePreview.showDamageFloater(`−${Math.round(prevEnemyHp - b1.enemyHp)}`, 'enemy');
          }
          if (b1?.turn === 'victory') {
            scenePreview.queueBattleEnemyDeathAfterKill();
          }
          renderPage();
        });
        row.appendChild(btn);
        row.appendChild(document.createTextNode(' '));
      });
      block.appendChild(row);
      const medRow = document.createElement('div');
      medRow.className = 'battle-med-row';
      medRow.style.cssText = 'margin-top:0.55rem;display:flex;flex-wrap:wrap;gap:0.35rem;align-items:center';
      const medLab = document.createElement('span');
      medLab.style.cssText = 'font-size:0.8rem;color:var(--muted)';
      medLab.textContent = 'Med kit (uses turn):';
      medRow.appendChild(medLab);
      const bandN = Math.floor(s.inventory.bandage ?? 0);
      const stimN = Math.floor(s.inventory.stim ?? 0);
      const bandBtn = document.createElement('button');
      bandBtn.className = 'btn';
      bandBtn.type = 'button';
      bandBtn.textContent = `Bandage +${BATTLE_HEAL_BANDAGE} HP (×${bandN})`;
      bandBtn.disabled = bandN < 1;
      bandBtn.addEventListener('click', () => {
        scenePreview.playBandage();
        store.battleUseBandage();
        renderPage();
      });
      medRow.appendChild(bandBtn);
      const stimBtn = document.createElement('button');
      stimBtn.className = 'btn';
      stimBtn.type = 'button';
      stimBtn.textContent = `Stim +${BATTLE_HEAL_STIM} HP (×${stimN})`;
      stimBtn.disabled = stimN < 1;
      stimBtn.addEventListener('click', () => {
        scenePreview.playStim();
        store.battleUseStim();
        renderPage();
      });
      medRow.appendChild(stimBtn);
      block.appendChild(medRow);
    } else if (b.turn === 'enemy') {
      if (b.mode === 'pvp') {
        const wait = document.createElement('p');
        wait.className = 'battle-pvp-wait';
        wait.style.cssText = 'font-size:0.88rem;color:var(--muted);margin:0.5rem 0 0';
        wait.textContent =
          'Rival’s turn — when they play a card, their strike appears here and your hand unlocks.';
        block.appendChild(wait);
      } else {
        const btn = document.createElement('button');
        btn.className = 'btn btn-primary';
        btn.textContent = 'End turn (enemy acts)';
        btn.addEventListener('click', () => {
          const php = store.getState().playerHp;
          scenePreview.playBattleEnemyStrike();
          store.battleEndTurn();
          const n = store.getState();
          if (php > n.playerHp) {
            scenePreview.showDamageFloater(`−${Math.round(php - n.playerHp)}`, 'player');
          }
          renderPage();
        });
        block.appendChild(btn);
      }
    } else if (b.turn === 'defeat') {
      const note = document.createElement('p');
      note.style.cssText = 'font-size:0.8rem;color:var(--muted);margin:0.5rem 0';
      note.textContent =
        'You fall. The dock plays your defeat — then the run resets (permadeath).';
      block.appendChild(note);
      requestAnimationFrame(() => {
        scenePreview.playBattlePlayerDeath();
      });
    } else {
      const note = document.createElement('p');
      note.style.cssText = 'font-size:0.8rem;color:var(--muted);margin:0.5rem 0';
      note.textContent = 'Take your rewards and return to the world.';
      block.appendChild(note);
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = 'Leave';
      btn.addEventListener('click', () => {
        store.battleClose();
        renderPage();
      });
      block.appendChild(btn);
    }
    el.appendChild(block);
  }

  function fmtResKey(k: string): string {
    return k.replace(/_/g, ' ');
  }

  function helperIdleSlicePercent(h: HelperDef): number {
    const b = h.idleBonus ?? Math.max(0, h.speedMult - 1);
    return Math.round(b * 100);
  }

  function buildHelperCard(h: HelperDef, s: ReturnType<GameStore['getState']>): HTMLElement {
    const hired = s.hiredHelperIds.includes(h.id);
    const card = document.createElement('div');
    card.className = 'helper-card' + (hired ? ' helper-card--hired' : '');
    const passive = h.passiveGather
      ? Object.entries(h.passiveGather)
          .map(([k, v]) => `+${v}/s ${fmtResKey(k)}`)
          .join(' · ')
      : '—';
    const upkeep = h.upkeepPerMinute
      ? Object.entries(h.upkeepPerMinute)
          .map(([k, v]) => `${v}/min ${fmtResKey(k)}`)
          .join(' · ')
      : '—';
    const bat = h.battleAssist;
    const battleLine =
      bat && (bat.damageBonus || bat.blockBonus)
        ? [
            bat.damageBonus ? `+${bat.damageBonus} dmg (fist/weapon)` : null,
            bat.blockBonus ? `−${bat.blockBonus} enemy hit` : null,
          ]
            .filter(Boolean)
            .join(' · ')
        : '—';
    const fp = h.feedPlayer;
    const feedLine =
      fp && ((fp.hungerPerMinute ?? 0) > 0 || (fp.thirstPerMinute ?? 0) > 0)
        ? `${fp.hungerPerMinute ?? 0} hunger · ${fp.thirstPerMinute ?? 0} thirst / min (from stockpile)`
        : '—';
    const reqReason = store.getHireBlockReason(h.id);
    const needNote =
      !hired && reqReason && reqReason !== 'Already hired'
        ? `<div class="helper-card-req">${reqReason}</div>`
        : '';

    card.innerHTML = `
      <div class="helper-card-head">
        <strong>${h.name}</strong>
        <span class="helper-card-cost">${h.hireCost} ¤</span>
      </div>
      <p class="helper-card-desc">${h.description}</p>
      <dl class="helper-card-stats">
        <div><dt>Idle slice</dt><dd>+${helperIdleSlicePercent(h)}% (stacks toward ×, capped)</dd></div>
        <div><dt>Feeds you</dt><dd>${feedLine}</dd></div>
        <div><dt>Passive gather</dt><dd>${passive}</dd></div>
        <div><dt>Diet</dt><dd>${h.foodPerMinute} cooked meat / min (else 2× berries)</dd></div>
        <div><dt>Upkeep</dt><dd>${upkeep}</dd></div>
        <div><dt>PvE assist</dt><dd>${battleLine}</dd></div>
      </dl>
      ${needNote}
    `;
    const row = document.createElement('div');
    row.className = 'helper-card-actions';
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = hired ? 'Hired' : `Hire — ${h.hireCost} ¤`;
    btn.disabled = hired || !store.canHireHelper(h.id);
    btn.addEventListener('click', () => {
      store.hireHelper(h.id);
      scenePreview.playHireWave();
      renderPage();
    });
    row.appendChild(btn);
    card.appendChild(row);
    return card;
  }

  function renderHire(el: HTMLElement, s: ReturnType<GameStore['getState']>): void {
    const intro = document.createElement('div');
    intro.className = 'panel-block';
    intro.dataset.tutorialHireAnchor = '';
    intro.innerHTML = `<h2>Hire helpers — full roster</h2>
      <p style="color:var(--muted);font-size:0.88rem"><strong>Permadeath:</strong> reach 0 hunger, 0 thirst, or 0 HP (including in battle) and you <strong>lose the entire run</strong> — fresh start. Each hire adds an <strong>idle slice</strong> (capped). Many add <strong>passive /s</strong> resources. <strong>Feeds you</strong> from inventory at the listed hunger/thirst per minute (meat first, then berries; water for thirst). They also eat their own upkeep. Battle helpers add damage/block in PvE.</p>`;
    el.appendChild(intro);

    const byRole = new Map<HelperRole, HelperDef[]>();
    for (const r of HELPER_ROLE_ORDER) byRole.set(r, []);
    for (const h of allHelpers) {
      byRole.get(h.role)?.push(h);
    }

    for (const role of HELPER_ROLE_ORDER) {
      const list = byRole.get(role) ?? [];
      if (list.length === 0) continue;
      const section = document.createElement('div');
      section.className = 'panel-block helper-role-section';
      section.innerHTML = `<h3 class="helper-role-title">${HELPER_ROLE_TITLE[role]}</h3>
        <p class="helper-role-blurb">${HELPER_ROLE_BLURB[role]}</p>`;
      const roster = document.createElement('div');
      roster.className = 'helper-roster';
      for (const h of list) {
        roster.appendChild(buildHelperCard(h, s));
      }
      section.appendChild(roster);
      el.appendChild(section);
    }
  }

  window.addEventListener('battle-player-death-done', () => {
    store.finishBattlePermadeath();
    scenePreview.resetDockAfterPermadeath();
    renderPage();
    scenePreview.relevelAvatarFeetAfterEquipmentSync();
  });

  window.addEventListener('pvp-incoming-hit', ((ev: Event) => {
    const d = (ev as CustomEvent<{ damage: number }>).detail;
    scenePreview.playBattleEnemyStrike();
    if (d?.damage) scenePreview.showDamageFloater(`−${Math.round(d.damage)}`, 'player');
  }) as EventListener);

  window.addEventListener('pvp-remote-victory', () => {
    scenePreview.queueBattleEnemyDeathAfterKill();
  });

  window.addEventListener('pvp-arena-strike', ((ev: Event) => {
    const d = (ev as CustomEvent<{
      fromSessionId: string;
      toSessionId: string;
      damage: number;
      cardName: string;
    }>).detail;
    if (!d) return;
    const st = store.getState();
    const b = st.battle;
    const you = store.getYourRoomSessionId();
    if (!you || !b || b.mode !== 'pvp') return;
    if (d.fromSessionId === you) return;
    const rival = b.rivalSessionId;
    if (d.fromSessionId === rival) {
      scenePreview.playBattleEnemyStrike();
    }
    if (d.toSessionId === rival && d.damage > 0) {
      scenePreview.showDamageFloater(`−${Math.round(d.damage)}`, 'enemy');
    }
  }) as EventListener);

  store.subscribe(() => {
    refreshHud();
    syncPvpVoteOverlay();
    refreshVoicePeers();
    /* getStateRef = no-clone read. This subscriber fires on EVERY store
     * emit (every gather tick, every currency grant, every battle action,
     * etc.) — tens to hundreds per second during active play. The
     * original `getState()` was paying a 1-10 ms JSON deep-clone tax per
     * emit, which is the main FPS killer during high-activity moments
     * like battle + idle automation running together. The merchant /
     * harvest / inventory / rpg sigs and the renderPage decisions only
     * READ from `st`; never mutate. */
    const st = store.getStateRef();
    const b = st.battle;
    let didFullBattleRender = false;
    if (page === 'battle' && b?.mode === 'pvp') {
      const sig = [
        b.turn,
        b.turnNumber,
        b.log.length,
        Math.round(b.enemyHp * 10) / 10,
        Math.round(st.playerHp * 10) / 10,
        b.playerEnergy,
        b.spellWard ?? 0,
      ].join('|');
      if (sig !== lastOnlinePvpBattleSig) {
        lastOnlinePvpBattleSig = sig;
        renderPage();
        didFullBattleRender = true;
      }
    } else {
      lastOnlinePvpBattleSig = '';
    }
    /* Active-gather state changed → refresh gather buttons (cheap; no-op off the gather page).
     * This also flips the .gather-action-btn--locked / .gather-page-layout[data-gather-busy]
     * state when the in-flight gather completes via tick → performGather → emit. */
    const ag = store.getActiveGather();
    const agSig = ag ? `${ag.actionId}` : '';
    if (agSig !== lastActiveGatherSig) {
      lastActiveGatherSig = agSig;
      refreshGatherActionButtons();
    }
    if (page === 'gather') {
      const mSig = merchantGatherSig(st);
      if (mSig !== lastMerchantGatherSig) {
        lastMerchantGatherSig = mSig;
        renderPage();
      } else {
        const hSig = harvestPatchesSig(st);
        if (hSig !== lastGatherHarvestSig) {
          lastGatherHarvestSig = hSig;
          refreshGatherActionButtons();
        }
        /* Quick-inventory panel on the gather page reflects the latest store state any time
         * inventory shape changes (covers the in-flight gather completing on this tab). */
        const invSig = inventoryPageSig(st);
        if (invSig !== lastInventoryPageSig) {
          lastInventoryPageSig = invSig;
          refreshGatherInv(st);
        }
      }
    } else if (page === 'inventory' || page === 'craft' || page === 'idle' || page === 'hire') {
      /* If a mid-gather grant landed while the player is on a different tab, re-render so
       * the inventory / cost columns stay in sync. Without this, the inventory tab would
       * show stale state until the player manually switched tabs and back. */
      const invSig = inventoryPageSig(st);
      if (invSig !== lastInventoryPageSig) {
        lastInventoryPageSig = invSig;
        renderPage();
      }
    } else if (page === 'awakening') {
      /* Awakening page reads shards / realm / witch-counter from store; re-render on any
       * emit since the shape change set is small (3 booleans + counter + realm flip). */
      renderPage();
    } else {
      lastInventoryPageSig = inventoryPageSig(st);
    }
    if (page === 'rpg') {
      const rSig = rpgPanelSig(st);
      if (rSig !== lastRpgPanelSig) {
        lastRpgPanelSig = rSig;
        renderPage();
      }
    } else {
      lastRpgPanelSig = '';
    }
    if (!didFullBattleRender) applyOnlineCharacterDockVisuals();
    /* Realm-mode side effects — both safe to run every emit (cheap idempotent ops).
     *
     * `ensureFreeRoamMatchesRealm` is GATED by `dockHandlesAdoptedOrConfirmedUnavailable`
     * so it can't fire `ensureDockForestAttached` before mountApp's adoption block
     * has had a chance to slot the prebuilt handles into the local vars. Without
     * the gate, a fast realm-flip emit during mountApp body would build a
     * duplicate dock-forest BatchedMesh (orphaning the prebuilt one). See the
     * gate flag's doc comment. */
    if (dockHandlesAdoptedOrConfirmedUnavailable) {
      ensureFreeRoamMatchesRealm();
    } else {
      realmMatchDeferred = true;
    }
    applyRealmModeToNav();
    /* If the awakened panel is showing a deck page, re-render the BODY only on every
     * emit — chrome (header / back / X) stays in place so focus, scroll, and event
     * listeners on those elements aren't blown away. Cheap update, parallel to deck-mode's
     * `renderPage()` keeping pageRoot in sync. */
    if (awakenedOverlayEl && awakenedPanelView !== 'menu') {
      renderAwakenedPanelBody(awakenedPanelView);
    }
  });

  /**
   * Cheap "near water" check — samples a ring around `(ax, az)` and returns true if any
   * sample hits water. The dock's `isWaterAt` only returns true when standing literally
   * ON the creek polyline; players need to be ABLE to stand on the bank and harvest.
   * 4 samples × 0.6u radius is plenty for the bucket-filling UX without false positives.
   */
  function isNearWater(isWaterAt: (x: number, z: number) => boolean, ax: number, az: number): boolean {
    const R = 0.6;
    return (
      isWaterAt(ax + R, az) ||
      isWaterAt(ax - R, az) ||
      isWaterAt(ax, az + R) ||
      isWaterAt(ax, az - R)
    );
  }

  /* ---------- Phase D — free-roam harvest nodes (always present, gated visibility) ---------- */
  /* Scattered metals + crystals across the heightfield. Always exists in scene; visibility
   * + harvestability gate on (realm mode, deck unlock cards, dev flag). The node
   * geometry uses the same `getTerrainHeight` sampler the avatar uses, so nodes always
   * sit on the terrain regardless of any future heightfield retune.
   *
   * Performance contract (`docs/AWAKENING_AND_FREE_ROAM_PLAN.md` §9): the entire scatter
   * — wood + fiber + stone + berries + 7 metal tiers — ships in ~25-35 draw calls thanks
   * to per-kind cross-instance `mergeByMaterial` inside `attachFreeRoamHarvestNodes`. To
   * keep the per-frame cost equally tight here, we (1) cache the FreeRoamHandles object
   * so we don't re-read `scenePreview.getFreeRoamHandles()` every frame, (2) call
   * `setVisibilityRules` ONLY when the store emits a relevant change (not per-frame),
   * and (3) skip the prompt scan entirely in deck mode. */
  let harvestHandle: FreeRoamHarvestHandle | null = null;
  /* === 2026-04-20 ghost-mesh order-of-operations gate ===
   *
   * `false` until the extended-preload adoption block (line ~4350) has
   * either successfully adopted the prebuilt handles OR confirmed the
   * preload was unavailable / failed. Used to GATE every call to
   * `ensureFreeRoamMatchesRealm` (which can call `ensureDockForestAttached`
   * + similar inline-attach paths) so they don't fire BEFORE the prebuilt
   * handles have been adopted into mountApp's local handle vars.
   *
   * Without this gate, a store emit during mountApp's body (between the
   * subscriber registration at line ~2394 and the adoption at line ~4350)
   * would fire the subscriber → ensureFreeRoamMatchesRealm → if awakened
   * → ensureDockForestAttached → guard sees `dockForestHandle == null`
   * (because adoption hasn't run yet) → builds inline → DUPLICATE attach.
   * The prebuilt's BatchedMesh stays in the scene as an orphan after
   * adoption overwrites the local handle ref → ghost meshes the player
   * can walk through during harvest. */
  let dockHandlesAdoptedOrConfirmedUnavailable = false;
  /** True once `ensureFreeRoamMatchesRealm` was deferred at least once because
   * the gate was closed. After adoption opens the gate, the listener fires
   * a "catch-up" call so the deferred state change is applied. */
  let realmMatchDeferred = false;
  /**
   * Awakened-mode base building (Phase 1 — see `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md`).
   * `cabinHandle` renders all `state.placedCabinPieces` via per-(kind,tier) InstancedMesh
   * buckets. `buildModeCtl` owns the ghost-preview placement UX (R/wheel rotate, E
   * confirm, Esc cancel — wired through `freeRoamControls`). Both attach lazily after
   * the dock scene is ready.
   */
  let cabinHandle: CabinBuildHandle | null = null;
  let buildModeCtl: BuildModeController | null = null;
  /**
   * Awakened-mode multi-instance craft-station placement (Phase 2 — see
   * `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md` §9). `craftStationHandle` renders
   * all `state.placedCraftStations` as one Group per placed entry (campfire
   * needs per-instance flame `tick()`). `stationBuildModeCtl` is the sibling of
   * `buildModeCtl` for stations — same R/wheel/Esc/LMB UX, simpler snap (grid
   * only). Both lazy-attach in the same path as the cabin handles.
   *
   * Dream-mode is unaffected — the dock-yard campfire / workbench in
   * `characterScenePreview` keep their fixed slot positions; the new system is
   * gated to awakened-mode placement only.
   */
  let craftStationHandle: CraftStationBuildHandle | null = null;
  let stationBuildModeCtl: StationBuildModeController | null = null;
  /**
   * Phase 1.5 systems (camera-lock + combat + lock-on + collision + mob waves +
   * projectiles). All lazy-attached after the scene preview is ready, same pattern as
   * the other free-roam handles. See `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md` §12+§13.
   */
  let collisionWorld: CollisionWorldHandle | null = null;
  let cameraLockCtl: CameraLockHandle | null = null;
  let mobsHandle: AwakenedMobsHandle | null = null;
  let projectilesHandle: MagicProjectilesHandle | null = null;
  let bouncyMushroomsHandle: AwakenedBouncyMushroomsHandle | null = null;
  let lockOnCtl: LockOnHandle | null = null;
  /**
   * When the visible dock is worker-rendered, `setCameraYawPitch` is a postMessage — not
   * synchronous like `CharacterScenePreview`. `lockOn` and `cameraLock` both read/write
   * orbit in one frame; without this scratch, `cameraLock` re-reads a stale SAB and
   * overwrites the lock-on lerp whenever the mouse moves (jerky / snapping). Each frame
   * we copy SAB → scratch, both controllers mutate `scratch` only, then we send at most
   * one `setCameraYawPitch` if yaw/pitch changed.
   */
  const workerDockOrbitFrame = { yaw: 0, pitch: 0 };
  let combatHandle: AwakenedCombatHandle | null = null;
  let damageFloatersHandle: DamageFloatersHandle | null = null;
  let magicalReticleHandle: MagicalReticleHandle | null = null;
  let defensiveWardHandle: DefensiveWardHandle | null = null;
  let cachedFreeRoamHandles: ReturnType<typeof scenePreview.getFreeRoamHandles> | null = null;
  function ensureCachedHandles(): typeof cachedFreeRoamHandles {
    if (!cachedFreeRoamHandles) {
      try {
        cachedFreeRoamHandles = scenePreview.getFreeRoamHandles();
      } catch {
        /* Scene preview not ready yet — caller will retry next frame. */
        return null;
      }
    }
    return cachedFreeRoamHandles;
  }

  /* ============================================================================
   * Dock-forest harvestables (universal-harvest pass).
   *
   * Every dock forest tree, understory shrub, berry bush, and ring rock is rendered
   * by `attachDockForestHarvestables` (see [src/world/dockForestHarvestables.ts]) via
   * `THREE.InstancedMesh` per (kind, species) — the SAME proven architecture as the
   * awakened-mode harvest scatter (`freeRoamHarvestNodes.ts`). Per-instance hide on
   * break is O(1) (`setMatrixAt(i, ZERO)`) and the fall/crumble/collapse animations
   * mirror the scatter exactly. Once a tree falls, it's gone from the scene; respawn
   * after ~7 min restores the visual + collision footprint.
   *
   * The handle is initialized lazily in `ensureDockForestAttached` (after the scene
   * preview is ready + collisionWorld exists). Subsequent E-press / per-frame /
   * "Press E" prompt code routes through `dockForestHandle`.
   */
  let dockForestHandle: DockForestHandle | null = null;
  /* Round 5 phase C4 — `attachDockForestBatchedScene` is now async (frame-
   * spread scatter loop). Track the in-flight promise so the per-frame
   * ticker doesn't re-fire the construction while it's still running.
   * Cleared once the handle is set. */
  let dockForestAttachInFlight: Promise<void> | null = null;
  const FOREST_OBS_INTERACT_RADIUS = 1.8;

  function ensureDockForestAttached(): void {
    if (dockForestHandle) return;
    if (dockForestAttachInFlight) return;
    const cachedH = ensureCachedHandles();
    if (!cachedH) return;
    if (!collisionWorld) collisionWorld = getOrCreateSceneCollisionWorld(scenePreview.scene);
    /* `cachedH.forestStaticObstacles` is the full ForestStaticObstacle list emitted
     * by `forestEnvironment.ts` during scatter — every plant kind including ferns,
     * heather, and grass/vine/moss patches. Pass straight through to BatchedMesh
     * (the spec type IS ForestStaticObstacle, no remapping needed). */
    dockForestAttachInFlight = attachDockForestBatchedScene({
      scene: scenePreview.scene,
      specs: cachedH.forestStaticObstacles,
      collisionWorld,
    })
      .then((handle) => {
        dockForestHandle = handle;
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[mountApp] dock-forest attach failed', err);
      })
      .finally(() => {
        dockForestAttachInFlight = null;
      });
  }

  /**
   * Height-aware dock-forest harvest picker.
   *
   * Walks `dockForestHandle.nodes` once and applies up to two reach gates:
   *   - **Pick gate** — surface-distance from `pickXZ` ≤ `pickRadius`. The
   *     "what is the player aiming at" filter. For reticle harvest this is
   *     the camera-ray hit point; for proximity harvest it's the avatar XZ.
   *   - **Avatar gate** (optional, only when `avatarXZ` is non-null) —
   *     surface-distance from the avatar ≤ `avatarReach`. The "is the
   *     player physically close enough to chop it" filter. When the pick
   *     gate IS the avatar (proximity press), this is redundant; pass null.
   *
   * Among qualifying candidates, picks the one with the greatest visible
   * height (`topYWorld - bottomY`). Tiebreak (within `HEIGHT_TIE_EPS_M`):
   * nearest to the pick point by surface distance.
   *
   * **Why prefer taller?** When the player aims at a thicket of ferns +
   * bushes surrounding a big tree, the reticle XZ lands somewhere inside
   * the cluster. The previous "nearest by surface distance" picker would
   * grab whatever shrub was closest to that hit point — typically a fern,
   * not the obvious target. Tallest-wins makes "point at the cluster,
   * press E → chops the tree" Just Work, matching player intent.
   */
  const HEIGHT_TIE_EPS_M = 0.15;
  function pickTallestDockForestNodeNear(
    pickXZ: { x: number; z: number },
    pickRadius: number,
    avatarXZ: { x: number; z: number } | null,
    avatarReach: number,
  ): DockForestHarvestNode | null {
    if (!dockForestHandle) return null;
    const nodes = dockForestHandle.nodes;
    let best: DockForestHarvestNode | null = null;
    let bestHeight = -Infinity;
    let bestSurfaceDistSq = Infinity;
    const pickRadiusSq = pickRadius * pickRadius;
    const avatarReachSq = avatarReach * avatarReach;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (n.hp <= 0) continue;
      const pdx = n.x - pickXZ.x;
      const pdz = n.z - pickXZ.z;
      const pickSurfaceDist = Math.max(0, Math.hypot(pdx, pdz) - n.collisionRadius);
      const pickSurfaceDistSq = pickSurfaceDist * pickSurfaceDist;
      if (pickSurfaceDistSq > pickRadiusSq) continue;
      if (avatarXZ) {
        const adx = n.x - avatarXZ.x;
        const adz = n.z - avatarXZ.z;
        const avatarSurfaceDist = Math.max(0, Math.hypot(adx, adz) - n.collisionRadius);
        if (avatarSurfaceDist * avatarSurfaceDist > avatarReachSq) continue;
      }
      const h = n.topYWorld - n.bottomY;
      /* Prefer taller; within EPS, prefer closer to pick point. */
      if (h > bestHeight + HEIGHT_TIE_EPS_M
          || (Math.abs(h - bestHeight) <= HEIGHT_TIE_EPS_M && pickSurfaceDistSq < bestSurfaceDistSq)) {
        best = n;
        bestHeight = h;
        bestSurfaceDistSq = pickSurfaceDistSq;
      }
    }
    return best;
  }

  /**
   * Apply a hit to a specific dock-forest node + play the matching gather
   * clip + emit per-hit / break SFX + grant yield. Shared between proximity
   * and reticle dispatch paths so behaviour stays consistent.
   */
  function dispatchDockForestHit(node: DockForestHarvestNode): void {
    if (!dockForestHandle) return;
    const mult = store.getHarvestHitsMultiplier(yieldKindForObsKind(node.kind));
    const result = dockForestHandle.applyHit(node, mult);
    if (result.ignored) return;
    activeDockWorkerHost?.applyDockForestHitOnWorker(node.kind, node.index, mult);
    scenePreview.playGatherActionInPlace(result.yieldKind);
    if (result.chipYield > 0) store.freeRoamHarvestChip(result.yieldKind, result.chipYield);
    if (result.broken) {
      store.freeRoamHarvest(result.yieldKind);
      playHarvestBreakSound(result.yieldKind);
    } else {
      playHarvestProgressSound(result.yieldKind);
    }
  }

  /**
   * E-press routing helper: try a dock-forest harvest at `(ax, az)` (avatar
   * XZ). Returns true iff a hit was applied (caller should suppress fallback
   * paths). Mirrors the awakened-scatter handler in shape so behavior is
   * consistent. Uses the height-aware picker so a tall tree wins over an
   * adjacent fern when the player presses E inside a cluster.
   */
  function tryDockForestHit(ax: number, az: number): boolean {
    if (!dockForestHandle) return false;
    /* Proximity dispatch: pick gate IS the avatar gate (single XZ for both
     * "what's nearby" and "what can I reach"), so the avatar argument is
     * null — the pick radius alone enforces reach. */
    const node = pickTallestDockForestNodeNear(
      { x: ax, z: az },
      FOREST_OBS_INTERACT_RADIUS,
      null,
      FOREST_OBS_INTERACT_RADIUS,
    );
    if (!node) return false;
    dispatchDockForestHit(node);
    return true;
  }

  /** Yield kind for a dock-forest obstacle kind — drives store harvest routing. */
  function yieldKindForObsKind(kind: DockForestHarvestNode['kind']): string {
    switch (kind) {
      case 'tree': return 'wood';
      case 'shrub': return 'fiber';
      case 'berry_bush': return 'berries';
      case 'rock': return 'stone';
      case 'fern': return 'fiber';
      case 'heather': return 'fiber';
      case 'grass_patch': return 'fiber';
      case 'vine_patch': return 'fiber';
      case 'moss_patch': return 'fiber';
    }
  }
  /* Lazy-attach when scenePreview is ready (after first paint, scene root populated).
   * IMPORTANT: this attaches BEFORE `ensureCabinAttached`, so we eagerly create the
   * collision world here too — harvest scatter needs to register footprints with it on
   * attach (otherwise tree/rock collision wouldn't apply until the player opens build
   * mode). The collisionWorld is shared by harvest, cabin, mobs, and freeRoamControls. */
  function ensureHarvestNodesAttached(): void {
    if (harvestHandle) return;
    const h = ensureCachedHandles();
    if (!h) throw new Error('scene-not-ready');
    if (!collisionWorld) collisionWorld = getOrCreateSceneCollisionWorld(scenePreview.scene);
    harvestHandle = attachFreeRoamHarvestNodes({
      scene: scenePreview.scene,
      getTerrainHeight: h.getTerrainHeight,
      mapRadius: h.mapRadius,
      /* Reuse the existing on-map crystal scatter as the magic-crystal harvest targets so
       * the player mines the visible crystals already in the scene (no parallel meshes).
       * `crystalClusters` carries per-cluster Group refs so the harvest module can
       * shrink/hide individual clusters when fully harvested. */
      crystalSpotsXZ: h.crystalSpotsXZ,
      crystalClusters: h.crystalClusters,
      /* Phase 1.5 — wire collision world for harvest/dock scatter (blocking rules are
       * per-kind in `dockForestBatchedScene` / `freeRoamHarvestNodes`). */
      ...(collisionWorld ? { collisionWorld } : {}),
    });
    /* Apply visibility once on attach so the deck-mode load lands with the right metals
     * hidden right away. Subsequent applies happen via the store-subscribe below. */
    applyHarvestVisibilityRules();
  }

  /**
   * Lazy-attach the awakened-mode base-building handles (cabin renderer + ghost-preview
   * controller). Called from the per-frame loop with the same guard pattern as the
   * harvest scatter so both wait for `scenePreview` to be ready before binding.
   */
  function ensureCabinAttached(): void {
    if (cabinHandle && buildModeCtl && craftStationHandle && stationBuildModeCtl
        && collisionWorld && cameraLockCtl && mobsHandle
        && projectilesHandle && lockOnCtl && combatHandle
        && bouncyMushroomsHandle) return;
    const h = ensureCachedHandles();
    if (!h) throw new Error('scene-not-ready');
    /* Collision world FIRST — every other handle wires footprints into it on attach.
     * Uses the scene-singleton variant so this matches whatever extended preload
     * may have already created for the same scene (avoids the "trees visible but
     * no collision" bug where a fresh inline collisionWorld doesn't see the
     * footprints registered by extended preload). */
    if (!collisionWorld) collisionWorld = getOrCreateSceneCollisionWorld(scenePreview.scene);
    if (!cabinHandle) {
      cabinHandle = attachCabinBuilder({ scene: scenePreview.scene, collisionWorld });
      /* Warm the cabin shader programs at boot so the first time the player places a
       * (kind, tier) doesn't trigger a synchronous WebGL compile freeze. Same proven
       * pattern as `warmCraftDecorShadersForGpu` for campfire / workbench / torch —
       * see LEARNINGS.md "Campfire 5-second freeze" entry. Only runs once per session. */
      cabinHandle.warmShaders(scenePreview.renderer, scenePreview.camera);
      /* Initial sync — load saved pieces from the persisted state into the scene. */
      cabinHandle.syncFromState(store.getPlacedCabinPieces());
      syncWorkerDockBuildablesFromStore();
    }
    if (!buildModeCtl) {
      buildModeCtl = createBuildModeController({
        scene: scenePreview.scene,
        getTerrainHeight: h.getTerrainHeight,
        mapRadius: h.mapRadius,
        isWaterAt: h.isWaterAt,
        buildPieceTemplate: (kind, tier) => cabinHandle!.buildPieceTemplate(kind, tier),
        getPlacedPieces: () => store.getPlacedCabinPieces(),
        onConfirmPlace: (kind, tier, x, y, z, rotY) => store.placeCabinPiece(kind, tier, x, y, z, rotY),
      });
    }
    if (!craftStationHandle) {
      /* Multi-instance craft-station renderer (Phase 2). Same lazy-attach pattern
       * as `cabinHandle`. Initial sync hydrates the scene with any persisted
       * placements (so reload lands the player back at their camp visible). */
      craftStationHandle = attachCraftStationBuilder({
        scene: scenePreview.scene,
        collisionWorld,
      });
      craftStationHandle.syncFromState(store.getPlacedCraftStations());
      syncWorkerDockBuildablesFromStore();
    }
    if (!stationBuildModeCtl) {
      stationBuildModeCtl = createStationBuildModeController({
        scene: scenePreview.scene,
        getTerrainHeight: h.getTerrainHeight,
        mapRadius: h.mapRadius,
        isWaterAt: h.isWaterAt,
        buildPieceTemplate: (kind) => craftStationHandle!.buildPieceTemplate(kind),
        getPlacedStations: () => store.getPlacedCraftStations(),
        getPlacedCabinPieces: () => store.getPlacedCabinPieces(),
        collisionWorld,
        onConfirmPlace: (kind, x, y, z, rotY) => store.placeCraftStation(kind, x, y, z, rotY),
      });
    }
    if (!cameraLockCtl) {
      cameraLockCtl = createCameraLockController({
        canvas: activeDockWorkerHost?.canvas ?? scenePreview.renderer.domElement,
        scenePreview,
        ...(activeDockWorkerHost
          ? {
              cameraAuthority: {
                getCameraYawPitch: () => ({
                  yaw: workerDockOrbitFrame.yaw,
                  pitch: workerDockOrbitFrame.pitch,
                }),
                setCameraYawPitch: (yaw, pitch) => {
                  workerDockOrbitFrame.yaw = yaw;
                  workerDockOrbitFrame.pitch = pitch;
                },
                setCameraLockActive: (on) => activeDockWorkerHost!.setCameraLockActive(on),
              },
            }
          : {}),
        isAwakened: () => store.getRealmMode() === 'awakened',
      });
    }
    /* Damage floater overlay — attach BEFORE mobsHandle so the mob's `onMobDamaged`
     * callback can reach it. The overlay is a child of the game shell and projects
     * world-space hit anchors to screen-space DOM each frame. Reused across realm
     * mode switches; never disposed (one per session). */
    if (!damageFloatersHandle) {
      damageFloatersHandle = attachDamageFloaters({
        host: shell,
        canvas: activeDockWorkerHost?.canvas ?? scenePreview.renderer.domElement,
      });
    }
    /* Magical reticle — center-of-screen crosshair shown whenever camera-lock is
     * active in awakened mode. Visibility + free/locked-mode swap is updated per
     * frame from the `frame()` loop below; here we just attach the DOM. */
    if (!magicalReticleHandle) {
      magicalReticleHandle = attachMagicalReticle({ host: shell });
    }
    if (!mobsHandle) {
      if (activeDockWorkerHost) {
        mobsHandle = createWorkerProxyAwakenedMobsHandle({
          store,
          bridge: activeDockWorkerHost.getWorkerBridge(),
        });
      } else {
        mobsHandle = attachAwakenedMobs({
          scene: scenePreview.scene,
          getTerrainHeight: h.getTerrainHeight,
          mapRadius: h.mapRadius,
          store: {
            spawnAwakenedMob: (kind, x, y, z) => store.spawnAwakenedMob(kind, x, y, z),
            damageAwakenedMob: (id, amount) => store.damageAwakenedMob(id, amount),
            removeAwakenedMob: (id) => store.removeAwakenedMob(id),
            getActiveAwakenedMobs: () => store.getActiveAwakenedMobs(),
            /* Block damage reduction is applied via combatHandle.applyDamageMultiplier
             * before reaching the store — the wrap is set up after combatHandle exists.
             * Also spawns a RED damage floater above the player avatar so incoming
             * hits are immediately visible (mirrors dream-mode hit feedback). */
            damagePlayerInAwakened: (amount, sourceKind) => {
              const reduced = combatHandle ? combatHandle.applyDamageMultiplier(amount) : amount;
              store.damagePlayerInAwakened(reduced, sourceKind);
              if (damageFloatersHandle && reduced > 0) {
                /* Anchor above the player's chest — `h.avatar` is the live reference;
                 * +1.6 m clears the head silhouette so the number reads as "above me".
                 * Slight horizontal jitter prevents stacked simultaneous hits from
                 * rendering exactly on top of each other. */
                const jitterX = (Math.random() - 0.5) * 0.3;
                damageFloatersHandle.spawn(
                  h.avatar.position.x + jitterX,
                  h.avatar.position.y + 1.6,
                  h.avatar.position.z,
                  reduced,
                  'red',
                );
              }
            },
            getState: () => ({ pveWave: store.getState().pveWave }),
          },
          collisionWorld,
          /* Mob-damaged side: spawn a WHITE floater above the mob's head so the player
           * gets immediate "I hit them for X" feedback. Color choice mirrors the
           * dream-mode battle feedback the user is used to. The floater is anchored
           * to the mob's world position at the moment of impact and follows for its
           * lifetime — looks correct even when the mob is moving fast.
           * NOTE: every melee swing AND every magic projectile hit funnels through
           * `mobs.damage()`, so this single hook covers both attack types. */
          onMobDamaged: (mob, amount, killed, source) => {
            if (damageFloatersHandle && amount > 0) {
              /* +1.4 m is roughly the mob's chest height for wolf/wanderer; +0.8 m for
               * the rat. Use a single value — over-the-head is more readable than
               * exactly-on-the-chest, and the variance across kinds is small enough that
               * one offset reads correctly for all three. */
              const jitterX = (Math.random() - 0.5) * 0.3;
              damageFloatersHandle.spawn(
                mob.x + jitterX,
                mob.y + 1.4,
                mob.z,
                amount,
                source === 'magic' ? 'cyan' : 'white',
              );
            }
            /* === Awakened-mode hit blood (2026-04-19 restore) ===
             *
             * Spawn world-space face-spew gore at the mob's actual face/feet
             * WHEN AN ACTUAL HIT LANDED (`amount > 0`). Reuses the dream-mode
             * face-drip animation (burst at face → strips falling down →
             * ground pool melding in). The dream-mode gate at the top of
             * `updateBattleBlood` stays in place for swing-button-only
             * triggers (no blood just from pressing attack). Routing via this
             * `onMobDamaged` callback guarantees blood == damage applied: the
             * mob system only invokes us after `damage()` actually subtracted
             * HP from a live mob.
             *
             * `MOB_FACE_OFFSET_Y` tunes the face-burst spawn height per mob
             * kind so a low rat leaves a short drip and a tall wanderer leaves
             * a long one. Mob `y` is the ground footprint, so face = y +
             * offset. The intensity scales with the HP chip relative to max
             * HP so chips on a wolf read lighter than chips on a rat; killing
             * blows pin to 1.0 for the most pronounced gore. */
            if (amount > 0) {
              const maxHp = mob.maxHp || 1;
              const chipFrac = Math.min(1, amount / maxHp);
              const intensity = killed ? 1 : Math.max(0.4, chipFrac * 1.5);
              const faceOffset =
                mob.kind === 'rat' ? 0.5 : mob.kind === 'wolf' ? 0.95 : 1.55;
              scenePreview.spawnAwakenedHitBlood(
                mob.x,
                mob.y + faceOffset,
                mob.z,
                intensity,
              );
            }
            /* === Kill rewards (Phase 1.5 follow-up — see MOB_LOOT in awakenedMobs.ts) ===
             *
             * Currency is credited immediately at kill so the player gets the satisfying
             * "+N gold" bump even if they never go back to skin. For MELEE kills, meat
             * is gated on the corpse-skin E-press (legacy walk-over-and-press flow).
             * For MAGIC kills (`source === 'magic'`), meat is auto-granted at impact —
             * the player is too far away to reasonably walk over and skin, and the
             * mob is configured to skip the corpse phase entirely (see
             * `awakenedMobs.ts rangedKillNoCorpse`). The "+N meat" floater appears
             * over the mob's head at the moment the bolt lands so the loot feedback
             * is immediate. */
            if (killed) {
              const reward = MOB_LOOT[mob.kind];
              if (reward.currency > 0) {
                store.grantCurrency(reward.currency);
                if (damageFloatersHandle) {
                  damageFloatersHandle.spawn(
                    mob.x + 0.4,
                    mob.y + 2.1,
                    mob.z,
                    reward.currency,
                    'gold',
                  );
                }
              }
              if (source === 'magic' && reward.meat > 0) {
                store.grantRawMeat(reward.meat);
                if (damageFloatersHandle) {
                  /* Use the floater's `label` arg so the text reads "meat -N"
                   * with a leading +/positive interpretation visually anchored
                   * by the gold colour (loot, not damage). */
                  damageFloatersHandle.spawn(
                    mob.x - 0.4,
                    mob.y + 2.4,
                    mob.z,
                    reward.meat,
                    'gold',
                    '+meat',
                  );
                }
              }
            }
          },
        });
        mobsHandle.warmShaders(scenePreview.renderer, scenePreview.camera);
      }
    }
    /* Magic-projectile non-mob hit callback — extracted so the prebuilt
     * projectile handle (constructed during extended preload with stub
     * callbacks) can be late-bound via `setOnStaticHit()` AFTER mobsHandle
     * exists. Same logic, same closure deps as the inline version. */
    const makeProjectileOnStaticHit = () => (
      ownerId: string,
      hx: number,
      hy: number,
      hz: number,
      _damage: number,
    ) => {
      if (ownerId.startsWith('harvest:')) {
        if (!harvestHandle) return;
        const parts = ownerId.split(':');
        const kindStr = parts[1];
        const idxStr = parts[2];
        if (!kindStr || !idxStr) return;
        const idx = parseInt(idxStr, 10);
        if (isNaN(idx)) return;
        const node = harvestHandle.nodes.find(
          (n) => n.kind === kindStr && n.index === idx,
        );
        if (!node) return;
        const mult = store.getHarvestHitsMultiplier(node.kind);
        const result = harvestHandle.applyHit(node, mult);
        if (result.ignored) return;
        activeDockWorkerHost?.applyFreeRoamHarvestHitOnWorker(node.kind, node.index, mult);
        if (result.chipYield > 0) store.freeRoamHarvestChip(node.kind, result.chipYield);
        if (result.broken) {
          store.freeRoamHarvest(node.kind);
          playHarvestBreakSound(node.kind);
        } else {
          playHarvestProgressSound(node.kind);
        }
        if (damageFloatersHandle) {
          const label = node.kind.replace(/_/g, ' ').replace(/^mine /, '');
          damageFloatersHandle.spawn(hx, hy + 0.3, hz, Math.max(1, Math.round(mult)), 'cyan', label);
        }
        return;
      }
      if (ownerId.startsWith('dock-forest-batched:')) {
        if (!dockForestHandle) return;
        const parts = ownerId.split(':');
        const idxStr = parts[2];
        if (!idxStr) return;
        const idx = parseInt(idxStr, 10);
        if (isNaN(idx)) return;
        const node = dockForestHandle.getNodeByIndex(idx);
        if (!node) return;
        const yieldKind = yieldKindForObsKind(node.kind);
        const mult = store.getHarvestHitsMultiplier(yieldKind);
        const result = dockForestHandle.applyHit(node, mult);
        if (result.ignored) return;
        activeDockWorkerHost?.applyDockForestHitOnWorker(node.kind, node.index, mult);
        scenePreview.playGatherActionInPlace(result.yieldKind);
        if (result.chipYield > 0) store.freeRoamHarvestChip(result.yieldKind, result.chipYield);
        if (result.broken) {
          store.freeRoamHarvest(result.yieldKind);
          playHarvestBreakSound(result.yieldKind);
        } else {
          playHarvestProgressSound(result.yieldKind);
        }
        if (damageFloatersHandle) {
          damageFloatersHandle.spawn(hx, hy + 0.3, hz, Math.max(1, Math.round(mult)), 'cyan', result.yieldKind);
        }
        return;
      }
      const MAGIC_BUILD_DAMAGE = 1;
      if (ownerId.startsWith('cabin:')) {
        const id = parseInt(ownerId.slice(6), 10);
        if (isNaN(id)) return;
        const result = store.damageCabinPiece(id, MAGIC_BUILD_DAMAGE);
        if (result && damageFloatersHandle) {
          damageFloatersHandle.spawn(
            hx, hy + 0.6, hz,
            MAGIC_BUILD_DAMAGE, 'cyan',
            result.destroyed ? 'wall destroyed' : 'wall',
          );
        }
        return;
      }
      if (ownerId.startsWith('craft_station:')) {
        const id = parseInt(ownerId.slice('craft_station:'.length), 10);
        if (isNaN(id)) return;
        const result = store.damageCraftStation(id, MAGIC_BUILD_DAMAGE);
        if (result && damageFloatersHandle) {
          damageFloatersHandle.spawn(
            hx, hy + 0.6, hz,
            MAGIC_BUILD_DAMAGE, 'cyan',
            result.destroyed ? 'station destroyed' : 'station',
          );
        }
        return;
      }
      if (ownerId.startsWith('mushroom:')) {
        if (!bouncyMushroomsHandle) return;
        const result = bouncyMushroomsHandle.applyMagicHit(ownerId, MAGIC_BUILD_DAMAGE);
        if (result && damageFloatersHandle) {
          damageFloatersHandle.spawn(
            hx, hy + 0.6, hz,
            MAGIC_BUILD_DAMAGE, 'cyan',
            result.destroyed ? 'mushroom destroyed' : 'mushroom',
          );
        }
        return;
      }
    };
    if (!projectilesHandle) {
      projectilesHandle = attachMagicProjectiles({
        scene: scenePreview.scene,
        collisionWorld,
        mobs: mobsHandle,
        /* Terrain heightfield sampler — projectile despawns cleanly when
         * `bolt.y < terrainY` so aiming straight down doesn't have the bolt
         * silently slide under terrain and persist invisibly until lifetime
         * expiry. Same sampler the dock + free-roam controls use. */
        getTerrainHeight: h.getTerrainHeight,
        /* See `makeProjectileOnStaticHit` above for the magic-as-universal-
         * damage routing. Wired identically in the prebuilt-adoption path
         * via `setOnStaticHit()` below. */
        onStaticHit: makeProjectileOnStaticHit(),
      });
      projectilesHandle.warmShaders(scenePreview.renderer, scenePreview.camera);
    }
    /* Wire (or re-wire) the prebuilt projectile handle's late-bound
     * callbacks. When extended preload constructed it during the title
     * screen, `mobs` and `onStaticHit` were stub no-ops because mountApp's
     * real refs didn't exist yet. Now mobsHandle exists and the static-hit
     * routing closures have all their dependencies — wire them in. Cheap
     * + idempotent; for the fresh-construct path this is a no-op redundant
     * write of values we just set in the constructor. */
    projectilesHandle.setMobs(mobsHandle);
    projectilesHandle.setOnStaticHit(makeProjectileOnStaticHit());
    if (!lockOnCtl) {
      lockOnCtl = attachLockOnController({
        mobs: mobsHandle,
        avatar: h.avatar,
        camera: scenePreview.camera,
        isCameraLocked: () => !!cameraLockCtl?.isActive(),
        ...(activeDockWorkerHost
          ? {
              setCameraYawPitch: (yaw, pitch) => {
                workerDockOrbitFrame.yaw = yaw;
                workerDockOrbitFrame.pitch = pitch;
              },
              getCameraYawPitch: () => ({
                yaw: workerDockOrbitFrame.yaw,
                pitch: workerDockOrbitFrame.pitch,
              }),
            }
          : {
              setCameraYawPitch: (yaw, pitch) => scenePreview.setCameraYawPitch(yaw, pitch),
              getCameraYawPitch: () => scenePreview.getCameraYawPitch(),
            }),
        /* Pass scene + terrain sampler so the controller can mount the emissive
         * lock-on reticle under the locked target. The reticle is lazy-built on
         * first lock (no scene mutation until the player actually presses T). */
        scene: scenePreview.scene,
        getTerrainHeight: h.getTerrainHeight,
      });
    }
    /* Defensive ward — attach BEFORE combat so combat can wire it in via opts. The
     * ward is lazy-built on first activate, so attaching cheap and idempotent. */
    if (!defensiveWardHandle) {
      defensiveWardHandle = attachDefensiveWard({ scene: scenePreview.scene });
    }
    if (!combatHandle) {
      combatHandle = attachAwakenedCombat({
        scene: scenePreview.scene,
        camera: scenePreview.camera,
        store: {
          /* getStateRef avoids a per-call JSON deep-clone. Combat queries
           * state several times per frame in awakened mode (mana check,
           * spell-card lookup, target validation) — the original
           * `getState()` was paying 5-50ms/sec of pure JSON tax during
           * active combat. Awakened combat code reads only; never mutates
           * the returned state. */
          getState: () => store.getStateRef(),
          useMana: (amount) => store.useMana(amount),
          getOffensiveSpellCard: () => store.getOffensiveSpellCard(),
          getDefensiveSpellCard: () => store.getDefensiveSpellCard(),
        },
        scenePreview: {
          getStaffTipWorldPosition: () => scenePreview.getStaffTipWorldPosition(),
          playInPlaceCombatClip: (kind) => scenePreview.playInPlaceCombatClip(kind),
        },
        collisionWorld,
        /* Heightfield sampler for the 3D aim raycast — `reticleAimPoint`
         * walks the camera ray to find where it intersects the ground so
         * the bolt lands exactly at the spot under the reticle (instead
         * of flying parallel along camera-forward and missing the actual
         * world point). Same sampler used by the dock + free-roam controls. */
        getTerrainHeight: h.getTerrainHeight,
        mobs: mobsHandle,
        lockOn: lockOnCtl,
        magicProjectiles: projectilesHandle,
        defensiveWard: defensiveWardHandle,
      });
    }
    /* Bouncy mushroom field — 18 trippy drip-mushrooms with auto-bounce on landing
     * (Mario-rules trampoline) + sapling-grow respawn on magic-bolt destruction.
     * See `docs/TRIPPY_TERRAIN_AND_BOUNCE_MUSHROOMS_PLAN.md` for the full design.
     * Lazy-attached here alongside the other awakened-mode handles; collision
     * footprints go into the same shared `collisionWorld` so the existing
     * `getGroundY` + predicted-XZ landing pipeline handles "stand on cap" with
     * no per-mushroom code in the freeRoamControls landing detection. */
    if (!bouncyMushroomsHandle) {
      bouncyMushroomsHandle = attachAwakenedBouncyMushrooms({
        scene: scenePreview.scene,
        getTerrainHeight: h.getTerrainHeight,
        mapRadius: h.mapRadius,
        creeks: h.resolvedCreeks,
        dockXZ: h.dockXZ,
        collisionWorld,
      });
      /* Warm cap + stem + drip shader programs (8 of each) at attach so the
       * first mushroom in camera doesn't trigger a 100-400 ms compile freeze.
       * Same proven pattern as `mobsHandle.warmShaders` and
       * `projectilesHandle.warmShaders`. */
      bouncyMushroomsHandle.warmShaders(scenePreview.renderer, scenePreview.camera);
    }
    if (activeDockWorkerHost && !workerMobAuthoritySinkWired) {
      workerMobAuthoritySinkWired = true;
      const dockGameHost = activeDockWorkerHost;
      dockGameHost.syncPveWaveForMobs(store.getState().pveWave);
      dockGameHost.setWorkerMobAuthoritySink((msg: WorkerMobAuthorityMessage) => {
        if (msg.type === 'awakenedMobsAuthoritySnapshot') {
          store.applyAwakenedMobsAuthorityFromWorker(msg.mobs, msg.mobCounter);
          return;
        }
        if (msg.type === 'awakenedPlayerDamaged') {
          const reduced = combatHandle ? combatHandle.applyDamageMultiplier(msg.amount) : msg.amount;
          store.damagePlayerInAwakened(reduced, msg.sourceKind);
          if (damageFloatersHandle && reduced > 0) {
            const hh = ensureCachedHandles();
            if (hh) {
              const jitterX = (Math.random() - 0.5) * 0.3;
              damageFloatersHandle.spawn(
                hh.avatar.position.x + jitterX,
                hh.avatar.position.y + 1.6,
                hh.avatar.position.z,
                reduced,
                'red',
              );
            }
          }
          return;
        }
        if (msg.type === 'awakenedCorpseSkinLoot') {
          if (msg.meat > 0) {
            store.grantRawMeat(msg.meat);
            if (damageFloatersHandle) {
              damageFloatersHandle.spawn(msg.x - 0.4, msg.y + 2.4, msg.z, msg.meat, 'gold', '+meat');
            }
          }
          return;
        }
        if (msg.type !== 'awakenedMobDamaged') return;
        /* Parity with main-thread `onMobDamaged` in attachAwakenedMobs */
        const { mob, amount, killed, source } = msg;
        if (damageFloatersHandle && amount > 0) {
          const jitterX = (Math.random() - 0.5) * 0.3;
          damageFloatersHandle.spawn(
            mob.x + jitterX,
            mob.y + 1.4,
            mob.z,
            amount,
            source === 'magic' ? 'cyan' : 'white',
          );
        }
        if (amount > 0) {
          const maxHp = mob.maxHp || 1;
          const chipFrac = Math.min(1, amount / maxHp);
          const intensity = killed ? 1 : Math.max(0.4, chipFrac * 1.5);
          const faceOffset = mob.kind === 'rat' ? 0.5 : mob.kind === 'wolf' ? 0.95 : 1.55;
          dockGameHost.spawnAwakenedHitBlood(mob.x, mob.y + faceOffset, mob.z, intensity);
        }
        if (killed) {
          const reward = MOB_LOOT[mob.kind];
          if (reward.currency > 0) {
            store.grantCurrency(reward.currency);
            if (damageFloatersHandle) {
              damageFloatersHandle.spawn(mob.x + 0.4, mob.y + 2.1, mob.z, reward.currency, 'gold');
            }
          }
          if (source === 'magic' && reward.meat > 0) {
            store.grantRawMeat(reward.meat);
            if (damageFloatersHandle) {
              damageFloatersHandle.spawn(mob.x - 0.4, mob.y + 2.4, mob.z, reward.meat, 'gold', '+meat');
            }
          }
        }
      });
    }
  }
  /* Read deck-unlock dev flag once per session — flip to '1' to see all metals at boot. */
  let devForceShowAllNodes = false;
  try {
    devForceShowAllNodes = localStorage.getItem('idleCraft.devUnlockAllNodes') === '1';
  } catch {
    /* ignore */
  }
  /* Reusable Set + signature so visibility-rule application doesn't allocate per call.
   * The Set is rebuilt only when the unlock signature changes; it then drives both the
   * harvest scatter and any future caller. */
  let lastUnlockSig = '';
  const cachedUnlockedSet = new Set<string>();
  function applyHarvestVisibilityRules(): void {
    if (!harvestHandle) return;
    /* getStateRef + read-only — `unlockedCardIds` is just iterated to build
     * a cached Set; never mutated. */
    const ids = store.getStateRef().unlockedCardIds;
    const sig = ids.join('|');
    if (sig !== lastUnlockSig) {
      lastUnlockSig = sig;
      cachedUnlockedSet.clear();
      for (const id of ids) cachedUnlockedSet.add(id);
    }
    harvestHandle.setVisibilityRules({
      realm: store.getRealmMode(),
      unlockedCardIds: cachedUnlockedSet,
      forceShowAll: devForceShowAllNodes,
    });
  }
  /* Re-apply only on store emits (unlock card or realm change → cheap signature compare
   * inside `setVisibilityRules` exits early when nothing relevant changed). Per-frame
   * cost in the render loop drops from "rebuild Set + traverse 13 kinds" to zero. */
  store.subscribe(applyHarvestVisibilityRules);
  /* Re-sync the cabin renderer whenever store emits — placement / removal / save load
   * are the only events that change `placedCabinPieces`, and the per-bucket signature
   * inside `cabinHandle.syncFromState` early-returns when nothing in a bucket changed,
   * so the per-frame cost of "subscribe to all emits" is just a small handful of
   * string compares when the player isn't building.
   *
   * === 2026-04-20 REGRESSION FIX ===
   *
   * A reference-equality short-circuit was tried here but it's INCORRECT —
   * the store mutates `placedCabinPieces` and `placedCraftStations` IN
   * PLACE via `.push()` / `.splice()` (see `gameStore.ts` `placeCabinPiece`,
   * `removeCabinPiece` and equivalents). The array reference never
   * changes, so `pieces !== lastCabinPiecesRef` always returns false
   * after the first call — syncFromState was skipped forever, leaving
   * placed cabins/stations invisible (or destroyed pieces ghost-rendering)
   * and collision footprints out of sync (which can cascade into
   * wrong-looking harvest collisions, "objects don't despawn"
   * symptoms reported by playtest).
   *
   * Going back to unconditional `syncFromState` — it has its own internal
   * per-bucket signature gating that early-returns when nothing changed,
   * so the per-emit cost for deck-mode players (no placements) is just a
   * `placedCabinPieces.length === 0` check. */
  store.subscribe(() => {
    if (cabinHandle) cabinHandle.syncFromState(store.getPlacedCabinPieces());
    /* Same reasoning as the cabin sync — every placement / removal / save load
     * goes through `placeCraftStation` / `removeCraftStation`, both of which
     * emit. The handle's diff over the placed-id set is O(N stations), with N
     * tiny in practice; deck-mode players never touch this code path because
     * the array stays empty. */
    if (craftStationHandle) craftStationHandle.syncFromState(store.getPlacedCraftStations());
    syncWorkerDockBuildablesFromStore();
  });
  /* Staff-priority visibility — keep the Vanguard's silver wizard staff visible
   * whenever an offensive spell is equipped in awakened mode, even if the player
   * also has a melee weapon equipped. Without this the staff was hidden whenever
   * a held prop (axe / sword / pick) was in the right hand — so equipping a spell
   * + holding an axe meant the player saw their axe but cast invisible magic.
   * Now: spell equipped + awakened → staff visible (priority); deck mode or no
   * spell → fall back to the prop-aware visibility logic. The setter is sig-gated
   * (idempotent on unchanged values), so subscribing to all emits is cheap. */
  store.subscribe(() => {
    const s = store.getState();
    const showStaff = s.realmMode === 'awakened' && s.equippedOffensiveSpellId != null;
    scenePreview.setStaffPriorityVisible(showStaff);
  });
  store.subscribe(() => {
    activeDockWorkerHost?.syncPveWaveForMobs(store.getState().pveWave);
  });
  /* Floating "Press E" prompt — single DOM element repositioned each frame. */
  const harvestPromptEl = document.createElement('div');
  harvestPromptEl.className = 'free-roam-prompt';
  harvestPromptEl.hidden = true;
  shell.appendChild(harvestPromptEl);
  /* Reused proximity-scan input object so the per-frame scan in the render loop doesn't
   * allocate a fresh `{x,z}` literal every tick (would churn through ~6 KB/sec at 144Hz
   * across 4-5 such allocs in awakened mode). */
  const proximityScratch = { x: 0, z: 0 };

  /* ---------- Phase C — free-roam controls (awakened mode) ---------- */
  /* Attach WASD + mouse-yaw + Tab-menu + E-interact when realm flips to 'awakened'.
   * Detach when it flips back to 'deck'. The dock's existing solo-dock follow camera
   * already updates per frame (see `refreshSoloDockFramingFromAvatar` in
   * `characterScenePreview`), so movement → camera follow comes for free. */
  let freeRoamHandle: FreeRoamHandle | null = null;
  let hotbarHandle: { dispose: () => void } | null = null;
  /**
   * Active shortcut-bar mounts on the inventory + decks pages. We track each one so
   * the next page render can dispose the previous (DOM removal + store-unsub) before
   * mounting a fresh one. Without this the store would accumulate dead subscribers
   * across re-renders. Keyed by render context so an inventory-page bar and a
   * decks-page bar can co-exist when both are simultaneously visible (e.g. the
   * awakened-mode Tab overlay shows the same page while the underlying deck-mode
   * page is also live).
   */
  const shortcutBarHandles: Record<string, ShortcutBarHandle | null> = {
    inventoryDeck: null,
    inventoryAwakened: null,
    decksDeck: null,
    decksAwakened: null,
  };
  function disposeShortcutBar(key: string): void {
    const h = shortcutBarHandles[key];
    if (h) {
      h.dispose();
      shortcutBarHandles[key] = null;
    }
  }
  /**
   * Active consumable-hotbar mounts. One per page-render context so every render
   * disposes the previous mount before creating a fresh one — same pattern as
   * `shortcutBarHandles` to prevent dead store-subscriber accumulation.
   */
  const consumableHotbarHandles: Record<string, ConsumableHotbarHandle | null> = {
    awakenedHud: null,
    inventoryDeck: null,
    inventoryAwakened: null,
  };
  function disposeConsumableHotbar(key: string): void {
    const h = consumableHotbarHandles[key];
    if (h) {
      h.dispose();
      consumableHotbarHandles[key] = null;
    }
  }
  /** Per-render quick-equip panel handles (inline, no modal). */
  const quickEquipHandles: Record<string, QuickEquipPanelHandle | null> = {
    inventoryDeck: null,
    inventoryAwakened: null,
  };
  function disposeQuickEquip(key: string): void {
    const h = quickEquipHandles[key];
    if (h) {
      h.dispose();
      quickEquipHandles[key] = null;
    }
  }
  function ensureFreeRoamMatchesRealm(): void {
    const awakened = store.getRealmMode() === 'awakened';
    /* Tell the dock to disable its snap-back-to-camp routing first so the WASD integrator's
     * position writes aren't fought every frame. Also re-orients avatar so camera lands
     * BEHIND it and resets the camera deltas to canonical solo-dock framing. */
    scenePreview.setAwakenedFreeRoam(awakened);
    activeDockWorkerHost?.setAwakenedFreeRoam(awakened);
    /* Hotbar — bottom-of-screen overlay showing equipment + spells + top inventory items.
     * Only visible in awakened mode so the deck-mode HUD layout isn't disturbed. */
    if (awakened && !hotbarHandle) {
      hotbarHandle = mountAwakenedHotbar(shell, store);
    } else if (!awakened && hotbarHandle) {
      hotbarHandle.dispose();
      hotbarHandle = null;
    }
    /* Consumable hotbar (1-6 slots) — overlaid in awakened mode for in-game
     * use. `useOnFilledClick: true` so left-click on a filled slot consumes
     * the item (in addition to the number-key activation). Mounted as a child
     * of `shell` so the existing CSS class `.consumable-hotbar` positions it
     * via inline margin from the bottom of the existing vital-bars hotbar. */
    if (awakened && !consumableHotbarHandles.awakenedHud) {
      consumableHotbarHandles.awakenedHud = mountConsumableHotbar(shell, store, {
        modalHost: shell,
        useOnFilledClick: true,
      });
    } else if (!awakened) {
      disposeConsumableHotbar('awakenedHud');
    }
    if (awakened && !freeRoamHandle) {
      const h = ensureCachedHandles();
      if (!h) return;
      freeRoamHandle = attachFreeRoamControls({
        avatar: h.avatar,
        getTerrainHeight: h.getTerrainHeight,
        mapRadius: h.mapRadius,
        getCameraForwardXZ: () => {
          const host = activeDockWorkerHost;
          if (host) {
            const s = host.sharedState;
            return { x: s.getCameraForwardX(), z: s.getCameraForwardZ() };
          }
          return scenePreview.getCameraForwardXZ();
        },
        isAwakened: () => store.getRealmMode() === 'awakened',
        ...(activeDockWorkerHost
          ? {
              workerOwnsAvatarMovement: true,
              getAirborneOverride: () => activeDockWorkerHost!.sharedState.hasFlag(FLAG.AIRBORNE),
            }
          : {}),
        /* E-key harvest — universal "harvest whatever the reticle is on" pattern when
         * camera-locked, falls back to avatar-proximity pick when free-cursor.
         *
         * **Reticle-priority (camera-locked + awakened):** the camera ray from screen
         * centre is the player's intent. Whatever it physically lands on (corpse →
         * scattered node → dock-forest node → water under the hit point) gets harvested,
         * so standing in the creek aiming at a tree on the bank harvests the TREE
         * (the legacy "water-first" proximity rule used to hijack the press here). The
         * camera ray uses the same math as magic casting (`combatHandle.resolveReticleAim`)
         * — single source of truth for "what is the player aiming at right now."
         *
         * **Proximity fallback (free-cursor):** historical behaviour — corpse > water
         * > scattered node > dock-forest node. Used in dock/free-cursor mode where the
         * reticle isn't on screen. */
        onInteract: () => {
          if (!harvestHandle) return;
          const hh = ensureCachedHandles();
          if (!hh) return;
          const ax = hh.avatar.position.x;
          const az = hh.avatar.position.z;

          /* === Reticle-pointed harvest (camera-locked) ===
           *
           * STRICT rule: when camera is locked, the reticle is the SOLE target
           * picker. The player gathers EXACTLY what their crosshair is on — never
           * a resource behind them, never a "nearest object" fallback. Two gates
           * BOTH have to pass:
           *
           *   1. RETICLE GATE — the camera-ray's world hit point lands on a
           *      harvestable thing (corpse / scatter node / dock-forest node /
           *      water). If the crosshair is on bare ground or sky, no harvest.
           *   2. PHYSICAL-REACH GATE — the AVATAR is within HARVEST_AVATAR_REACH
           *      (1.3 m) of the chosen resource's collision SURFACE (not its
           *      center). Surface-distance is `centerDist - collisionRadius`,
           *      so a giant oak with a 1.5 m trunk radius is still reachable
           *      when the player is touching the bark — center-distance check
           *      would have made max-scale trees unreachable forever (the
           *      user-reported "lots of trees won't let me harvest" bug:
           *      collision push-out kept the player at center-distance > the
           *      gate radius). Small props (rocks, ore, fiber) end up with
           *      effectively the same reach as before since their radii are
           *      sub-30 cm.
           *
           * If EITHER gate fails the press is consumed (silent no-op) — we do
           * NOT fall through to a proximity dispatch. The player has aimed
           * deliberately and gets back exactly what they aimed at, or nothing.
           * Ground-cover (grass / vine / moss patches, ferns, heather) is
           * already individual scatter nodes that happen to cluster, so pointing
           * at any one of them in a cluster harvests THAT one — which matches
           * the user's "cluster groups read as one tap" intuition without any
           * special grouping code. */
          const HARVEST_AVATAR_REACH = 1.3;
          if (cameraLockCtl?.isActive() && combatHandle) {
            const aim = combatHandle.resolveReticleAim(40);
            const hitXZ = { x: aim.x, z: aim.z };
            /* 1. Corpse — picked at the reticle hit point with a generous 2.0 m
             *    radius (corpses have visible bulk so a single ray hit can fall
             *    just past the body). Avatar still has to be within the legacy
             *    1.8 m skin range to claim the meat. */
            if (mobsHandle) {
              const corpse = mobsHandle.getCorpseNearAvatar(hitXZ, 2.0);
              if (corpse) {
                /* Corpses don't have a meaningful collision radius (small + lying
                 * down). Use plain center distance; HARVEST_AVATAR_REACH is well
                 * above any corpse footprint. */
                const dxc = corpse.x - ax;
                const dzc = corpse.z - az;
                if (Math.hypot(dxc, dzc) <= HARVEST_AVATAR_REACH) {
                  const corpseId = corpse.id;
                  const corpseX = corpse.x;
                  const corpseY = corpse.y;
                  const corpseZ = corpse.z;
                  scenePreview.playGatherActionInPlace('skin', () => {
                    const loot = mobsHandle?.skinCorpse(corpseId);
                    if (loot && loot.meat > 0) {
                      store.grantRawMeat(loot.meat);
                      if (damageFloatersHandle) {
                        damageFloatersHandle.spawn(
                          corpseX, corpseY + 1.5, corpseZ,
                          loot.meat, 'gold',
                        );
                      }
                    }
                  });
                  return;
                }
              }
            }
            /* 2. Awakened scatter node at reticle hit + avatar within INTERACT_RADIUS
             *    of the picked node. `getNodeNearAvatar` is misnamed (it's really
             *    "nearest node within radius of XZ") — calling it with the reticle
             *    XZ finds the crosshaired node; the explicit avatar-distance gate
             *    below enforces the physical-reach rule. */
            const scatterNode = harvestHandle.getNodeNearAvatar(hitXZ);
            if (scatterNode) {
              const dxs = scatterNode.x - ax;
              const dzs = scatterNode.z - az;
              const surfaceDist = Math.max(0, Math.hypot(dxs, dzs) - scatterNode.collisionRadius);
              if (surfaceDist <= HARVEST_AVATAR_REACH) {
                const clipActionId = scatterNode.kind === 'magic_crystal' ? 'stone' : scatterNode.kind;
                scenePreview.playGatherActionInPlace(clipActionId);
                const mult = store.getHarvestHitsMultiplier(scatterNode.kind);
                const result = harvestHandle.applyHit(scatterNode, mult);
                if (result.ignored) return;
                activeDockWorkerHost?.applyFreeRoamHarvestHitOnWorker(scatterNode.kind, scatterNode.index, mult);
                if (result.chipYield > 0) store.freeRoamHarvestChip(scatterNode.kind, result.chipYield);
                if (result.broken) {
                  store.freeRoamHarvest(scatterNode.kind);
                  playHarvestBreakSound(scatterNode.kind);
                } else {
                  playHarvestProgressSound(scatterNode.kind);
                }
                return;
              }
            }
            /* 3. Dock-forest node at reticle hit + avatar within SURFACE-distance
             *    of the trunk. Reticle-pick radius stays generous (FOREST_OBS_INTERACT_RADIUS)
             *    so a slightly-off camera ray still finds big trees; the avatar
             *    gate uses surface-distance (centerDist - trunkRadius) so giant
             *    oaks are reachable when the player is touching the bark.
             *
             *    Height-aware pick: when the reticle XZ is inside a cluster
             *    (e.g. ferns + bushes around a big oak), the picker prefers
             *    the tallest reachable node — so "aim at the cluster, press
             *    E → chops the tree, not a fern." Both gates fire in the
             *    same walk; if the tallest candidate is out of avatar
             *    reach the picker continues evaluating shorter candidates,
             *    so the player still chops a reachable shrub when the tree
             *    is just out of grasp. */
            if (dockForestHandle) {
              const dfNode = pickTallestDockForestNodeNear(
                hitXZ,
                FOREST_OBS_INTERACT_RADIUS,
                { x: ax, z: az },
                HARVEST_AVATAR_REACH,
              );
              if (dfNode) {
                dispatchDockForestHit(dfNode);
                return;
              }
            }
            /* 4. Water under the reticle hit + avatar near water. The reticle's
             *    terrain XZ has to BE water (no peripheral catch) AND the avatar
             *    has to be standing on / next to water — same `isNearWater` gate
             *    the legacy dispatch uses. */
            if (hh.isWaterAt(aim.x, aim.z) && (hh.isWaterAt(ax, az) || isNearWater(hh.isWaterAt, ax, az))) {
              scenePreview.playGatherActionInPlace('water');
              store.freeRoamHarvest('water');
              playWaterGatherSound();
              return;
            }
            /* Reticle missed OR target out of reach — STOP. No proximity
             * fallback when camera-locked. The player aimed deliberately; if
             * nothing harvestable was at the crosshair, the press is consumed
             * silently. This is what makes "I gather exactly what I'm pointing
             * at, never anything else" work as a hard guarantee. */
            return;
          }

          /* === Free-cursor proximity fallback (NOT camera-locked) ===
           *
           * Reached only when the reticle isn't on screen — the dock/free-cursor
           * mode where the player has no aiming surface. Legacy priority order
           * preserved: corpse > water > scatter > dock-forest. */

          /* === Mob corpse skin (priority 1) ===
           *
           * Walk over a rat / wolf corpse + press E -> kneel + work animation
           * + meat goes into inventory + corpse despawns. Wanderer kills don't
           * leave a corpse (MOB_LOOT.wanderer.meat === 0 -> no corpse persist
           * in the death state machine). Currency is already credited at
           * kill-time (see `onMobDamaged` -> `MOB_LOOT[kind].currency`). */
          if (mobsHandle) {
            proximityScratch.x = ax;
            proximityScratch.z = az;
            const corpse = mobsHandle.getCorpseNearAvatar(proximityScratch);
            if (corpse) {
              /* Snapshot the corpse data NOW (before the deferred callback runs) — by
               * the time the skin clip finishes the corpse is still in the store, but
               * we want to use the position captured at the moment the player triggered
               * the harvest so the floating loot text spawns at the right spot.
               * Despawn + loot grant + floater all wait for the animation to complete
               * so the player visibly sees the kneel/work motion happen ON the corpse,
               * not on empty space. Without this defer the corpse instantly vanished
               * the moment E was pressed. */
              const corpseId = corpse.id;
              const corpseX = corpse.x;
              const corpseY = corpse.y;
              const corpseZ = corpse.z;
              scenePreview.playGatherActionInPlace('skin', () => {
                /* Re-fetch + skin at clip-end. If the corpse is somehow gone (shouldn't
                 * happen — corpses persist until skinned or world-clear) the call returns
                 * null and we no-op. */
                const loot = mobsHandle?.skinCorpse(corpseId);
                if (loot && loot.meat > 0) {
                  store.grantRawMeat(loot.meat);
                  if (damageFloatersHandle) {
                    damageFloatersHandle.spawn(
                      corpseX, corpseY + 1.5, corpseZ,
                      loot.meat, 'gold',
                    );
                  }
                }
              });
              return;
            }
          }
          /* Water by the river — single-press fill, no multi-hit loop. The dedicated
           * `playWaterGatherSound()` plays a richer bucket-fill cycle (dip → pour →
           * drip tail, ~1s) than the legacy single-shot 'water' SFX, and routes through
           * the harvest sub-bus so the player's harvest volume slider controls it.
           * `freeRoamHarvest` runs with skipSfx so the legacy SFX doesn't double up. */
          if (hh.isWaterAt(ax, az) || isNearWater(hh.isWaterAt, ax, az)) {
            scenePreview.playGatherActionInPlace('water');
            store.freeRoamHarvest('water');
            playWaterGatherSound();
            return;
          }
          proximityScratch.x = ax;
          proximityScratch.z = az;
          const node = harvestHandle.getNodeNearAvatar(proximityScratch);
          if (!node) {
            /* Fallback: try the universal-harvest forest path. Every visible dock
             * tree / shrub / berry bush / ring rock is rendered by the InstancedMesh
             * scene with proper per-instance fall animations + respawn — same idiom
             * as the awakened scatter. */
            tryDockForestHit(ax, az);
            return;
          }
          /* Multi-hit harvest loop — `applyHit` decrements the node's hp by the player's
           * tool multiplier (better axe / pickaxe → fewer hits to break). Per hit:
           *   - chip yield (small qty, no mastery / wear) goes into inventory
           *   - per-hit progress SFX (chop / pick / pluck) fires
           * On the FINAL hit (broken === true):
           *   - the climactic break SFX (tree-fall crash, boulder crumble, etc.) fires
           *   - `freeRoamHarvest()` runs the full performGather pipeline for the bulk
           *     yield + currency + tool wear + mastery
           *   - the harvest module starts the fall / crumble / collapse animation
           *     internally and schedules the long respawn timer (~7 min).
           * The dock's gather clip plays in place every hit so the avatar visibly chops /
           * picks / plucks for the player. */
          const clipActionId = node.kind === 'magic_crystal' ? 'stone' : node.kind;
          scenePreview.playGatherActionInPlace(clipActionId);
          const mult = store.getHarvestHitsMultiplier(node.kind);
          const result = harvestHandle.applyHit(node, mult);
          if (result.ignored) return;
          activeDockWorkerHost?.applyFreeRoamHarvestHitOnWorker(node.kind, node.index, mult);
          if (result.chipYield > 0) store.freeRoamHarvestChip(node.kind, result.chipYield);
          if (result.broken) {
            store.freeRoamHarvest(node.kind);
            playHarvestBreakSound(node.kind);
          } else {
            playHarvestProgressSound(node.kind);
          }
        },
        /* Tab toggles a full-screen menu overlay that re-exposes the deck-mode tabs. */
        onToggleMenu: () => toggleAwakenedMenuOverlay(),
        /* Build-mode input rewiring (Phase 1 + Phase 2 station placement — see
         * `BASE_BUILDING_AND_SURVIVAL_PLAN.md`). While the ghost preview is
         * active for EITHER cabin pieces or craft stations, E/LMB confirms
         * placement, Esc cancels, R rotates 90°, mouse wheel rotates 15°. WASD
         * + Space still pass through normally so the player can position +
         * jump while placing.
         *
         * Dispatch rule: at most ONE controller is active at a time (Build tab
         * UI calls `cancel()` on the other when entering a new mode), so a
         * simple "whichever isActive" check is unambiguous. */
        isBuildModeActive: () =>
          !!buildModeCtl?.isActive() || !!stationBuildModeCtl?.isActive(),
        onBuildConfirm: () => {
          if (stationBuildModeCtl?.isActive()) stationBuildModeCtl.confirm();
          else buildModeCtl?.confirm();
        },
        onBuildCancel: () => {
          if (stationBuildModeCtl?.isActive()) stationBuildModeCtl.cancel();
          else buildModeCtl?.cancel();
        },
        onBuildRotate: (radians) => {
          if (stationBuildModeCtl?.isActive()) stationBuildModeCtl.rotateBy(radians);
          else buildModeCtl?.rotateBy(radians);
        },
        /* Camera-lock + combat (Phase 1.5 — see §12 + §13). */
        isCameraLocked: () => !!cameraLockCtl?.isActive(),
        onCameraLockToggle: () => { cameraLockCtl?.toggle(); },
        onLockOnToggle: () => { lockOnCtl?.toggle(); },
        onTorchToggle: () => { store.toggleTorchEquipped(); },
        onCombatModeToggle: () => { store.toggleCombatMode(); },
        onHotbarUse: (slotIdx) => { store.useHotbarSlot(slotIdx); },
        onCombatLMB: () => { combatHandle?.onLMB(); },
        onCombatRMB: {
          down: () => { combatHandle?.onRMBDown(); },
          up: () => { combatHandle?.onRMBUp(); },
        },
        /* Collision-resolved player movement (Phase 1.5). The player's footprint is
         * registered with the collision world by `mountApp` below so it's excluded
         * from its own move resolution. */
        ...(collisionWorld ? { collisionWorld } : {}),
        playerCollisionOwnerId: 'player',
        playerCollisionRadius: 0.4,
        /* Phase 8l — bouncy mushroom landing intercept. When the landing branch
         * detects the surface the player just touched is a mushroom (owner-id
         * prefix `mushroom:`), this callback fires; the bouncy-mushroom handle
         * applies the squash + chain-bonus + boosted-bounce gating and returns
         * the upward kick velocity. Returns null when the mushroom is mid-respawn
         * — controls fall through to the standard landing path then. */
        mushroomBounce: (ownerId, impactSpeed, jumpHeld) =>
          bouncyMushroomsHandle?.onPlayerLanded(ownerId, impactSpeed, jumpHeld) ?? null,
      });
      /* Register the player's own circle footprint so other moving entities (mobs)
       * collide-resolve around the player. The player's own move-resolution excludes
       * this owner id via `playerCollisionOwnerId` above so it doesn't push itself.
       * The player's vertical extent (feet -> head) is set so other entities' Y-aware
       * resolvers can decide whether they're on the player's level. */
      if (collisionWorld) {
        const px = h.avatar.position.x;
        const pz = h.avatar.position.z;
        const py = h.avatar.position.y;
        collisionWorld.register({
          kind: 'circle',
          x: px, z: pz, r: 0.4,
          ownerId: 'player',
          blocking: true,
          tag: 'player',
          bottomY: py,
          topY: py + 1.8,
        });
      }
      /* Wire the dock's foot-snap to the controls' last-grounded surface Y, so
       * standing on a foundation / floor / stair / rock keeps avatar.y at the
       * surface top instead of being yanked back down to terrain every frame.
       * Cleared in the !awakened branch below by passing `null`. */
      scenePreview.setSurfaceYProvider(() => freeRoamHandle?.getGroundedSurfaceY() ?? null);
      /* Dock-forest collision footprints are registered by the dock-forest
       * harvestables InstancedMesh scene itself (see
       * `attachDockForestHarvestables` in [src/world/dockForestHarvestables.ts]).
       * Same module owns register-on-attach + unregister-on-break + re-register-
       * on-respawn so collision and visual stay in lockstep. Eager-attach here so
       * the footprints exist from frame 1 of awakened mode (without it the
       * collision world would be empty until the per-frame lazy-attach below
       * fires next tick — a 1-frame window where the player could walk through
       * trees on awakened entry). */
      ensureDockForestAttached();
      /* Phase 1.5 default-locked UX — entering awakened mode auto-engages camera-lock
       * so the player is combat-ready from frame 1 (no Q-toggle needed). The pointer-
       * lock request requires a user-gesture context; entering awakened mode is itself
       * the result of a click (Break the Spell button OR realm toggle), so the gesture
       * is fresh. If the browser refuses, the player can still press Q manually. */
      maybeAutoLockCameraForAwakened();
    } else if (!awakened && freeRoamHandle) {
      /* Clear any held WASD/jump keys before tearing down so the dock's auto-routing
       * (which is about to re-engage) starts from a clean input state. */
      freeRoamHandle.clearKeys();
      freeRoamHandle.detach();
      freeRoamHandle = null;
      /* Drop the surface-Y provider so the dock's foot-snap goes back to its
       * pure terrain-only path in deck mode. */
      scenePreview.setSurfaceYProvider(null);
      hideAwakenedMenuOverlay();
      /* Phase 1.5 — flip back to deck wipes the awakened-mode runtime: cancel build
       * mode, release camera lock, drop lock-on target, clear mob roster (mobs are
       * runtime-only — they reset every awakened session by design).
       *
       * IMPORTANT: explicitly call `clearAll()` on each visual handle. Their per-frame
       * `update()` methods only fire while `realmMode === 'awakened'`, so without
       * explicit cleanup the rendered mob LPCAs would freeze in place, the ward
       * bubble would stay visible attached to the avatar, and stale damage floaters
       * would linger over the deck UI after the flip. */
      buildModeCtl?.cancel();
      stationBuildModeCtl?.cancel();
      cameraLockCtl?.deactivate();
      lockOnCtl?.toggle(); /* no-op if not active */
      store.clearAwakenedMobs();
      mobsHandle?.clearAll();
      defensiveWardHandle?.setActive(false);
      damageFloatersHandle?.clearAll();
      /* Bouncy mushrooms — soft reset (`clearAll`), NOT full dispose. The
       * handle stays attached across realm flips for the same reason
       * `mobsHandle` does: re-creating it would re-run the seed-derived
       * scatter + per-mushroom material build, and any one-shot path that
       * forgot to call `ensureCabinAttached` after the dispose (e.g.
       * permadeath → respawn → break-spell-again, where `harvestNodesAttachAttempted`
       * has latched true and skips re-attach) would land the player in a
       * mushroom-less world. `clearAll` resets every mushroom back to mature
       * (full HP, footprint re-registered, drips at rest) so the next
       * awakened entry feels fresh without the dispose/re-attach race. */
      bouncyMushroomsHandle?.clearAll();
      /* The dock-forest InstancedMesh scene STAYS attached across realm flips —
       * trees + collision footprints persist so the player sees the same forest
       * silhouette in both modes. Only the awakened-mode interaction (E-press +
       * per-frame animation update) gates on `realmMode === 'awakened'`. The
       * handle's `update` simply isn't called from deck mode. */
    }
  }
  /* Trigger initial check so an existing 'awakened' save lands with controls already wired.
   * GATED: same gate as the subscriber call above — defer until adoption finishes
   * so the awakened path doesn't fire `ensureDockForestAttached` before mountApp
   * has had a chance to slot the prebuilt handles into local vars (which would
   * cause a duplicate BatchedMesh attach → ghost meshes during harvest). */
  if (dockHandlesAdoptedOrConfirmedUnavailable) {
    ensureFreeRoamMatchesRealm();
  } else {
    realmMatchDeferred = true;
  }

  /* Mode-aware nav: in 'awakened' mode, hide the deck-mode tabs (gather/craft/inventory/
   * decks/idle/rpg/battle/hire/portal). The Awakening tab stays visible — it's the player's
   * "you have woken" indicator and lets them step back to the deck via the Return button.
   * Tab key opens the menu overlay (mounted lazily) which floats the deck tabs above the
   * 3D world for one-shot use. */
  const DECK_TABS: Page[] = [
    'gather', 'craft', 'inventory', 'decks', 'idle', 'rpg', 'battle', 'hire', 'portal',
  ];
  function applyRealmModeToNav(): void {
    const awakened = store.getRealmMode() === 'awakened';
    nav.querySelectorAll<HTMLButtonElement>('button[data-nav-page]').forEach((btn) => {
      const id = btn.dataset.navPage as Page;
      if (DECK_TABS.includes(id)) {
        btn.style.display = awakened ? 'none' : '';
      }
    });
    /* Hide the reset button in awakened mode too — it lives next to Hire which is hidden. */
    nav.querySelectorAll<HTMLButtonElement>('button.nav-reset-btn').forEach((btn) => {
      btn.style.display = awakened ? 'none' : '';
    });
  }

  /* ---------- Awakened-mode central panel (Tab key) ----------
   * Single overlay that switches between two views:
   *   - 'menu': the central hub of buttons (Inventory, Craft, Decks, Idle, RPG, Hire,
   *     Awakening, Portal). One click → switches view to that page.
   *   - <pageId>: full deck-page rendered inside the overlay body using the same
   *     `renderInventory` / `renderCraft` / etc. functions deck mode uses. A "← Menu"
   *     button returns to the hub; the X closes the overlay entirely.
   * Tab key always toggles the overlay (open from world, close from any view).
   * ESC remains the system menu (unchanged). */
  /**
   * `'build'` is awakened-only — opens the cabin-piece placement picker. The other
   * views are existing app `Page` ids that re-render the deck-mode page inside the
   * awakened overlay.
   */
  type AwakenedPanelView = 'menu' | Page | 'build';
  /* Caravan: routes to the 'gather' page which carries the wandering-merchant panel
   * (sell surplus + browse special stock). The deck-mode "manual gather buttons" on
   * that page still work for players who want to gather from the menu instead of
   * walking the world — but the awakened use case is primarily merchant trade.
   * Build: awakened-only — opens the cabin placement picker. Doesn't route to a Page. */
  const AWAKENED_MENU_ITEMS: { id: Page | 'build'; label: string; tone?: 'awakening' }[] = [
    { id: 'inventory', label: 'Inventory' },
    { id: 'craft', label: 'Craft' },
    { id: 'build', label: 'Build' },
    { id: 'decks', label: 'Decks' },
    { id: 'idle', label: 'Idle' },
    { id: 'rpg', label: 'RPG' },
    { id: 'hire', label: 'Hire' },
    { id: 'gather', label: 'Caravan' },
    { id: 'awakening', label: 'Awakening', tone: 'awakening' },
  ];
  let awakenedOverlayEl: HTMLElement | null = null;
  let awakenedOverlayBodyEl: HTMLElement | null = null;
  let awakenedPanelView: AwakenedPanelView = 'menu';

  /**
   * Render only the panel body — the title bar, back button, X, and chrome stay in place.
   * Used both on initial open AND on store emits while a page view is open. Cheap re-render
   * (~one DOM node tree replaced); doesn't blow focus or scroll on the chrome.
   */
  function renderAwakenedPanelBody(view: AwakenedPanelView): void {
    if (!awakenedOverlayBodyEl) return;
    /* Save current scroll so re-render doesn't jump the panel when state changes. */
    const scrollY = awakenedOverlayBodyEl.scrollTop;
    awakenedOverlayBodyEl.innerHTML = '';
    if (view === 'menu') {
      /* Vitals strip — visible above the menu hub so the player can check HP / Hunger /
       * Thirst / Mana at a glance every time they open the Tab menu. */
      const vitalsEl = document.createElement('div');
      vitalsEl.className = 'awakened-menu-vitals';
      vitalsEl.innerHTML = renderAwakenedVitalsRow(store.getState(), store.getEffectiveMaxMana());
      awakenedOverlayBodyEl.appendChild(vitalsEl);
      const grid = document.createElement('div');
      grid.className = 'awakened-menu-grid';
      AWAKENED_MENU_ITEMS.forEach((it) => {
        if (it.id === 'awakening' && !store.getAwakeningVisible()) return;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'awakened-menu-item';
        if (it.tone === 'awakening') b.classList.add('awakened-menu-item--awakening');
        b.textContent = it.label;
        b.addEventListener('click', () => {
          /* 'build' is awakened-only — no Page mapping; just open the placement picker
           * inside the overlay. All other items are existing Page ids that re-render
           * inside the awakened overlay AND set pageContext on the dock. */
          if (it.id !== 'build') setPage(it.id as Page);
          openAwakenedPanel(it.id);
        });
        grid.appendChild(b);
      });
      awakenedOverlayBodyEl.appendChild(grid);
    } else {
      const s = store.getState();
      /* Vitals strip — visible above every page so the player can monitor HP / Hunger /
       * Thirst / Mana while trading or managing inventory in fullscreen awakened mode.
       * Re-rendered per emit alongside the page body (cheap; ~4 div writes). */
      const vitalsEl = document.createElement('div');
      vitalsEl.className = 'awakened-menu-vitals';
      vitalsEl.innerHTML = renderAwakenedVitalsRow(s, store.getEffectiveMaxMana());
      awakenedOverlayBodyEl.appendChild(vitalsEl);
      switch (view) {
        case 'gather': renderGather(awakenedOverlayBodyEl, s); break;
        case 'inventory': renderInventory(awakenedOverlayBodyEl, s); break;
        case 'craft': renderCraft(awakenedOverlayBodyEl, s); break;
        case 'decks': renderDecks(awakenedOverlayBodyEl, s); break;
        case 'idle': renderIdle(awakenedOverlayBodyEl, s); break;
        case 'rpg': renderRpg(awakenedOverlayBodyEl, s); break;
        case 'hire': renderHire(awakenedOverlayBodyEl, s); break;
        case 'awakening': renderAwakening(awakenedOverlayBodyEl, store); break;
        case 'build': renderBuildPanel(awakenedOverlayBodyEl); break;
        default:
          awakenedOverlayBodyEl.innerHTML = `<p class="awakened-menu-hint">${prettyPageLabel(view as Page)} is not available in awakened mode.</p>`;
          break;
      }
    }
    awakenedOverlayBodyEl.scrollTop = scrollY;
  }

  function openAwakenedPanel(view: AwakenedPanelView): void {
    /* If a different view is already open, rebuild the chrome (title text + back button
     * presence change). If same view is open, only refresh the body. */
    if (awakenedOverlayEl && awakenedPanelView === view) {
      renderAwakenedPanelBody(view);
      return;
    }
    if (awakenedOverlayEl) {
      awakenedOverlayEl.remove();
      awakenedOverlayEl = null;
      awakenedOverlayBodyEl = null;
    }
    awakenedPanelView = view;
    /* Defensive: cancel any in-flight dock camera drag so a stuck drag-state from before
     * the overlay opened can't keep applying yaw/pitch deltas after the player closes. */
    scenePreview.cancelCameraDrag();
    const overlay = document.createElement('div');
    overlay.className = `awakened-menu-overlay ${view === 'menu' ? '' : 'awakened-menu-overlay--page'}`;
    overlay.innerHTML = `
      <div class="awakened-menu-card ${view === 'menu' ? '' : 'awakened-menu-card--page'}">
        <header class="awakened-menu-header">
          ${view === 'menu' ? '' : '<button type="button" class="awakened-menu-back" aria-label="Back to menu">←&nbsp;Menu</button>'}
          <h2>${view === 'menu' ? 'Reflect' : view === 'build' ? 'Build' : prettyPageLabel(view)}</h2>
          <button type="button" class="awakened-menu-close" aria-label="Close">×</button>
        </header>
        ${view === 'menu' ? '<p class="awakened-menu-hint">The dream-prison\u2019s tools are still yours. Use them, then press <kbd>Tab</kbd> or close to return to the world.</p>' : ''}
        <div class="awakened-menu-body"></div>
      </div>
    `;
    awakenedOverlayBodyEl = overlay.querySelector<HTMLElement>('.awakened-menu-body')!;
    overlay.querySelector('.awakened-menu-close')!.addEventListener('click', hideAwakenedMenuOverlay);
    const backBtn = overlay.querySelector<HTMLButtonElement>('.awakened-menu-back');
    if (backBtn) backBtn.addEventListener('click', () => openAwakenedPanel('menu'));
    /* Click-outside-card closes (only on menu view; avoid losing in-progress edits on pages). */
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay && awakenedPanelView === 'menu') hideAwakenedMenuOverlay();
    });
    awakenedOverlayEl = overlay;
    shell.appendChild(overlay);
    renderAwakenedPanelBody(view);
    /* Opening the awakened menu (any view — menu hub, Build, Inventory, …) is a
     * "leave build mode" event. Drop any active ghost so the player isn't left
     * with an invisible-behind-the-overlay floating ghost; if they want to
     * resume, they re-pick a kind from the Build picker which calls
     * `enter()` fresh. Same applies to navigating between sub-tabs (each tab
     * change is another `openAwakenedPanel(view)` call so this hook covers
     * BOTH Tab-open and intra-menu nav). */
    buildModeCtl?.cancel();
    stationBuildModeCtl?.cancel();
    /* Clear any held WASD/jump keys — focus moves into the overlay. */
    if (freeRoamHandle) freeRoamHandle.clearKeys();
    /* Auto-release camera-lock so the cursor is free to click menu items (Phase 1.5
     * default-locked UX — opening any menu unlocks; closing re-locks). */
    if (cameraLockCtl?.isActive()) cameraLockCtl.deactivate();
  }
  function toggleAwakenedMenuOverlay(): void {
    if (awakenedOverlayEl) {
      hideAwakenedMenuOverlay();
    } else {
      openAwakenedPanel('menu');
    }
  }
  function hideAwakenedMenuOverlay(): void {
    if (!awakenedOverlayEl) return;
    awakenedOverlayEl.remove();
    awakenedOverlayEl = null;
    awakenedOverlayBodyEl = null;
    awakenedPanelView = 'menu';
    /* Defensive cleanup so the dock returns to clean state — clears any drag in flight,
     * any held WASD keys, and any stuck pointer capture from before the overlay opened. */
    scenePreview.cancelCameraDrag();
    if (freeRoamHandle) freeRoamHandle.clearKeys();
    /* Auto-relock the camera when closing the menu — awakened mode's default state is
     * locked-and-combat-ready (Phase 1.5 UX revision). The menu overlay opening was the
     * thing that released the lock; closing it returns to the default. */
    maybeAutoLockCameraForAwakened();
  }

  /**
   * Awakened-mode camera-lock UX (Phase 1.5 revision — was Q-toggle, now auto-locked
   * by default). The camera stays locked unless ONE of these is true:
   *   - The Tab menu overlay (`awakenedOverlayEl`) is open.
   *   - The system menu (Esc) is open.
   *   - Build mode is active (build mode owns the cursor through the ghost preview).
   * Otherwise we engage the lock so the player is always combat-ready in the world.
   * Q toggle still WORKS for power users (they can manually unlock for screenshots /
   * exploration); auto-lock just kicks in on every "neutral" transition.
   */
  function maybeAutoLockCameraForAwakened(): void {
    if (store.getRealmMode() !== 'awakened') return;
    if (awakenedOverlayEl) return; /* menu open → don't lock (cursor needed for clicks) */
    if (buildModeCtl?.isActive()) return; /* build mode owns its own lock state */
    /* Defer to a microtask (not rAF): `requestAnimationFrame` runs in the next frame,
     * after transient user activation from the click that closed the menu is gone, so
     * `requestPointerLock()` rejects with NotAllowedError and surfaces as an uncaught
     * promise rejection. Microtasks still run before the task ends, preserving the
     * gesture for a settled re-lock after any synchronous `pointerlockchange` from the
     * menu-open path. */
    queueMicrotask(() => {
      if (!cameraLockCtl || cameraLockCtl.isActive()) return;
      cameraLockCtl.toggle();
    });
  }
  function prettyPageLabel(p: Page): string {
    if (p === 'rpg') return 'RPG';
    /* The 'gather' page is reached via the awakened menu's "Caravan" entry — show the
     * trade-themed label in the panel chrome to match (the merchant panel is the primary
     * use case in awakened mode; manual gather buttons stay below as a fallback). */
    if (p === 'gather') return 'Caravan';
    return p.charAt(0).toUpperCase() + p.slice(1);
  }

  /* ---------- Awakened-mode Build panel (Phase 1 — cabin pieces + material tiers) ---------- */

  /**
   * MVP set of cabin piece kinds for the Phase 1 build picker. The other kinds in
   * `CabinPieceKind` are intentionally hidden from the UI until their LPCA art passes
   * Phase 1.5 polish (see `BASE_BUILDING_AND_SURVIVAL_PLAN.md`).
   */
  const BUILD_PANEL_KINDS: { id: CabinPieceKind; label: string; hint: string }[] = [
    { id: 'foundation', label: 'Foundation', hint: 'Place first; needs flat ground.' },
    { id: 'wall_solid', label: 'Wall', hint: 'Stacks on foundation or wall below.' },
    { id: 'wall_window', label: 'Wall (window)', hint: 'Same as wall, with a window cutout.' },
    { id: 'wall_doorway', label: 'Wall (doorway)', hint: 'Opening for a door piece.' },
    { id: 'door', label: 'Door', hint: 'Snaps into a wall_doorway.' },
    { id: 'floor', label: 'Floor', hint: 'Sits on top of a foundation.' },
    { id: 'roof_slope', label: 'Roof slope', hint: 'Snaps to wall tops.' },
  ];

  function formatCostLine(cost: Record<string, number>): string {
    return Object.entries(cost)
      .map(([k, q]) => `${q} × ${k.replace(/_/g, ' ')}`)
      .join('  ·  ');
  }

  function renderBuildPanel(host: HTMLElement): void {
    const s = store.getState();
    const wrapper = document.createElement('div');
    wrapper.className = 'awakened-build-panel';
    wrapper.innerHTML = `
      <p class="awakened-menu-hint">
        Pick a piece + material tier, then press <strong>Place</strong>. The ghost
        preview appears in the world — <kbd>R</kbd> rotates 90°, mouse wheel rotates
        15°, <kbd>E</kbd> confirms, <kbd>Esc</kbd> cancels. Build mode stays active
        after each placement so you can stack walls in a row.
      </p>
    `;
    BUILD_PANEL_KINDS.forEach((kindDef) => {
      const block = document.createElement('div');
      block.className = 'awakened-build-kind';
      const headRow = document.createElement('div');
      headRow.className = 'awakened-build-kind__head';
      const label = document.createElement('h3');
      label.textContent = kindDef.label;
      const hint = document.createElement('p');
      hint.className = 'awakened-build-kind__hint';
      hint.textContent = kindDef.hint;
      headRow.appendChild(label);
      headRow.appendChild(hint);
      block.appendChild(headRow);

      const tierRow = document.createElement('div');
      tierRow.className = 'awakened-build-tier-row';
      CABIN_TIER_ORDER.forEach((tier) => {
        const cost = cabinPieceCost(kindDef.id, tier);
        const maxHp = cabinPieceMaxHp(kindDef.id, tier);
        const unlockCard = CABIN_TIER_UNLOCK_CARD[tier];
        const unlocked = !unlockCard || s.unlockedCardIds.includes(unlockCard);
        const affordable = unlocked &&
          Object.entries(cost).every(([k, q]) => (s.inventory[k] ?? 0) >= q);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'awakened-build-tier-btn';
        if (!unlocked) btn.classList.add('awakened-build-tier-btn--locked');
        else if (!affordable) btn.classList.add('awakened-build-tier-btn--poor');
        btn.disabled = !unlocked || !affordable;
        btn.innerHTML = `
          <span class="awakened-build-tier-btn__name">${CABIN_TIER_LABEL[tier]}</span>
          <span class="awakened-build-tier-btn__hp">${maxHp} HP</span>
          <span class="awakened-build-tier-btn__cost">${formatCostLine(cost)}</span>
          ${!unlocked ? `<span class="awakened-build-tier-btn__lock">Unlock: ${unlockCard}</span>` : ''}
        `;
        btn.addEventListener('click', () => {
          if (!buildModeCtl) return;
          /* Mutual exclusion: cancel any in-flight station ghost so only one
           * build mode is active at a time. The input dispatcher's
           * "whichever isActive" routing relies on this invariant. */
          stationBuildModeCtl?.cancel();
          buildModeCtl.enter(kindDef.id, tier);
          /* Close the menu so the player can see the ghost in the world. The ghost
           * stays + auto-rebuilds after each successful E confirm; player presses Esc
           * (or Tab, which re-opens the menu) when they're done. */
          hideAwakenedMenuOverlay();
        });
        tierRow.appendChild(btn);
      });
      block.appendChild(tierRow);
      wrapper.appendChild(block);
    });
    /* ---- Stations sub-section (Phase 2 — multi-instance placement) ----
     *
     * Renders a flat row of station cards (campfire / workbench / forge /
     * kitchen) below the cabin pieces. Each card shows the kind name, max HP,
     * and material cost; click enters station-build mode + closes the menu so
     * the ghost is visible in the world. Affordability + locked state mirror
     * the cabin-piece block; locked stations are greyed with the unlock-card
     * tooltip. Forge and kitchen render as placeholder boxes (kind LPCAs not
     * built yet) so players can see + test placement without waiting on art. */
    renderStationsSubsection(wrapper, s);
    host.appendChild(wrapper);
  }

  /**
   * Build picker entries for craft stations. Forge / kitchen unlock requirements
   * mirror the dream-mode recipe cards in `data/content.ts` so the awakened
   * picker exposes the same gating the player already learned in dream mode.
   */
  const STATION_PANEL_KINDS: {
    id: PlacedCraftStationKind;
    label: string;
    hint: string;
    /** Card id required to unlock; null = always available. */
    unlockCard: string | null;
  }[] = [
    {
      id: 'campfire',
      label: 'Campfire',
      hint: 'Drop a fire anywhere — cook + warm camp.',
      unlockCard: 'c_card_campfire_blueprint',
    },
    {
      id: 'workbench',
      label: 'Workbench',
      hint: 'Place a workbench for refined crafts.',
      unlockCard: 'c_card_workbench_blueprint',
    },
    {
      id: 'forge',
      label: 'Forge (placeholder)',
      hint: 'Smelt ore. LPCA art pending — placeholder box for now.',
      unlockCard: 'c_card_forge_blueprint',
    },
    {
      id: 'kitchen',
      label: 'Kitchen (placeholder)',
      hint: 'Cook complex meals. LPCA art pending — placeholder box.',
      unlockCard: null,
    },
  ];

  function renderStationsSubsection(host: HTMLElement, s: ReturnType<GameStore['getState']>): void {
    const sectionHeader = document.createElement('h3');
    sectionHeader.className = 'awakened-build-section-header';
    sectionHeader.textContent = 'Stations';
    host.appendChild(sectionHeader);
    const sectionHint = document.createElement('p');
    sectionHint.className = 'awakened-menu-hint';
    sectionHint.textContent = 'Place a fire / bench / forge / kitchen anywhere on the map. Same controls — R rotates, LMB confirms, Esc cancels.';
    host.appendChild(sectionHint);

    const row = document.createElement('div');
    row.className = 'awakened-build-tier-row';
    STATION_PANEL_KINDS.forEach((stationDef) => {
      const cost = store.craftStationCost(stationDef.id);
      const maxHp = store.craftStationMaxHp(stationDef.id);
      const unlocked = !stationDef.unlockCard || s.unlockedCardIds.includes(stationDef.unlockCard);
      const affordable = unlocked &&
        Object.entries(cost).every(([k, q]) => (s.inventory[k] ?? 0) >= q);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'awakened-build-tier-btn';
      if (!unlocked) btn.classList.add('awakened-build-tier-btn--locked');
      else if (!affordable) btn.classList.add('awakened-build-tier-btn--poor');
      btn.disabled = !unlocked || !affordable;
      btn.title = stationDef.hint;
      btn.innerHTML = `
        <span class="awakened-build-tier-btn__name">${stationDef.label}</span>
        <span class="awakened-build-tier-btn__hp">${maxHp} HP</span>
        <span class="awakened-build-tier-btn__cost">${formatCostLine(cost)}</span>
        ${!unlocked && stationDef.unlockCard ? `<span class="awakened-build-tier-btn__lock">Unlock: ${stationDef.unlockCard}</span>` : ''}
      `;
      btn.addEventListener('click', () => {
        if (!stationBuildModeCtl) return;
        /* Mutual exclusion — cancel any in-flight cabin ghost. */
        buildModeCtl?.cancel();
        stationBuildModeCtl.enter(stationDef.id);
        hideAwakenedMenuOverlay();
      });
      row.appendChild(btn);
    });
    host.appendChild(row);
  }

  /**
   * Inline 4-meter strip rendered above every awakened-menu page (and the hub menu) so
   * the player can monitor vitals while trading / managing inventory in fullscreen mode.
   * Mirrors the `awakenedHotbar` bar palette (HP red, Mana cyan, Hunger amber, Thirst
   * blue) so the menu view feels visually continuous with the always-on hotbar strip.
   */
  function renderAwakenedVitalsRow(
    s: ReturnType<GameStore['getState']>,
    maxMana: number,
  ): string {
    const hpPct = Math.max(0, Math.min(100, (s.playerHp / Math.max(1, s.playerMaxHp)) * 100));
    const manaPct = Math.max(0, Math.min(100, (s.mana / Math.max(1, maxMana)) * 100));
    const hungerPct = Math.max(0, Math.min(100, s.hunger));
    const thirstPct = Math.max(0, Math.min(100, s.thirst));
    return `
      <div class="awakened-menu-vital awakened-menu-vital--hp" title="Health">
        <span class="awakened-menu-vital__label">HP</span>
        <span class="awakened-menu-vital__track"><span class="awakened-menu-vital__fill" style="width:${hpPct}%"></span></span>
        <span class="awakened-menu-vital__value">${Math.ceil(s.playerHp)}/${s.playerMaxHp}</span>
      </div>
      <div class="awakened-menu-vital awakened-menu-vital--mana" title="Mana">
        <span class="awakened-menu-vital__label">Mana</span>
        <span class="awakened-menu-vital__track"><span class="awakened-menu-vital__fill" style="width:${manaPct}%"></span></span>
        <span class="awakened-menu-vital__value">${Math.floor(s.mana)}/${Math.floor(maxMana)}</span>
      </div>
      <div class="awakened-menu-vital awakened-menu-vital--hunger" title="Food">
        <span class="awakened-menu-vital__label">Food</span>
        <span class="awakened-menu-vital__track"><span class="awakened-menu-vital__fill" style="width:${hungerPct}%"></span></span>
        <span class="awakened-menu-vital__value">${Math.round(hungerPct)}</span>
      </div>
      <div class="awakened-menu-vital awakened-menu-vital--thirst" title="Water">
        <span class="awakened-menu-vital__label">Water</span>
        <span class="awakened-menu-vital__track"><span class="awakened-menu-vital__fill" style="width:${thirstPct}%"></span></span>
        <span class="awakened-menu-vital__value">${Math.round(thirstPct)}</span>
      </div>
    `;
  }

  let last = performance.now();
  let harvestNodesAttachAttempted = false;
  function frame(now: number): void {
    const dt = now - last;
    last = now;
    store.tick(dt);
    /* === 2026-04-20 Tier D — cache realmMode for the frame ===
     *
     * Was 5× `store.getRealmMode()` calls per frame (lines 4352, 4358,
     * 4365, 4373, 4449). Each call enters a method, reads the state,
     * compares the string. Cheap individually but free to consolidate.
     * Cached at frame top so all five branches read the same value —
     * also avoids the (tiny but real) chance that a store emit between
     * the calls flips the value mid-frame and produces inconsistent
     * branching (e.g. build-mode update ran but mob update didn't). */
    const isAwakened = store.getRealmMode() === 'awakened';
    /* Worker renders the visible dock in both deck (dream) and awakened realms.
     * Main keeps a `PerspectiveCamera` + `avatar` proxy for raycasts, HUD, and
     * `resolveReticleAim` — they must track SAB every frame in BOTH modes. Gating
     * this on `isAwakened` left dream-mode with a stale camera vs the legacy
     * `CharacterScenePreview` rAF, which updated continuously. */
    if (activeDockWorkerHost) {
      const syncH = ensureCachedHandles();
      if (syncH) {
        const sab = activeDockWorkerHost.sharedState;
        syncH.avatar.position.set(sab.getAvatarX(), sab.getAvatarY(), sab.getAvatarZ());
      }
      fillPerspectiveCameraFromSharedState(activeDockWorkerHost.sharedState, scenePreview.camera);
    }
    /* Awakened-mode WASD integration. Cheap when not active (early-return in update). */
    if (freeRoamHandle) {
      freeRoamHandle.update(dt / 1000);
      /* Tell the dock whether the player is mid-jump so its per-frame foot-snap doesn't
       * cancel the jump's vertical velocity. The dock checks this AND `awakenedFreeRoam`
       * before snapping. */
      scenePreview.setFreeRoamAirborne(freeRoamHandle.isAirborne());
    }
    /* Co-op awakened: stream world pose (~server presence cap) so peers render LPCA ghosts smoothly. */
    if (isAwakened) {
      const st = store.getState();
      if (st.onlineSession && st.gameMode === 'coop' && getRoomHub().getState() === 'open') {
        const now = performance.now();
        if (now - lastAwakenCoopPresenceMs >= 88) {
          lastAwakenCoopPresenceMs = now;
          sendOnlinePresence();
        }
      }
    }
    /* Free-roam harvest nodes + cabin builder + dock-forest BatchedMesh — attach
     * lazily after first frame (gives the dock scene graph a chance to settle), then
     * update visibility + reposition the "Press E" prompt each frame when in
     * awakened mode. The cabin builder also gets a per-frame `buildModeCtl.update`
     * call to advance the ghost preview.
     *
     * Dock-forest is attached HERE (not inside the awakened block) so the forest
     * fills in IMMEDIATELY in dream mode too — fixes the "dream is scarce until
     * I awaken once" bug. The handle's harvest E-press is still gated on awakened
     * mode by the input handler; only the visual + collision is unconditional. */
    if (!harvestNodesAttachAttempted) {
      harvestNodesAttachAttempted = true;
      try {
        ensureHarvestNodesAttached();
        /* Awakened stack is attached during mount (forging veil). Only call
         * `ensureCabinAttached` here if cabin/station are still missing
         * (preload-fallback path). */
        if (!cabinHandle || !craftStationHandle) {
          ensureCabinAttached();
        }
        ensureDockForestAttached();
      } catch {
        /* Scene preview not ready yet — try again next frame. */
        harvestNodesAttachAttempted = false;
      }
    }
    /* Per-frame: advance any in-flight fall / crumble / collapse animations and process
     * respawn timers. Cheap when no animations are active (single Set+empty-loop check). */
    if (harvestHandle) harvestHandle.update(dt / 1000);
    /* Per-frame: advance the build-mode ghost preview if active. The controller
     * early-returns when not active so this is essentially free in non-build flows. */
    if (buildModeCtl && buildModeCtl.isActive() && isAwakened) {
      /* GoE-style center-ray cursor: the controller raycasts NDC (0,0) through the
       * scene preview's camera each frame to find the world placement target. No
       * explicit avatar/forward args needed — the camera carries everything. */
      buildModeCtl.update(scenePreview.camera);
    }
    if (stationBuildModeCtl && stationBuildModeCtl.isActive() && isAwakened) {
      stationBuildModeCtl.update(scenePreview.camera);
    }
    /* Campfire flame / ember animation for placed stations. Cheap when no
     * campfires are placed (early-return on empty Map). Runs in awakened mode
     * only — deck-mode dock-yard campfire keeps its existing tick path inside
     * `characterScenePreview`. */
    if (craftStationHandle && isAwakened) {
      craftStationHandle.tick(now / 1000);
    }
    /* Phase 1.5 awakened systems — all tick in awakened mode only. Order matters:
     * mobs.update() advances AI + player damage; lockOn.update() drops dead targets +
     * lerps camera; cameraLock.update() integrates mouse-look deltas (last so mouselook
     * is applied on top of lock-on nudge; worker dock uses an in-frame orbit scratch
     * so both compose before one setCameraYawPitch to the render worker);
     * projectiles.update() integrates flight + collision. */
    if (isAwakened) {
      let workerOrbitAtFrameStart: { yaw: number; pitch: number } | null = null;
      if (activeDockWorkerHost) {
        /* The worker rAF can run between the frame-top `fillPerspectiveCamera` and this
         * block. `lockOn` mixes `camera.getWorldDirection()` (from full SAB pose) with
         * `getCameraYawPitch` (dock orbit scalars) — if those reads straddle a worker
         * tick, the lock-on nudge fights the real view and the camera feels stuck or
         * jittery. Re-read SAB + refill in one synchronous slice, then init the scratch. */
        const sab = activeDockWorkerHost.sharedState;
        fillPerspectiveCameraFromSharedState(sab, scenePreview.camera);
        const yaw = sab.getDockOrbitYaw();
        const pitch = sab.getDockOrbitPitch();
        workerOrbitAtFrameStart = { yaw, pitch };
        workerDockOrbitFrame.yaw = yaw;
        workerDockOrbitFrame.pitch = pitch;
      }
      const cachedH = ensureCachedHandles();
      if (cachedH && mobsHandle) {
        /* Pass full 3D player position so mob AI can detect when the player has jumped
         * above the mob (Y-aware reach gate — prevents the "latch" bug where mobs
         * keep applying damage while the player is airborne above them). */
        mobsHandle.update(dt / 1000, {
          x: cachedH.avatar.position.x,
          y: cachedH.avatar.position.y,
          z: cachedH.avatar.position.z,
        });
      }
      if (lockOnCtl) lockOnCtl.update(dt / 1000);
      /* Pointer-lock: accumulate movement into `workerDockOrbitFrame` (worker path) or
       * the preview (main-thread dock). `drainMouseDelta` in the worker only clears
       * the input forwarder buffer — it does not drive the dock camera. */
      if (cameraLockCtl) cameraLockCtl.update();
      if (activeDockWorkerHost && workerOrbitAtFrameStart) {
        const a = workerOrbitAtFrameStart;
        if (
          Math.abs(workerDockOrbitFrame.yaw - a.yaw) > 1e-6
          || Math.abs(workerDockOrbitFrame.pitch - a.pitch) > 1e-6
        ) {
          activeDockWorkerHost.setCameraYawPitch(workerDockOrbitFrame.yaw, workerDockOrbitFrame.pitch);
        }
      }
      if (projectilesHandle) projectilesHandle.update(dt / 1000);
      /* Bouncy-mushroom spring update + respawn-timer tick. Cheap when no
       * mushrooms are bouncing or respawning (per-mushroom early-out for
       * `squash === 0 && squashVel === 0` mature entries). */
      if (bouncyMushroomsHandle) bouncyMushroomsHandle.update(dt / 1000);
      /* Defensive ward — only does anything while active; the per-frame call
       * follows the player + drains mana + auto-disengages if mana runs out. */
      if (defensiveWardHandle && cachedH) {
        defensiveWardHandle.update(
          dt / 1000,
          { x: cachedH.avatar.position.x, y: cachedH.avatar.position.y, z: cachedH.avatar.position.z },
          (amt) => store.useMana(amt),
        );
      }
      /* Damage floaters: cheap when no floaters are active (loops the pool but
       * skips inactive entries on the first branch). Runs in awakened only so
       * deck-mode pays nothing for it. */
      if (damageFloatersHandle) {
        /* Worker dock: `scenePreview.camera` was already filled from SAB at frame top;
         * re-filling a scratch camera here duplicated the same matrix work every frame. */
        damageFloatersHandle.update(dt / 1000, scenePreview.camera);
      }
      /* Update player footprint position (and vertical band) so mobs collide around
       * the player and the Y-aware filter knows the player's current height (e.g.
       * mid-jump avatar.y is well above terrain — short obstacles below should not
       * block other entities pathing under the airborne player).
       *
       * Use `movePosition` (cheap in-place update) instead of `register()` (full
       * unregister + re-add to spatial buckets). `movePosition` only re-buckets when
       * the cell membership actually changes (every ~CELL_SIZE = 4 m of travel),
       * so most frames are essentially free. The initial register on awakened
       * entry seeds the footprint; this call just keeps it current. */
      if (collisionWorld && cachedH) {
        const py = cachedH.avatar.position.y;
        collisionWorld.movePosition(
          'player',
          cachedH.avatar.position.x,
          cachedH.avatar.position.z,
          py,
          py + 1.8,
        );
      }
    }
    /* Dock-forest BatchedMesh lives OUTSIDE the awakened-only block so the forest
     * is visible in DREAM mode too (per the user-reported "dream mode is scarce
     * until awakening fills it in"). The harvest E-press is still gated on awakened
     * mode (the input handler is only attached when awakened), but the visual +
     * collision + per-frame animation/respawn updates run in BOTH modes. Lazy-
     * attached on first frame after scene preview is ready. */
    if (!dockForestHandle) ensureDockForestAttached();
    /* Per-frame: drive fall/crumble/collapse animations and check respawn timers.
     * Runs in BOTH realm modes so respawns continue to fire when the player has
     * gone back to dream mode after harvesting in awakened. Cheap when nothing in
     * flight. */
    if (dockForestHandle) dockForestHandle.update(dt / 1000);
    /* === Magical reticle visibility + mode (always evaluated) ===
     *
     * Lives OUTSIDE the awakened-only block so deck-mode actively HIDES the reticle
     * (instead of leaving it stuck on screen if camera-lock was active when the
     * player switched realms). Visible whenever camera-lock is on AND we're in
     * awakened AND not in build mode (build mode has its own ghost-preview UI;
     * a center crosshair on top would compete for attention). Mode swaps to
     * 'locked' when lockOn is active so the player gets immediate visual feedback
     * that T engaged. setVisible/setMode are no-ops on unchanged values, so calling
     * them every frame is free. */
    if (magicalReticleHandle) {
      const showReticle = isAwakened
        && !!cameraLockCtl?.isActive()
        && !buildModeCtl?.isActive();
      magicalReticleHandle.setVisible(showReticle);
      if (showReticle) {
        magicalReticleHandle.setMode(lockOnCtl?.isActive() ? 'locked' : 'free');
      }
    }
    /* "Press E" prompts are intentionally HIDDEN in awakened mode (2026-04 UX
     * pass). The universal-harvest contract is now: anything visible in the world
     * is harvestable — trees, shrubs, rocks, ore, crystals, corpses, water — and
     * the player learns this once instead of needing a per-target nag prompt.
     * Reticle-pointed harvest (`onInteract` above) routes the press to whatever
     * the crosshair is on, so there's nothing the prompt would tell the player
     * that they can't already see in front of them. The DOM element stays
     * mounted (cheap) but is held hidden so deck mode (which never showed it
     * anyway) keeps its previous behaviour. */
    if (!harvestPromptEl.hidden) {
      harvestPromptEl.hidden = true;
    }
    requestAnimationFrame(frame);
  }
  /* === Eager dock-attach (Phase 8j preload optimization) ===
   *
   * Pull `ensureHarvestNodesAttached` + `ensureCabinAttached` +
   * `ensureDockForestAttached` from "frame 1 of the rAF loop" to RIGHT
   * NOW (before the loop starts) so the first paint already contains the
   * full harvest scatter + cabin pieces + dock-forest batched scene
   * + collision footprints.
   *
   * The user-reported "first frame is a partial world that fills in" was
   * exactly this — backdrop ran in preload but harvest/cabin/forest
   * batched layers ran on the lazy frame-1 path, producing a one-frame
   * pop-in. Eager-attaching here costs the same total work but moves it
   * into the loading veil window where the player can't see the pop.
   *
   * === 2026-04-20 sharded ensure path ===
   *
   * Previously these three calls ran back-to-back synchronously: total
   * ~150-450 ms of contiguous main-thread work where the loading veil's
   * progress bar appeared frozen because no paint frame fit between
   * `p(0.92, ...)` and `p(0.97, ...)`. Now each ensure is followed by a
   * progress update + an `await yieldAnimationFrame()` so the browser
   * gets a paint slot between them — the veil shows real progress
   * (Harvest → Buildings → Forest) and stays interactive in case the
   * player wants to click "skip" / Esc / etc. mid-mount.
   *
   * Wrapped in try/catch so a not-yet-ready scene preview falls back to
   * the legacy lazy-attempt path on the first rAF tick (the
   * `harvestNodesAttachAttempted = false` line restores the retry).
   *
   * === 2026-04-20 extended-preload adoption ===
   *
   * Try to pick up the save-independent handles that `dockExtendedPreload`
   * ran into the offscreen scene during the title screen (collisionWorld,
   * dock-forest BatchedMesh, free-roam harvest scatter, cabin builder +
   * warmed shaders). When present, the ensure* calls below early-return
   * because the handles are already set — post-cutscene mountApp does
   * near-zero heavy attach work. Falls through to the legacy inline-
   * attach path if extended preload was never started or failed. */
  /* Preload adoption: world handles + ward + mushrooms + projectiles are built
   * offscreen during the title flow. `ensureCabinAttached()` still runs during
   * mount to attach store- + shell-coupled controllers (mobs, combat, build modes,
   * floaters, reticle, …); its `if (!handle)` guards skip work already adopted. */
  /* Yield + progress before the prebuilt-handle adoption block — drains the
   * event loop after the long stretch of function definitions / store-subscribe
   * registrations above, and ticks the bar visibly so 94-95% doesn't sit static
   * for the cumulative cost of all that closure-allocation work. Sub-ms drain
   * (`yieldToEventLoop`) is enough — adoption is field assignment + two cheap
   * `syncFromState` calls (each gated on a per-bucket signature inside the
   * handle). No paint frame needed between this and the adoption write. */
  p(0.955, 'Finishing expedition load…');
  await yieldToEventLoop();
  /* === 2026-04-20 unified-preload adoption ===
   *
   * `prebuiltGameplayHandles` was set right at consume time (above) — no
   * separate state machine to query, no race window, no chance of stale
   * cache from Vite HMR. If the unified preload's gameplay-attach phase
   * succeeded, we have everything; if it failed (gameplayHandles is null),
   * the eager init block below runs the inline ensure* fallback. */
  try {
    const prebuilt = prebuiltGameplayHandles;
    if (prebuilt) {
      collisionWorld = prebuilt.collisionWorld;
      harvestHandle = prebuilt.harvestHandle;
      dockForestHandle = prebuilt.dockForestHandle;
      cabinHandle = prebuilt.cabinHandle;
      craftStationHandle = prebuilt.craftStationHandle;
      projectilesHandle = prebuilt.projectilesHandle;
      defensiveWardHandle = prebuilt.defensiveWardHandle;
      bouncyMushroomsHandle = prebuilt.bouncyMushroomsHandle;
      /* Cabin + station: title preload built renderers + warmed shaders
       * but did NOT sync from store (no store ref over there). Sync now —
       * cheap. */
      cabinHandle.syncFromState(store.getPlacedCabinPieces());
      craftStationHandle.syncFromState(store.getPlacedCraftStations());
      syncWorkerDockBuildablesFromStore();
      /* Mirror `ensureHarvestNodesAttached`'s post-attach apply so deck-mode
       * lands with the right metals hidden right away. */
      applyHarvestVisibilityRules();
    }
  } catch {
    /* Defensive — adoption shouldn't throw, but if it does the eager init
     * block below will rebuild any missing handles inline. */
  }
  /* === 2026-04-20 ghost-mesh order-of-operations gate (open) ===
   *
   * Adoption is finished (either successful or failed/unavailable). It's now
   * safe to let `ensureFreeRoamMatchesRealm` run — `dockForestHandle` etc.
   * are either populated from prebuilt OR will be built freshly inline by
   * the eager block below (with no orphan competition because extended
   * preload's atomic-cleanup guarantees the scene is clean on adoption miss).
   *
   * If a previous emit / initial-trigger DEFERRED its realm-match call,
   * fire it once now to catch up — the realm-mode side effects (free-roam
   * controller attach, hotbar mount, awakened HUD) need to apply. */
  dockHandlesAdoptedOrConfirmedUnavailable = true;
  if (realmMatchDeferred) {
    realmMatchDeferred = false;
    ensureFreeRoamMatchesRealm();
  }
  /* Awakened controllers (mobs, combat, lock-on, build modes, floaters, …)
   * are wired during the forging veil via `ensureAwakenedSystemsOnce` below
   * so dream + awakened are both ready as soon as the shell mounts — no
   * background deferred warm. Realm-flip subscription remains a safety net. */
  let awakenedSystemsAttached = false;
  const ensureAwakenedSystemsOnce = async (): Promise<void> => {
    if (awakenedSystemsAttached) return;
    awakenedSystemsAttached = true;
    try {
      ensureCabinAttached();
    } catch {
      /* Scene preview not ready (rare race on very fast realm-flip). */
      awakenedSystemsAttached = false;
    }
  };
  /* When title preload didn't finish: attach cabin + station inline so dream
   * mode shows placements; `ensureAwakenedSystemsOnce` below still runs and
   * builds mobs/combat/etc. Mushrooms + ward are created inside that call if
   * missing. */
  const attachDreamHandlesInline = (): void => {
    if (cabinHandle && craftStationHandle && collisionWorld) return;
    const h = ensureCachedHandles();
    if (!h) throw new Error('scene-not-ready');
    if (!collisionWorld) collisionWorld = getOrCreateSceneCollisionWorld(scenePreview.scene);
    if (!cabinHandle) {
      cabinHandle = attachCabinBuilder({ scene: scenePreview.scene, collisionWorld });
      /* warmShaders uses compileAsync (Three r158+) — non-blocking. */
      cabinHandle.warmShaders(scenePreview.renderer, scenePreview.camera);
      cabinHandle.syncFromState(store.getPlacedCabinPieces());
    }
    if (!craftStationHandle) {
      craftStationHandle = attachCraftStationBuilder({
        scene: scenePreview.scene,
        collisionWorld,
      });
      craftStationHandle.syncFromState(store.getPlacedCraftStations());
    }
    syncWorkerDockBuildablesFromStore();
  };
  try {
    /* Sub-ms drain between ensure* calls — in the happy path each call is a
     * scene-singleton no-op (early-return on `scene.userData.fooHandle`), so
     * waiting a full paint frame between them is pure dead time. The inline-
     * fallback path (rare — extended preload failed) does real attach work,
     * but even there `compileAsync` keeps the GPU compile off the main
     * thread, so `yieldToEventLoop` is correct. */
    p(0.96, 'Hooking harvest scatter…');
    await yieldToEventLoop();
    ensureHarvestNodesAttached();
    p(0.965, 'Calibrating forest collisions…');
    await yieldToEventLoop();
    ensureDockForestAttached();
    /* Dream handles missing — cabin + station only here; awakened stack
     * follows in `ensureAwakenedSystemsOnce`. */
    if (!cabinHandle || !craftStationHandle) {
      p(0.968, 'Forging dream-mode camp…');
      await yieldToEventLoop();
      attachDreamHandlesInline();
    }
    harvestNodesAttachAttempted = true;
  } catch {
    /* Scene preview wasn't quite ready — let the legacy first-frame path
     * try again. Same code path that was running before this eager pass. */
  }
  p(0.969, 'Forging awakened systems…');
  await yieldToEventLoop();
  try {
    await ensureAwakenedSystemsOnce();
  } catch {
    /* `ensureCabinAttached` throws if scene isn't ready — first-frame path retries. */
    awakenedSystemsAttached = false;
  }
  /* Subscribe AFTER the eager block so the listener doesn't fire from any
   * within-mountApp emits before we're set up. Realm-flip safety net if
   * eager attach failed. Self-detaches after first fire. */
  const realmFlipUnsub = store.subscribe(() => {
    if (awakenedSystemsAttached) return;
    if (store.getRealmMode() !== 'awakened') return;
    /* Detach immediately to prevent re-entrance. */
    realmFlipUnsub();
    void ensureAwakenedSystemsOnce();
  });
  /* === 2026-04-22 yieldAnimationFrame removed (cutscene context obsolete) ===
   *
   * Was a 16 ms full-frame wait "to give the dock a frame to be visible
   * before the tutorial mount." That wait was tuned for the
   * post-cutscene-fade boot — without the cutscene, the dock canvas is
   * already painting under the forging veil from the moment
   * `consumePreloadedDock` reparented it. The render loop kicks below at
   * `requestAnimationFrame(frame)`; nothing here needs a paint slot.
   *
   * Prewarm the audio chunk so first combat doesn't pay the gameAudio
   * module-load + parse cost mid-gameplay. Idempotent; fire-and-forget. */
  void prewarmAudioModule();
  requestAnimationFrame(frame);

  window.setInterval(refreshSoft, 600);

  syncPvpVoteOverlay();
  refreshVoicePeers();

  function isOnlinePvpNavLocked(): boolean {
    const st = store.getState();
    const bn = st.battle;
    return (
      !!bn &&
      bn.mode === 'pvp' &&
      st.onlineSession != null &&
      bn.turn !== 'victory' &&
      bn.turn !== 'defeat'
    );
  }

  p(0.97, 'Mounting HUD, pages & tutorial…');
  /* === 2026-04-22 sub-ms drain instead of full-frame wait ===
   *
   * Was `yieldAnimationFrame` (16 ms) "so the dock canvas paints from the
   * cutscene fade before the tutorial dialog lands on top." Without the
   * cutscene, the dock canvas is already painting under the forging veil
   * (started rendering at the `requestAnimationFrame(frame)` call above);
   * the tutorial DOM mounting on top doesn't disturb the canvas. We only
   * need an event-loop drain so input + microtasks get a slice before the
   * synchronous tutorial DOM build. Sub-ms via `MessageChannel`.
   *
   * === 2026-04-20 round-2 renderPage deferral ===
   *
   * `renderPage()` (heavy DOM build: every gather / craft / deck row from
   * the player's full inventory + recipe set, ~50-200 ms on slower devices)
   * was previously awaited synchronously after the tutorial mount, holding
   * the critical path open until it finished. The welcome dialog covers
   * the entire page area on first mount, so the page DOM underneath is
   * invisible until the player dismisses the tutorial.
   *
   * Fix: schedule `renderPage` via `schedulePostTask` (user-blocking) AFTER
   * `p(1, 'Ready')` resolves. The veil's double-rAF fade-out runs in
   * parallel with the page DOM build; player sees the dock + tutorial the
   * same frame the veil clears, gather page fills in within the next 1-2
   * frames behind the dialog. Net cost moved off critical path: ~50-200 ms
   * per boot. */
  await yieldToEventLoop();
  mountTutorial({
    appRoot: root,
    store,
    getPage: () => page,
    setPage: (p) => setPage(p),
    isOnlinePvpNavLocked,
  });
  p(1, 'Ready');
  const fireRenderPage = (): void => {
    try {
      renderPage();
    } catch (err) {
      /* renderPage failure shouldn't strand the boot — log + leave the
       * page empty until the next user interaction triggers a refresh. */
      // eslint-disable-next-line no-console
      console.warn('[mountApp] deferred renderPage failed', err);
    }
  };
  /* Round 5 phase F1 — `user-blocking` priority: this is the deferred
   * `renderPage()` that fills in the visible deck/page right after tutorial
   * paint. Player is actively waiting to see it; promote above the previous
   * rIC default. The yield happens at scheduler boundary, not during the
   * task, so this still doesn't block first paint. */
  schedulePostTask(fireRenderPage, 'user-blocking');
}

const DURABILITY_KEYS = [...DURABILITY_ITEM_IDS];

function EQUIPPABLE_WEAPONS(s: ReturnType<GameStore['getState']>): string[] {
  return [...EQUIPPABLE_WEAPON_IDS].filter((id) => (s.inventory[id] ?? 0) >= 1);
}

function EQUIPPABLE_SHIELDS(s: ReturnType<GameStore['getState']>): string[] {
  return ['wooden_shield'].filter((id) => (s.inventory[id] ?? 0) >= 1);
}

function EQUIPPABLE_PICKS(s: ReturnType<GameStore['getState']>): string[] {
  return [...EQUIPPABLE_PICK_IDS].filter((id) => (s.inventory[id] ?? 0) >= 1);
}

/** Visual grouping for quick-inventory name tint (forged UI). */
function invQuickTone(id: string): 'neutral' | 'ember' | 'aqua' | 'bark' | 'ore' | 'steel' | 'arcane' {
  if (id === 'water') return 'aqua';
  if (id === 'well') return 'bark';
  if (/(berries|cooked_meat|raw_meat|herb)/.test(id)) return 'ember';
  if (
    /wood|fiber|leather|campfire|torch|workbench|forge|kitchen|cooler|repair_bench|garden_plot/.test(id)
  ) {
    return 'bark';
  }
  if (/(stone|coal|ore|ingot|_bar|nugget|plank|scrap)/.test(id)) return 'ore';
  if (/(axe|pick|sword|shield|bandage|stim|hammer|knife|bow|arrow)/.test(id)) return 'steel';
  if (/(mana|rune|scroll|potion|essence|ley)/.test(id)) return 'arcane';
  return 'neutral';
}

function formatRes(k: string): string {
  return k.replace(/_/g, ' ');
}

/** Truncate toward zero so UI never rounds a stack up (spoilage uses fractions; toFixed was showing "2.00" berries when craft needed 2 and had 1.996). */
function formatNum(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 100) return Math.floor(n).toString();
  if (n >= 10) return (Math.trunc(n * 10) / 10).toFixed(1);
  return (Math.trunc(n * 100) / 100).toFixed(2);
}

/** Shared HTML for Gather quick inventory and Craft “materials in camp” rows. */
function invQuickRowHtml(resourceId: string, amount: number): string {
  return `<div class="recipe-row inv-quick-row" data-res="${resourceId}" data-inv-tone="${invQuickTone(resourceId)}"><span class="inv-quick-name">${formatRes(resourceId)}</span><span class="inv-quick-qty">${formatNum(amount)}</span></div>`;
}

function fmtIO(o: Record<string, number>): string {
  return Object.entries(o)
    .map(([k, v]) => `${v} ${formatRes(k)}`)
    .join(', ');
}

/** Decks tab: spell out prerequisite cards + inventory costs (matches `canUnlockCard` / `unlockCard`). */
function formatCardUnlockHtml(c: CardDef): string {
  if (c.unlockedByDefault) return '';
  const bits: string[] = [];
  if (c.requiresCards?.length) {
    bits.push(
      `Prerequisite cards: ${c.requiresCards.map((id) => cardById.get(id)?.name ?? id).join(', ')}`,
    );
  }
  if (c.requiresItems && Object.keys(c.requiresItems).length > 0) {
    const inv = Object.entries(c.requiresItems)
      .map(([k, v]) => {
        const q =
          Number.isInteger(v) || (Number.isFinite(v) && Math.abs(v - Math.round(v)) < 1e-9)
            ? String(Math.round(v))
            : formatNum(v);
        return `${q} ${formatRes(k)}`;
      })
      .join(', ');
    bits.push(`Materials in inventory: ${inv}`);
  }
  if (!bits.length) return '';
  return `<div style="font-size:0.72rem;color:var(--muted);margin-top:0.35rem;line-height:1.35"><strong>Unlock:</strong> ${escapeHtml(bits.join(' · '))}</div>`;
}
