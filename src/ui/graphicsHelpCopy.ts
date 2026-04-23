/** Inline help strings for Esc → graphics / lighting (keys match `data-help-id` on controls). */
export const GRAPHICS_HELP_LINES: Record<string, string> = {
  'gfx-tier':
    'Chooses a quality preset for terrain, shadows, vegetation, and similar. Change requires a page reload to fully apply.',
  'gfx-presets':
    'Quick bundles for post-processing. You can still tweak individual toggles and sliders afterward.',
  'gfx-heavy-low':
    'On the Low / mobile tier, bloom and SSAO are normally off for speed. Enable this to force them on that tier (heavier GPU).',
  'pp-fxaa':
    'Fast approximate anti-aliasing: smooths jagged edges on geometry and bright edges. Slight blur at high strength.',
  'pp-fxaa-strength': 'How aggressively FXAA blends edges. Lower = sharper, higher = smoother.',
  'pp-vignette': 'Darkens the corners of the image to frame the view and reduce edge distraction.',
  'pp-vignette-darkness': 'How dark the corners become.',
  'pp-vignette-offset': 'How far the darkening reaches toward the center (larger = tighter vignette).',
  'pp-bloom': 'Adds a soft glow around bright areas (sun, fire, specular highlights).',
  'pp-bloom-strength': 'Intensity of the glow.',
  'pp-bloom-threshold': 'Brightness above which pixels contribute to bloom (higher = only very bright things glow).',
  'pp-bloom-radius': 'How wide the glow spreads.',
  'pp-ssao': 'Screen-space ambient occlusion: contact shadows in cracks and where objects meet surfaces.',
  'pp-ssao-intensity': 'How strong the occlusion darkening appears.',
  'pp-ssao-radius': 'World-space radius of the occlusion sample kernel (larger = softer, wider contact shadows).',
  'pp-ssao-min-distance': 'Minimum depth offset for samples; avoids self-occlusion artifacts on flat surfaces.',
  'pp-ssao-max-distance': 'Maximum distance for occlusion rays; caps how far apart surfaces can still shadow each other.',
  'pp-ssao-resolution-scale': 'SSAO buffer resolution vs full screen. Lower = faster, softer; higher = sharper, costlier.',
  'lit-tone':
    'Maps HDR render values to display. ACES Filmic is a good default; None/Linear are mainly for debugging.',
  'lit-output':
    'sRGB is standard for monitors. Linear is for specific pipelines or raw inspection.',
  'lit-exposure':
    'Overall scene brightness multiplier before tone mapping (camera exposure feel).',
  'lit-sun': 'Strength of the directional sun light (daytime key light).',
  'lit-ambient': 'Uniform ambient light — lifts shadows so interiors are not pure black.',
  'lit-hemi':
    'Sky vs ground hemisphere blend — fills vertical lighting (sky blue from above, bounce from below).',
  'lit-moon': 'Strength of moonlight when the moon is up (night scenes).',
  'lit-awakened-quality':
    'Awakened-mode render budget. Performance = DPR cap + total-pixel cap ~2 MP + no bloom/SSAO (best FPS, same speed windowed or fullscreen on any monitor). Balanced = pixel cap ~3 MP + bloom on (magic / lanterns / crystals glow), no SSAO. Full = no caps (heaviest — best on dedicated GPUs).',
  'lit-camera-fill':
    'Soft third-person fill light parented to the camera so your character does not go silhouette-flat with their back to the sun. 0 = off, 1 = ship default, 2 = double bright.',
  'lit-night-grade':
    'Screen-space night colour grade (desaturate + cool-tint + crush mid-shadows) so moonlight reads as moonlight instead of dim daytime. 0 = off, 1 = ship default, 1.5 = stylized extreme.',
  'lit-sun-shafts':
    'Cone-geometry sun shafts (god-rays) angling from the sun. Subtle warm atmospheric haze, fades at night and during storms. 0 = off, 1 = ship default, 2 = pronounced.',
  'lit-env-reflections':
    'PMREM environment-map intensity — drives how much surrounding sky colour is reflected on PBR materials (orbs, metal bands, witch wands). 0 = off, 1 = neutral, 1.5 = stronger reflections.',
};
