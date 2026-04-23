/**
 * Esc menu — tone mapping, exposure, output space, GoE-style light multipliers.
 */
import * as THREE from 'three';
import { fetchEmpireProject } from '../engine/fetchEmpireProject';
import {
  clearUserRendererDisplayPatch,
  getEffectiveRendererDisplay,
  patchUserRendererDisplay,
} from '../engine/rendererDisplaySettings';

function toneMappingToSelectValue(tm: THREE.ToneMapping): string {
  switch (tm) {
    case THREE.NoToneMapping:
      return 'NoToneMapping';
    case THREE.LinearToneMapping:
      return 'Linear';
    case THREE.ReinhardToneMapping:
      return 'Reinhard';
    case THREE.CineonToneMapping:
      return 'Cineon';
    case THREE.ACESFilmicToneMapping:
      return 'ACESFilmic';
    case THREE.AgXToneMapping:
      return 'AgX';
    case THREE.NeutralToneMapping:
      return 'Neutral';
    default:
      return 'ACESFilmic';
  }
}

export function refreshLightingPanel(menuRoot: HTMLElement): void {
  const block = menuRoot.querySelector('[data-system-lighting]') as HTMLElement | null;
  if (!block) return;

  void fetchEmpireProject().then((project) => {
    const cfg = (project?.config ?? {}) as Record<string, unknown>;
    const d = getEffectiveRendererDisplay(cfg);

    const tone = block.querySelector('[data-light-tone]') as HTMLSelectElement | null;
    if (tone) {
      tone.value = toneMappingToSelectValue(d.toneMapping);
    }

    const oc = block.querySelector('[data-light-output]') as HTMLSelectElement | null;
    if (oc) {
      oc.value = d.outputColorSpace === THREE.LinearSRGBColorSpace ? 'linear' : 'srgb';
    }

    const setR = (name: string, val: number, fmt: (n: number) => string) => {
      const range = block.querySelector(`[data-light-range-${name}]`) as HTMLInputElement | null;
      const out = block.querySelector(`[data-light-val-${name}]`) as HTMLElement | null;
      if (range) range.value = String(val);
      if (out) out.textContent = fmt(val);
    };
    setR('exposure', d.exposureRaw, (n) => n.toFixed(2));
    setR('sun', d.sunIntensity, (n) => n.toFixed(2));
    setR('ambient', d.ambientBrightness, (n) => n.toFixed(2));
    setR('hemi', d.hemisphereFill, (n) => n.toFixed(2));
    setR('moon', d.moonlightStrength, (n) => n.toFixed(2));
    /* Awakened quality tier dropdown. */
    const awakenedSel = block.querySelector('[data-light-awakened-quality]') as HTMLSelectElement | null;
    if (awakenedSel) awakenedSel.value = d.awakenedQuality;
    /* Phase 8h overhaul knobs. */
    setR('camera-fill', d.cameraFill, (n) => n.toFixed(2));
    setR('night-grade', d.nightGradeStrength, (n) => n.toFixed(2));
    setR('sun-shafts', d.sunShafts, (n) => n.toFixed(2));
    setR('env-reflections', d.envReflections, (n) => n.toFixed(2));
  });
}

function bindLightRange(
  block: HTMLElement,
  dataName: string,
  key:
    | 'exposure'
    | 'sunIntensity'
    | 'ambientBrightness'
    | 'hemisphereFill'
    | 'moonlightStrength'
    | 'cameraFill'
    | 'nightGradeStrength'
    | 'sunShafts'
    | 'envReflections',
  fmt: (n: number) => string,
): void {
  const range = block.querySelector(`[data-light-range-${dataName}]`) as HTMLInputElement | null;
  const out = block.querySelector(`[data-light-val-${dataName}]`) as HTMLElement | null;
  range?.addEventListener('input', () => {
    const v = parseFloat(range.value);
    patchUserRendererDisplay({ [key]: v });
    if (out) out.textContent = fmt(v);
  });
}

export function wireLightingPanel(menuRoot: HTMLElement): void {
  const block = menuRoot.querySelector('[data-system-lighting]') as HTMLElement | null;
  if (!block) return;

  block.querySelector('[data-light-tone]')?.addEventListener('change', (e) => {
    patchUserRendererDisplay({ toneMapping: (e.target as HTMLSelectElement).value });
  });
  block.querySelector('[data-light-output]')?.addEventListener('change', (e) => {
    patchUserRendererDisplay({ outputColorSpace: (e.target as HTMLSelectElement).value as 'srgb' | 'linear' });
  });
  block.querySelector('[data-light-awakened-quality]')?.addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v === 'perf' || v === 'balanced' || v === 'full') {
      patchUserRendererDisplay({ awakenedQuality: v });
    }
  });

  bindLightRange(block, 'exposure', 'exposure', (n) => n.toFixed(2));
  bindLightRange(block, 'sun', 'sunIntensity', (n) => n.toFixed(2));
  bindLightRange(block, 'ambient', 'ambientBrightness', (n) => n.toFixed(2));
  bindLightRange(block, 'hemi', 'hemisphereFill', (n) => n.toFixed(2));
  bindLightRange(block, 'moon', 'moonlightStrength', (n) => n.toFixed(2));
  /* Phase 8h overhaul knobs. */
  bindLightRange(block, 'camera-fill', 'cameraFill', (n) => n.toFixed(2));
  bindLightRange(block, 'night-grade', 'nightGradeStrength', (n) => n.toFixed(2));
  bindLightRange(block, 'sun-shafts', 'sunShafts', (n) => n.toFixed(2));
  bindLightRange(block, 'env-reflections', 'envReflections', (n) => n.toFixed(2));

  block.querySelector('[data-light-reset]')?.addEventListener('click', () => {
    clearUserRendererDisplayPatch();
    refreshLightingPanel(menuRoot);
  });
}
