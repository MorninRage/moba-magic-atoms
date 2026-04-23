/**
 * Esc menu — graphics tier + post-processing toggles and sliders (persists to localStorage).
 */
import { fetchEmpireProject } from '../engine/fetchEmpireProject';
import type { PostProcessingStackOptions } from 'empire-engine/render/PostProcessingStack';
import {
  allowHeavyPostProcessingOnLowTier,
  getEffectivePostProcessingOptions,
} from '../engine/postProcessingFromProject';
import { getStoredGraphicsPreference, resolveGraphicsTier, setStoredGraphicsPreference } from '../engine/graphicsTier';
import { getGoEPostProcessingPresetPatch, type GoEPostProcessingPreset } from '../engine/postProcessingPresets';
import {
  clearUserPostProcessingPatch,
  notifyPostProcessingSettingsChanged,
  patchUserPostProcessing,
  replaceUserPostProcessingPatch,
} from '../engine/userPostProcessingSettings';

const HEAVY_KEY = 'idleCraft.postProcessing.heavy';

function setHeavyPostOnLow(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(HEAVY_KEY, '1');
    else localStorage.removeItem(HEAVY_KEY);
  } catch {
    /* ignore */
  }
  notifyPostProcessingSettingsChanged();
}

function readHeavyPostOnLow(): boolean {
  return allowHeavyPostProcessingOnLowTier();
}

/** Populate controls from project + tier + saved overrides. */
export function refreshPostProcessingPanel(menuRoot: HTMLElement): void {
  const block = menuRoot.querySelector('[data-system-graphics-pp]') as HTMLElement | null;
  if (!block) return;

  void fetchEmpireProject().then((project) => {
    const cfg = (project?.config ?? {}) as Record<string, unknown>;
    const tier = resolveGraphicsTier();
    const opts = getEffectivePostProcessingOptions(cfg, tier);

    const sel = block.querySelector('[data-graphics-tier]') as HTMLSelectElement | null;
    if (sel) sel.value = getStoredGraphicsPreference();

    const heavy = block.querySelector('[data-pp-heavy]') as HTMLInputElement | null;
    if (heavy) heavy.checked = readHeavyPostOnLow();

    const setChk = (name: string, v: boolean) => {
      const el = block.querySelector(`[data-pp-${name}]`) as HTMLInputElement | null;
      if (el) el.checked = v;
    };
    setChk('fxaa', !!opts.fxaa);
    setChk('vignette', !!opts.vignette);
    setChk('bloom', !!opts.bloom);
    setChk('ssao', !!opts.ssao);

    const setRange = (name: string, val: number, fmt: (n: number) => string) => {
      const range = block.querySelector(`[data-pp-range-${name}]`) as HTMLInputElement | null;
      const out = block.querySelector(`[data-pp-val-${name}]`) as HTMLElement | null;
      if (range) range.value = String(val);
      if (out) out.textContent = fmt(val);
    };
    setRange('bloom-strength', opts.bloomStrength ?? 0.25, (n) => n.toFixed(2));
    setRange('bloom-threshold', opts.bloomThreshold ?? 0.92, (n) => n.toFixed(2));
    setRange('bloom-radius', opts.bloomRadius ?? 0.25, (n) => n.toFixed(2));
    setRange('vignette-darkness', opts.vignetteDarkness ?? 0.45, (n) => n.toFixed(2));
    setRange('vignette-offset', opts.vignetteOffset ?? 1.2, (n) => n.toFixed(2));
    setRange('ssao-intensity', opts.ssaoIntensity ?? 0.14, (n) => n.toFixed(2));
    setRange('ssao-radius', opts.ssaoKernelRadius ?? 1, (n) => n.toFixed(2));
    setRange('ssao-min-distance', opts.ssaoMinDistance ?? 0.02, (n) => n.toFixed(3));
    setRange('ssao-max-distance', opts.ssaoMaxDistance ?? 0.015, (n) => n.toFixed(3));
    setRange('ssao-resolution-scale', opts.ssaoResolutionScale ?? 0.35, (n) => n.toFixed(2));
    setRange('fxaa-strength', opts.fxaaStrength ?? 1, (n) => n.toFixed(2));

    const lowTier = tier === 'low';
    const heavyOn = readHeavyPostOnLow();
    const bloomEl = block.querySelector('[data-pp-bloom]') as HTMLInputElement | null;
    const ssaoEl = block.querySelector('[data-pp-ssao]') as HTMLInputElement | null;
    const fxaaStrRange = block.querySelector('[data-pp-range-fxaa-strength]') as HTMLInputElement | null;
    if (bloomEl) bloomEl.disabled = lowTier && !heavyOn;
    if (ssaoEl) ssaoEl.disabled = lowTier && !heavyOn;
    if (fxaaStrRange) fxaaStrRange.disabled = !opts.fxaa;

    const hint = block.querySelector('[data-pp-tier-hint]') as HTMLElement | null;
    if (hint) {
      hint.textContent = lowTier
        ? 'Low power: enable “Allow bloom & SSAO on low power” to use heavy passes, or switch tier and reload.'
        : `Active tier: ${tier} (from device / Esc setting).`;
    }
  });
}

function bindRange(
  block: HTMLElement,
  dataName: string,
  key: keyof PostProcessingStackOptions,
  fmt: (n: number) => string,
): void {
  const range = block.querySelector(`[data-pp-range-${dataName}]`) as HTMLInputElement | null;
  const out = block.querySelector(`[data-pp-val-${dataName}]`) as HTMLElement | null;
  range?.addEventListener('input', () => {
    const v = parseFloat(range.value);
    patchUserPostProcessing({ [key]: v } as Partial<PostProcessingStackOptions>);
    if (out) out.textContent = fmt(v);
  });
}

export function wirePostProcessingPanel(menuRoot: HTMLElement): void {
  const block = menuRoot.querySelector('[data-system-graphics-pp]') as HTMLElement | null;
  if (!block) return;

  const reloadBtn = block.querySelector('[data-graphics-reload]') as HTMLButtonElement | null;
  reloadBtn?.addEventListener('click', () => {
    window.location.reload();
  });

  const tierSel = block.querySelector('[data-graphics-tier]') as HTMLSelectElement | null;
  tierSel?.addEventListener('change', () => {
    const v = tierSel.value as 'auto' | 'high' | 'low';
    setStoredGraphicsPreference(v);
  });

  block.querySelector('[data-pp-heavy]')?.addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    setHeavyPostOnLow(on);
    refreshPostProcessingPanel(menuRoot);
  });

  const boolPatch = (key: 'fxaa' | 'vignette' | 'bloom' | 'ssao') => (e: Event) => {
    patchUserPostProcessing({ [key]: (e.target as HTMLInputElement).checked });
  };

  block.querySelector('[data-pp-fxaa]')?.addEventListener('change', (e) => {
    boolPatch('fxaa')(e);
    refreshPostProcessingPanel(menuRoot);
  });
  block.querySelector('[data-pp-vignette]')?.addEventListener('change', boolPatch('vignette'));
  block.querySelector('[data-pp-bloom]')?.addEventListener('change', boolPatch('bloom'));
  block.querySelector('[data-pp-ssao]')?.addEventListener('change', boolPatch('ssao'));

  bindRange(block, 'bloom-strength', 'bloomStrength', (n) => n.toFixed(2));
  bindRange(block, 'bloom-threshold', 'bloomThreshold', (n) => n.toFixed(2));
  bindRange(block, 'bloom-radius', 'bloomRadius', (n) => n.toFixed(2));
  bindRange(block, 'vignette-darkness', 'vignetteDarkness', (n) => n.toFixed(2));
  bindRange(block, 'vignette-offset', 'vignetteOffset', (n) => n.toFixed(2));
  bindRange(block, 'ssao-intensity', 'ssaoIntensity', (n) => n.toFixed(2));
  bindRange(block, 'ssao-radius', 'ssaoKernelRadius', (n) => n.toFixed(2));
  bindRange(block, 'ssao-min-distance', 'ssaoMinDistance', (n) => n.toFixed(3));
  bindRange(block, 'ssao-max-distance', 'ssaoMaxDistance', (n) => n.toFixed(3));
  bindRange(block, 'ssao-resolution-scale', 'ssaoResolutionScale', (n) => n.toFixed(2));
  bindRange(block, 'fxaa-strength', 'fxaaStrength', (n) => n.toFixed(2));

  block.querySelectorAll('[data-pp-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).getAttribute('data-pp-preset') as GoEPostProcessingPreset | null;
      if (!id) return;
      replaceUserPostProcessingPatch(getGoEPostProcessingPresetPatch(id));
      refreshPostProcessingPanel(menuRoot);
    });
  });

  block.querySelector('[data-pp-reset]')?.addEventListener('click', () => {
    clearUserPostProcessingPatch();
    refreshPostProcessingPanel(menuRoot);
  });
}
