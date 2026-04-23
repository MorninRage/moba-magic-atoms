/**
 * Six-slot lobby stage: dock LPCA hero per preset (`buildLobbyDockHeroFromPreset`) + CSS2D nametags
 * (team tint, ready state). Matches in-game character builds (default / artisan / vanguard wizard).
 * Perf: no shadows, capped pixel ratio; LPCA mesh count higher than the old block mini but lobby-only.
 *
 * === 2026-04-22 OffscreenCanvas worker carve-out ===
 *
 * **This module STAYS on the main thread, intentionally.**
 *
 * The render-worker migration (`src/worker/*`) moves the dock /
 * free-roam scene off main, but this lobby stage is exempt:
 *   - It uses `CSS2DRenderer` for crisp HTML-rendered nametags
 *     (`CSS2DObject` wraps a real `<div>`). CSS2DRenderer requires DOM
 *     access — it cannot run in a Web Worker.
 *   - It runs only during the lobby flow (PvP / co-op room hub), which is
 *     not perf-critical — a few procedural figures, no fog/post/shadows,
 *     no per-frame audio.
 *   - It owns its own secondary `WebGLRenderer`; the main render-worker
 *     does NOT take over this canvas.
 *
 * Replacing CSS2DRenderer with `THREE.Sprite` text labels (worker-compatible)
 * was considered and rejected: text crispness drops noticeably at the
 * 6-slot stage's typical zoom level. Defer that swap unless lobby perf
 * complaints emerge.
 *
 * Future agents: do NOT route this module's renderer through
 * `WorkerBridge`. The dual-renderer model (main owns lobby renderer,
 * worker owns dock renderer) is permanent.
 */
import { createRendererAsync, fetchEmpireProject, type IdleEmpireProjectFile } from '../engine/idleCraftEngine';
import { dockPerfBegin, dockPerfEnd, dockPerfMark } from '../engine/dockInitPerformance';
import {
  applyPostProcessingOptionsToStack,
  createPostStackIfEnabledForPreview,
  getEffectivePostProcessingOptionsForPreview,
  isPostProcessingEnabled,
} from '../engine/postProcessingFromProject';
import { resolveGraphicsTier } from '../engine/graphicsTier';
import { getEffectiveRendererDisplay } from '../engine/rendererDisplaySettings';
import { PostProcessingStack } from 'empire-engine/render/PostProcessingStack';
import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { GameMode } from '../core/types';
import type { RoomPlayerPublic } from '../net/roomTypes';
import { buildLobbyDockHeroFromPreset } from './lobbyDockHeroFromPreset';

export type LobbyStageSlot =
  | Pick<RoomPlayerPublic, 'displayName' | 'characterPresetId' | 'team' | 'ready' | 'isHost'>
  | null;

function disposeObject3D(o: THREE.Object3D): void {
  o.traverse((x) => {
    if (x instanceof THREE.Mesh) {
      x.geometry.dispose();
      const m = x.material;
      if (Array.isArray(m)) m.forEach((mat) => mat.dispose());
      else m.dispose();
    }
  });
}

function slotAngle(i: number, count: number): number {
  if (count <= 1) return 0;
  const span = Math.PI * 0.62;
  const t = i / (count - 1);
  return -span * 0.5 + t * span;
}

export class MultiplayerAvatarStage {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private labelRenderer: CSS2DRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private roots: THREE.Group[] = [];
  private raf = 0;
  private disposed = false;
  private tick = 0;
  private readonly renderScale: number;
  private postProcessing: PostProcessingStack | null = null;
  private readonly empireProject: IdleEmpireProjectFile | null;
  private readonly ambientLight: THREE.AmbientLight;
  private readonly keyLight: THREE.DirectionalLight;
  private readonly lobbyAmbientBase = 0.55;
  private readonly lobbyKeyBase = 0.95;

  static async create(container: HTMLElement): Promise<MultiplayerAvatarStage> {
    dockPerfBegin('lobby-bootstrap');
    const w = Math.max(280, container.clientWidth || 640);
    const h = Math.max(200, Math.round((w * 9) / 16));
    const canvas = document.createElement('canvas');
    dockPerfBegin('lobby-renderer');
    const { renderer } = await createRendererAsync({
      canvas,
      antialias: false,
      preferWebGPU: false,
    });
    dockPerfEnd('lobby-renderer');
    dockPerfBegin('lobby-project');
    const project = await fetchEmpireProject();
    dockPerfEnd('lobby-project');
    dockPerfBegin('lobby-constructor');
    const stage = new MultiplayerAvatarStage(container, renderer, w, h, project);
    dockPerfEnd('lobby-constructor');
    dockPerfEnd('lobby-bootstrap');
    dockPerfMark('lobby-ready');
    return stage;
  }

  private constructor(
    container: HTMLElement,
    renderer: THREE.WebGLRenderer,
    w: number,
    h: number,
    project: IdleEmpireProjectFile | null,
  ) {
    this.empireProject = project;
    const cfg = (project?.config ?? {}) as Record<string, unknown>;
    const fovCfg = cfg['graphics.fov'];
    const lobbyFovMul = typeof fovCfg === 'number' && fovCfg > 0 ? fovCfg / 42 : 1;
    const rsRaw = cfg['graphics.renderScale'];
    this.renderScale = typeof rsRaw === 'number' && rsRaw > 0 ? rsRaw : 1;

    this.container = container;
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0e1520);

    this.camera = new THREE.PerspectiveCamera(42 * lobbyFovMul, w / h, 0.1, 40);
    this.camera.position.set(0, 1.05, 3.35);
    this.camera.lookAt(0, 0.85, 0);

    this.ambientLight = new THREE.AmbientLight(0xc8d8f0, this.lobbyAmbientBase);
    this.scene.add(this.ambientLight);
    this.keyLight = new THREE.DirectionalLight(0xfff5e8, this.lobbyKeyBase);
    this.keyLight.position.set(2.2, 4.5, 2.8);
    this.scene.add(this.keyLight);

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.2) * this.renderScale);
    this.renderer.setSize(w, h, false);
    this.renderer.shadowMap.enabled = false;

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.setSize(w, h);
    this.labelRenderer.domElement.style.position = 'absolute';
    this.labelRenderer.domElement.style.top = '0';
    this.labelRenderer.domElement.style.left = '0';
    this.labelRenderer.domElement.style.pointerEvents = 'none';

    const wrap = document.createElement('div');
    wrap.style.position = 'relative';
    wrap.style.width = '100%';
    wrap.style.maxWidth = '100%';
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = 'auto';
    wrap.appendChild(this.renderer.domElement);
    wrap.appendChild(this.labelRenderer.domElement);
    container.appendChild(wrap);

    for (let i = 0; i < 6; i++) {
      const g = new THREE.Group();
      this.scene.add(g);
      this.roots.push(g);
    }

    this.loop = this.loop.bind(this);
    this.onResize = this.onResize.bind(this);
    this.postProcessing = createPostStackIfEnabledForPreview(this.renderer, this.scene, this.camera, cfg, resolveGraphicsTier());
    this.postProcessing?.setSize(w, h, this.renderer.getPixelRatio());
    this.syncRendererDisplayFromSettings();

    window.addEventListener('resize', this.onResize);
    this.raf = requestAnimationFrame(this.loop);
  }

  /** Tone mapping, exposure, output color space, and simple light scaling (Esc / project). */
  syncRendererDisplayFromSettings(): void {
    if (this.disposed) return;
    const cfg = (this.empireProject?.config ?? {}) as Record<string, unknown>;
    const d = getEffectiveRendererDisplay(cfg);
    this.renderer.toneMapping = d.toneMapping;
    this.renderer.outputColorSpace = d.outputColorSpace;
    this.renderer.toneMappingExposure = d.exposureRaw * 0.82;
    this.ambientLight.intensity = this.lobbyAmbientBase * d.ambientBrightness;
    this.keyLight.intensity = this.lobbyKeyBase * d.sunIntensity;
  }

  /** Apply Esc menu / localStorage post-processing to the lobby WebGL view. */
  syncPostProcessingFromSettings(): void {
    if (this.disposed) return;
    const cfg = (this.empireProject?.config ?? {}) as Record<string, unknown>;
    const tier = resolveGraphicsTier();
    const opts = getEffectivePostProcessingOptionsForPreview(cfg, tier);
    const w = Math.max(280, this.container.clientWidth || 640);
    const h = Math.max(200, Math.round((w * 9) / 16));
    if (!isPostProcessingEnabled(opts)) {
      this.postProcessing?.getComposer().dispose();
      this.postProcessing = null;
      return;
    }
    if (!this.postProcessing) {
      this.postProcessing = new PostProcessingStack(this.renderer, this.scene, this.camera, opts);
    } else {
      applyPostProcessingOptionsToStack(this.postProcessing, opts, { width: w, height: h });
    }
    this.postProcessing.setSize(w, h, this.renderer.getPixelRatio());
  }

  /**
   * @param gameMode Forge clash (`deathmatch`) shows Team A/B on nametags; co-op and Hunter duel (`pvp`) show only Host / Ready.
   */
  setSlots(slots: LobbyStageSlot[], gameMode: GameMode = 'coop'): void {
    const packed: NonNullable<LobbyStageSlot>[] = [];
    for (let i = 0; i < Math.min(6, slots.length); i++) {
      const s = slots[i];
      if (s) packed.push(s);
    }
    const count = packed.length;

    for (let i = 0; i < 6; i++) {
      const g = this.roots[i]!;
      while (g.children.length) {
        const c = g.children[0]!;
        g.remove(c);
        disposeObject3D(c);
      }

      const slot = packed[i];
      if (!slot) {
        g.visible = false;
        continue;
      }

      const fig = buildLobbyDockHeroFromPreset(slot.characterPresetId, slot.team);
      const ang = slotAngle(i, Math.max(1, count));
      const r = 1.42;
      g.position.set(Math.sin(ang) * r, 0, Math.cos(ang) * r - 0.15);
      g.rotation.y = Math.PI + ang;
      g.add(fig);

      const div = document.createElement('div');
      div.className = 'lobby-nametag';
      const teamLabel = slot.team === 0 ? 'A' : 'B';
      const readyPart = slot.ready ? ' · Ready' : '';
      const metaLine =
        gameMode === 'deathmatch'
          ? `Team ${teamLabel}${slot.isHost ? ' · Host' : ''}${readyPart}`
          : (() => {
              const parts: string[] = [];
              if (slot.isHost) parts.push('Host');
              if (slot.ready) parts.push('Ready');
              return parts.length > 0 ? parts.join(' · ') : '—';
            })();
      div.innerHTML = `<span class="lobby-nametag__name">${escapeHtml(slot.displayName)}</span><span class="lobby-nametag__meta">${metaLine}</span>`;
      div.classList.toggle('lobby-nametag--ready', slot.ready);
      div.classList.toggle('lobby-nametag--team-a', slot.team === 0);
      div.classList.toggle('lobby-nametag--team-b', slot.team === 1);
      const label = new CSS2DObject(div);
      label.position.set(0, 1.85, 0);
      g.add(label);
      g.visible = true;
    }
  }

  private loop(): void {
    if (this.disposed) return;
    this.tick += 0.016;
    let idx = 0;
    for (const g of this.roots) {
      if (!g.visible) continue;
      const fig = g.children.find((c) => !(c instanceof CSS2DObject));
      if (fig) fig.rotation.y = Math.sin(this.tick * 0.9 + idx * 0.4) * 0.07;
      idx++;
    }
    if (this.postProcessing) this.postProcessing.render();
    else this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.loop);
  }

  private onResize(): void {
    const w = Math.max(280, this.container.clientWidth || 640);
    const h = Math.max(200, Math.round((w * 9) / 16));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.2) * this.renderScale);
    this.renderer.setSize(w, h, false);
    this.postProcessing?.setSize(w, h, this.renderer.getPixelRatio());
    this.labelRenderer.setSize(w, h);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    for (const g of this.roots) {
      while (g.children.length) {
        const c = g.children[0]!;
        g.remove(c);
        disposeObject3D(c);
      }
    }
    this.postProcessing?.getComposer().dispose();
    this.postProcessing = null;
    this.renderer.dispose();
    this.container.replaceChildren();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
