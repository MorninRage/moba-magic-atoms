# IDLE-CRAFT — Cutscene Pipeline

> **2026-04-22 STATUS — Boot integration UNWIRED.** Both shipped cutscenes (`intro_the_curse.mp4` + `intro_the_shattering.mp4`) and their player overlay (`src/cutscenes/introCutscene.ts` + `introSplash.ts`) are preserved on disk but **no longer imported from the boot graph** (`src/main.ts`). Per player feedback that the cutscenes were "too heavy," the boot was simplified to title-flow-direct in 2026-04-22. **This pipeline is still canonical** for any future cutscene production — it produces .mp4 files that drop into `public/cutscenes/` exactly as before. Re-enabling the boot integration is a one-commit revert of `src/main.ts` + `index.html` + `vite.config.ts` + `netlify.toml`. See `docs/SESSION_2026_04_22_CUTSCENE_REMOVAL_AND_BOOT_TIGHTENING.md` for the full removal diff and rationale, and `LEARNINGS.md` for the lessons learned. The narrative arc in `LORE.md` is unchanged — these cutscenes remain the canonical reference for Acts 1 / 1b framing whether or not they're currently in the boot path.

**How to produce a new cinematic cutscene for IDLE-CRAFT, end-to-end, fully free, on the existing toolchain.** This is the operating manual for the system that produced `intro_the_curse.mp4` and `intro_the_shattering.mp4` — every script, every setting, every prompt formula that worked.

**Companion docs:**
- `docs/CUTSCENE_BUILD_LOG.md` — exhaustive runbook with every install command, every iteration command, full file trees, and the actual command-by-command production logs of the shipped cutscenes. Read this when you need to *reproduce* something or debug a specific output.
- `LORE.md` — narrative bible (what to write *about*; tone, names, palette)
- `GAME_MASTER.md` §13 — pointer into this doc + integration component reference
- `PLAN.md` — delivery log
- `docs/SESSION_2026_04_22_CUTSCENE_REMOVAL_AND_BOOT_TIGHTENING.md` — 2026-04-22 boot-removal diff (this pipeline is unaffected; the integration into `main.ts` is what was removed)

---

## 1. What this system produces

An MP4 cutscene of arbitrary length, composed of:

- **Stills** — original cinematic art generated from text prompts (Pollinations.ai → FLUX, no API key)
- **Motion** — 2.5D parallax animation of each still (ComfyUI + Depthflow nodes, runs locally on GPU)
- **Narration** — offline text-to-speech, processed for "old wizard" timbre (Piper TTS + FFmpeg pitch shift)
- **Music** — ambient bed pulled from the game's existing CC0 music library (`public/audio/music/`)
- **Composition** — fades, vignettes, subtitles, title cards, audio mixing (Remotion / React-based programmatic video)
- **Output** — H.264 MP4, 1080p30, ready to drop into `public/cutscenes/`

**Cost per cutscene: $0.** No API keys, no cloud rendering, no subscriptions. Tested at $0 across the full pipeline.

**Time per cutscene** (for an 8-shot, ~50-second piece):
- Generate stills: 3-5 min (Pollinations rate-limits to ~1 concurrent, ~30-90s each)
- Render Depthflow motion: ~30s total for 6-8 shots
- Generate narration: ~5s
- Render Remotion composition: ~2 min
- **Total active time: ~10 min** once the shot list is written. Most of it unattended.

---

## 2. Stack

| Layer | Tool | Location |
|---|---|---|
| Still generation | Pollinations.ai (FLUX) — free, no signup | HTTP API, no install |
| Motion (parallax) | ComfyUI + ComfyUI-Depthflow-Nodes + Depth Anything V2 | `C:\Users\Limin\cutscenes\tools\ComfyUI_windows_portable\` |
| Motion (hero shots — optional) | Wan2GP (image-to-video) — installed but unused so far | `C:\Users\Limin\cutscenes\tools\Wan2GP\` |
| Narration | Piper TTS + FFmpeg pitch shift | `C:\Users\Limin\cutscenes\tools\piper\` |
| Music | Game's existing CC0 library | `idle deck/public/audio/music/` |
| Composition | Remotion (React + TypeScript programmatic video) | `C:\Users\Limin\cutscenes\projects\<cutscene_id>\` |
| Encoding | FFmpeg (bundled with Remotion) | system PATH |

**The cutscene workspace is intentionally OUTSIDE the game repo** at `C:\Users\Limin\cutscenes\`. This keeps the game repo lightweight (no node_modules, no GB of model weights, no Python venv). Only the *output* MP4 is copied into the game.

---

## 3. Workspace layout

```
C:\Users\Limin\cutscenes\
├── tools\
│   ├── ComfyUI_windows_portable\     # ComfyUI + custom nodes (Depthflow, DepthAnythingV2, Manager, VHS)
│   ├── Wan2GP\                       # Wan2GP for image-to-video (optional, unused so far)
│   └── piper\                        # Piper TTS binary + voice models
│       ├── piper\piper.exe
│       └── voices\en_GB-alan-medium.onnx (+ .json)
│
├── models\
│   └── depth_anything_v2\            # cached depth models (also copied into ComfyUI/models/depthanything/)
│
├── scripts\                          # the four scripts that drive the pipeline
│   ├── gen_stills.py                 # Pollinations → stills
│   ├── gen_narration.py              # Piper → WAVs (with pitch + tempo)
│   ├── depthflow_run.py              # one image → one parallax MP4 via ComfyUI API
│   └── depthflow_batch.py            # batch all shots in a shot list
│
├── projects\
│   └── intro-the-curse\              # one folder per cutscene
│       ├── package.json              # Remotion + deps
│       ├── tsconfig.json
│       ├── remotion.config.ts
│       ├── shots.json                # shot list (the source of truth)
│       ├── public\
│       │   ├── stills\<id>.jpg       # generated stills
│       │   ├── clips\<id>.mp4        # Depthflow-rendered per-shot clips
│       │   ├── audio\<id>.wav        # Piper narrations per shot
│       │   ├── audio\music.ogg       # ambient bed (copied from game)
│       │   └── stills\test_*.jpg     # one-off generations
│       ├── src\
│       │   ├── index.ts              # Remotion registerRoot
│       │   ├── Root.tsx              # Composition registry
│       │   ├── shots.ts              # imports shots.json
│       │   ├── Shot.tsx              # per-shot component (clip + audio + subtitle)
│       │   ├── TitleCard.tsx         # final-shot title component
│       │   └── TheCurse.tsx          # the master sequence + music bed
│       └── out\                      # Remotion render targets (intermediate)
│
└── output\
    ├── intro_the_curse_v2.mp4        # final shipped cutscene
    └── voice_tests\                  # WAVs for A/B'ing voice settings
```

---

## 4. The "Make a new cutscene" recipe

Five steps. All commands run from a PowerShell terminal on Windows.

### Step 1 — Boot ComfyUI (must be running for Depthflow)

```powershell
cd "C:\Users\Limin\cutscenes\tools\ComfyUI_windows_portable"
.\python_embeded\python.exe -s ComfyUI\main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch
```

Leave this running in a background terminal. Verify by opening `http://127.0.0.1:8188` in a browser. Look for the `🌊 DEPTHFLOW NODES 🌊` banner in the boot log to confirm Depthflow loaded.

### Step 2 — Scaffold the project

Copy an existing project as a template:

```powershell
$src = "C:\Users\Limin\cutscenes\projects\intro-the-curse"
$dst = "C:\Users\Limin\cutscenes\projects\<NEW_CUTSCENE_ID>"
Copy-Item $src $dst -Recurse -Exclude "node_modules","public\stills","public\clips","public\audio","out"
cd $dst
npm install
```

### Step 3 — Write the shot list (`shots.json`)

This is the **only** creative step that needs human input. See §5 for the schema. The pattern that worked for `intro_the_curse`:

- 6-8 shots, 5-7 seconds each, total target ~45-60s
- Each shot has: `id`, `seed`, `narration` (1-12 words), `motion` (one of the Depthflow presets), `duration` (seconds), `prompt` (style-prefixed)
- One title card shot at the end (no still, just text + final whisper)
- Read `LORE.md` first to make sure character names, palette, and voice align

### Step 4 — Generate everything

Run all three asset generators sequentially. They're idempotent — safe to re-run any step.

```powershell
# Stills (Pollinations.ai — free, no key, ~30-90s per shot, single-threaded)
python "C:\Users\Limin\cutscenes\scripts\gen_stills.py" `
  ".\shots.json" ".\public\stills" --workers 1

# Narration (Piper TTS + pitch shift — ~5s total)
python "C:\Users\Limin\cutscenes\scripts\gen_narration.py" `
  ".\shots.json" ".\public\audio" --length-scale 1.3 --pitch 0.93

# Depthflow motion (one MP4 per shot, ~6-10s each)
python "C:\Users\Limin\cutscenes\scripts\depthflow_batch.py" `
  ".\shots.json" ".\public\stills" ".\public\clips"

# Music — copy the right track from the game
Copy-Item "C:\Users\Limin\idle deck\public\audio\music\menu-01.ogg" `
  ".\public\audio\music.ogg" -Force
```

### Step 5 — Compose & render

Update `src/TheCurse.tsx` (or rename it for the new cutscene) so its `ORDER` array matches your shot IDs. Then render:

```powershell
npx remotion render src/index.ts TheCurse "..\..\output\<NEW_CUTSCENE_ID>.mp4"
```

Open the MP4 to review. If anything's wrong (voice timbre, music volume, a still doesn't fit), iterate in place — re-run only the relevant generator step + re-render.

### Step 6 — Integrate into the game

Copy the MP4 into the game and wire it in:

```powershell
Copy-Item "C:\Users\Limin\cutscenes\output\<NEW_CUTSCENE_ID>.mp4" `
  "C:\Users\Limin\idle deck\public\cutscenes\<NEW_CUTSCENE_ID>.mp4" -Force
```

For new cutscenes that aren't the intro, write a small player module mirroring `src/cutscenes/introCutscene.ts`. See §11 for the pattern.

---

## 5. Shot list schema (`shots.json`)

Top-level: an array of shot objects. The order of objects in the file is the playback order.

```jsonc
[
  {
    "id": "01_vanguard",          // unique slug, also used as filename root
    "seed": 11,                   // Pollinations seed — keep stable for reproducibility
    "narration": "Once, the rivers obeyed me.",   // V/O text (Piper reads this)
    "motion": "orbital",          // one of: orbital | dolly | circle | horizontal | vertical | zoom | title
    "duration": 7.0,              // seconds — must be >= narration length + ~1s breathing room
    "prompt": "dark fantasy oil painting, the Vanguard Wizard, ..."
  },
  // ...
  {
    "id": "08_title",             // title cards have motion=\"title\" and no still
    "seed": 0,
    "narration": "But I will rise.",
    "motion": "title",
    "duration": 5.0,
    "prompt": ""
  }
]
```

**Reserved motion values:**
- `orbital | dolly | circle | horizontal | vertical | zoom` — handed to Depthflow (see §8)
- `title` — skipped by `depthflow_batch.py` and `gen_stills.py`; Remotion's `<TitleCard>` component renders it
- `wan_i2v` — reserved for future Wan2GP I2V hero shots; currently no-op (see §13)

**Tips:**
- Keep narration short. The voice runs slowly (length_scale 1.3); 8-12 words per shot is plenty.
- Always leave at least 1 second of silent tail per shot — gives subtitle time to fade and the music time to breathe.
- Use **distinctive seeds** (don't all leave seed=42) so re-runs reproduce the same image.

---

## 6. Style prompt formula (the one that works)

Every prompt should follow this skeleton:

```
dark fantasy oil painting, [SUBJECT + ACTION + KEY DETAILS],
painterly brushwork by Greg Rutkowski and Zdzislaw Beksinski,
cinematic chiaroscuro lighting, deep shadows,
[MOOD ADJECTIVES],
[OPTIONAL: composition cue]
```

**Examples that produced good results in `intro_the_curse`:**

| Subject | Working prompt |
|---|---|
| Vanguard with water magic | `dark fantasy oil painting cinematic key art, the Vanguard Wizard, tall regal sorcerer with silver-streaked black hair, ornate deep-blue robes embroidered with silver river-runes, glowing turquoise water magic shaped between his outstretched hands forming a coiling serpent of liquid light, standing on the balcony of a high stone palace at twilight, two pale moons rising behind him, distant misty mountains, painterly brushwork by Greg Rutkowski and Zdzislaw Beksinski, cinematic chiaroscuro lighting, deep shadows, regal heroic composition` |
| Mira (memory shot) | `dark fantasy oil painting, young girl about seven years old with long auburn hair, daisy crown, laughing freely, sunlit garden of wildflowers, golden hour light, painterly brushwork by Greg Rutkowski and James Gurney, soft cinematic depth of field, warm amber and rose light, ethereal childhood memory atmosphere, vignette` |
| Witches Council | `dark fantasy oil painting, three hooded witches of the Witches Guild standing around an ancient stone council chamber, each holding a wand crowned with green witch-fire, ... cold green and blue light, painterly brushwork by Greg Rutkowski and Zdzislaw Beksinski, sinister conspiratorial composition, cinematic chiaroscuro` |

**Palette by subject type** (from `LORE.md` §7):
- **Vanguard / water magic:** cyan / turquoise glow, deep blue, silver
- **Mira / memory:** golden hour, amber, rose, warm soft light
- **Witches Guild / villainy:** cold greens, bone-white, moss, deep stone-grey
- **Dream-prison / void:** deep black, faint stardust, occasional cyan accent

**Three things that consistently improved output quality:**
1. Always include both Rutkowski + Beksinski (or + Gurney for memory shots) — the two-name combo gives painterly weight
2. Always say `oil painting` and `painterly brushwork` — kills the "AI smoothness"
3. Always include a composition cue at the end (`heroic composition`, `conspiratorial`, `surreal dreamlike`, etc.) — guides framing

---

## 7. Voice settings (Piper)

The current "old Vanguard wizard" voice:

| Setting | Value | Why |
|---|---|---|
| Voice model | `en_GB-alan-medium` | British male, clear, suitable for fantasy narrator |
| `--length-scale` | `1.3` | 30% slower delivery = older / weighted cadence |
| `--pitch` | `0.93` | ~1.2 semitones lower (FFmpeg post-process) — slight aging without going Darth Vader |
| `--noise-scale` | 0.667 (default) | leave alone |
| `--noise-w` | 0.8 (default) | leave alone |

The current witch trio (used in `intro_the_shattering`):

| Witch | Piper voice | Settings (per-shot override) | Vibe |
|---|---|---|---|
| **Witch A** — `s7b_witch_eastern` | `en_GB-cori-medium` | `voice_length=1.05, voice_pitch=1.0` | British female, calm/cruel/eerie |
| **Witch B** — `s7c_witch_iron` | `en_GB-jenny_dioco-medium` | `voice_length=1.1, voice_pitch=1.0` | British female, soft/cold/procedural |
| **Witch C** — `s7d_witch_mocking` | `en_US-kristin-medium` | `voice_length=1.0, voice_pitch=1.0` | American female, warm-cool, plus a real CC0 cackle SFX baked into the WAV after her line |

**Per-shot voice overrides:** the shot list JSON supports `voice`, `voice_length`, `voice_pitch` fields per shot. `gen_narration.py` reads them and uses that voice/setting for that shot only, falling back to the CLI defaults otherwise. See `docs/CUTSCENE_BUILD_LOG.md` §5.2 for the schema.

**Realistic laughter cannot be synthesized by Piper** — `"ha ha ha"` text gets read out as syllables, not laughed. For witch cackles (or any real laugh / scream / gasp), download a CC0 SFX file (OpenGameArt, Pixabay, Freesound CC0) and concatenate it onto the spoken WAV with FFmpeg's concat demuxer. See `docs/CUTSCENE_BUILD_LOG.md` §7 for the canonical bake-in recipe.

To explore voice variants quickly, write a temporary 1-shot JSON like `[{"id": "voice_test", "narration": "..."}]` and call `gen_narration.py` with different `--length-scale` / `--pitch` combinations against `output/voice_tests/`. See `output/voice_tests/` for examples used while tuning the intro.

---

## 8. Depthflow motion preset guide

Picking the right motion for each shot is the single biggest creative lever in the parallax pipeline. Every motion preset is implemented as a Python dict in `depthflow_run.py:MOTION_PRESETS`.

| Motion | What it does | Best for |
|---|---|---|
| `orbital` | Slow circular drift around the depth axis. Foreground separates from background visibly. | **Hero opening shots.** The "moving painting" feel. |
| `dolly` | Pushes the camera in along the depth axis (or pulls back if `reverse=true`). | Mystery shots — push toward something the viewer wants to see (broken door, sleeping figure). |
| `circle` | Wider orbital with independent X/Y/Z amplitudes. More dramatic. | Council shots, ritual circles, anything that should feel encircled. |
| `horizontal` | Sideways drift (left/right). Reads as "passing by." | Travel shots, walking through a portal, witnessing something. |
| `vertical` | Up/down drift. | Falling shots, ascending shots, shots that have a strong vertical compositional anchor. |
| `zoom` | Pure zoom-in (or zoom-out). | Emotional close-ups (memory of Mira), final beats before a cut. |

The defaults in `depthflow_run.py` are tuned for a calm cinematic feel. To override per-shot, edit the `MOTION_PRESETS` dict directly — every shot in a single batch shares the preset settings.

**Two effects always applied** (in `depthflow_run.py`):
- **Vignette** — `vignette_intensity=0.45, vignette_decay=25` (heavy darkening at edges, focuses the subject)
- **Depth-of-Field** — `dof_start=0.55, dof_end=1.0, dof_intensity=0.7` (background blur)

---

## 9. Music selection guide

The game ships 13 CC0 tracks in `idle deck/public/audio/music/` (downloaded by `scripts/download-default-music.mjs` from OpenGameArt). Pick the right one and copy it to your cutscene project as `public/audio/music.ogg`.

| Track | Duration | Mood | Use for |
|---|---|---|---|
| `menu-01.ogg` ("Insistent") | 2:08 | Tense / ambient menu music | Intro cutscenes that flow into the menu (currently used for `intro_the_curse`) |
| `track-02.ogg` ("Ambient-Loop-isaiah658") | 0:24 | Pure ambient drone | Mid-game stingers, atmospheric beats. Loops cleanly. |
| `track-04.ogg` ("outer_space_2") | 0:59 | Spacey ambient | Dream-realm shots, void scenes |
| `track-05.ogg` ("gravity_turn_calm_6") | 3:26 | Calm, slow | Long emotional pieces, Mira memory cutscenes |
| `track-06.mp3` ("Forest_Ambience") | 0:45 | Nature / forest | Outdoor world-building shots |
| `battle-01.ogg` ("the_final_battle") | — | Aggressive, melodic | Battle cutscenes (boss intros etc.) |

Music is layered in `TheCurse.tsx` via Remotion's `<Audio>` with a per-frame `volume` function:

```tsx
<Audio
  src={staticFile("audio/music.ogg")}
  volume={(f) => MUSIC_VOLUME_BASE * fadeEnvelope(f)}
/>
```

The current `MUSIC_VOLUME_BASE = 0.22` sits the music as an ambient bed under narration without competing with the voice. Adjust per-cutscene to taste.

For more advanced "ducking" (dipping music volume during narration moments), pass a more sophisticated `volume` function that's lower during shots with narration and higher in the silent gaps.

---

## 10. Remotion composition reference

Each cutscene is a Remotion project with three files driving composition:

- **`src/Shot.tsx`** — generic per-shot component. Plays `clips/<id>.mp4`, layers `audio/<id>.wav`, fades in/out, draws subtitle. Reusable across cutscenes.
- **`src/TitleCard.tsx`** — terminal title card component (typography + whispered final narration). Reusable.
- **`src/TheCurse.tsx`** — the master composition. Defines `ORDER` (shot playback order), wraps shots in a `<Series>`, layers the music bed at the top.

To make a new cutscene, the *minimum* changes are:
1. New `shots.json` (different shot IDs / prompts / narration)
2. New top-level component (e.g., `src/Awakening.tsx`) with a different `ORDER` and possibly a different `MUSIC_VOLUME_BASE` or music file
3. Register the new composition in `src/Root.tsx`
4. Render with `npx remotion render src/index.ts <CompositionId> <output.mp4>`

`Shot.tsx` and `TitleCard.tsx` should be left alone — they're the shared visual grammar.

---

## 11. Game integration pattern

A cutscene is integrated by:

1. **Drop the MP4 into `idle deck/public/cutscenes/<id>.mp4`**
2. **Write a tiny player module** modeled on `src/cutscenes/introCutscene.ts`:
   - Creates a fullscreen overlay
   - Plays the video with `controls=false, autoplay, playsInline`
   - Skip button revealed after a grace period
   - `Esc/Space/Enter` also skip
   - Resolves a Promise on `ended` or skip
   - Cleans up its own DOM
3. **Wire it into the game flow** at the appropriate point (see `src/main.ts:bootIntroExperience` for the intro pattern).

**Autoplay-with-audio gotcha:** browsers block autoplay-with-sound without a prior user gesture. The intro handles this with `src/cutscenes/introSplash.ts` — a "press anywhere to begin" gate that captures the gesture before mounting the video. For mid-game cutscenes triggered by player action (clicking a button, picking up an item) you don't need a separate splash — the triggering click counts as the gesture.

**Should the cutscene play once or every time?**
- `introCutscene.ts:shouldPlayIntroCutscene()` currently always returns `true` (every refresh = replay). The localStorage flag logic is preserved in commented form for future "play once per save" mode.
- The `gameStore.ts:reset()` function already clears the flag, so flipping it back to "play once" works cleanly with the existing reset path.

---

## 12. Iteration tips

- **One thing at a time.** If the voice feels wrong, regenerate just narration. If a still doesn't sell, regenerate just that one image (single-shot JSON + `gen_stills.py`). Don't re-run the full pipeline unless something composition-level changed.
- **Pollinations rate limit.** Their free tier is ~1 concurrent generation per IP. Use `--workers 1` in `gen_stills.py`. Cache hits (same seed + prompt) return in ~1s, fresh generations take 15-90s.
- **ComfyUI must be running** (port 8188) for any Depthflow run. If `depthflow_batch.py` returns HTTP 400 or connection refused, ComfyUI is down. Restart it and re-run.
- **Reuse seeds you like.** Pollinations is deterministic per seed. If you generated a still you love at seed 89, anyone re-running the pipeline gets the same image.
- **Don't fight resolution.** Pollinations free tier returns 1024×576 regardless of the size you request. That's fine — Depthflow + Remotion at 1080p output looks great because of motion + vignette. If you ever need true 1080p source, install local Flux Schnell GGUF (~7 GB) into ComfyUI and swap `gen_stills.py` for a local generator.

---

## 13. Future: real motion via Wan2GP

Wan2GP (`tools/Wan2GP/`) is installed and ready but currently unused. It does true image-to-video on the local GPU — useful for "hero shots" where parallax isn't enough (chaotic action, character motion, water flowing).

**Why we haven't used it yet:**
- First I2V run downloads ~5-10 GB of Wan model weights (one-time)
- Per-clip render is 2-5 minutes on RTX 4060 Ti vs. ~6 seconds for Depthflow
- For most cutscene shots, Depthflow is already enough

**When to use it:**
- Hero ambush / action shots
- Anything that needs liquid water flowing, smoke, hair blowing, fire
- Final-act climactic shots where production value matters most

**To enable:**
1. Boot Wan2GP web UI: `cd tools\Wan2GP\env_venv\Scripts; .\activate.ps1; cd ..\..; python wgp.py`
2. First run downloads the model (one-time)
3. Use the web UI to generate I2V clips from your stills
4. Drop the resulting MP4s into `projects/<id>/public/clips/<id>.mp4` (replacing the Depthflow versions)
5. Remotion picks them up with no other changes

For shots tagged `motion: "wan_i2v"` in `shots.json`, `depthflow_batch.py` already skips them (so a hybrid Depthflow + Wan2GP pipeline works without conflict).

---

## 14. Cost & time reference

| Cutscene scale | Active human time | Wall time | $ cost |
|---|---|---|---|
| **3-shot stinger (~15s)** | ~5 min | ~3 min | $0 |
| **6-8 shot intro (~50s)** | ~15 min | ~10 min | $0 |
| **10-shot setpiece (~75s) with Wan2GP hero shots** | ~30 min | ~30 min (Wan2GP renders) | $0 |

The pipeline scales linearly. The bottleneck is **writing the shot list** (creative work — there's no shortcut), not generation time.

---

## 15. File reference

**External (cutscene workspace) — not in game repo:**
- `C:\Users\Limin\cutscenes\scripts\gen_stills.py`
- `C:\Users\Limin\cutscenes\scripts\gen_narration.py`
- `C:\Users\Limin\cutscenes\scripts\depthflow_run.py`
- `C:\Users\Limin\cutscenes\scripts\depthflow_batch.py`
- `C:\Users\Limin\cutscenes\projects\intro-the-curse\` — reference template

**In game repo:**
- `public/cutscenes/intro_the_curse.mp4` — shipped intro
- `src/cutscenes/introCutscene.ts` + `.css` — overlay player
- `src/cutscenes/introSplash.ts` + `.css` — autoplay-gesture gate
- `src/main.ts` — `bootIntroExperience()` wires it all up
- `src/core/gameStore.ts` — `reset()` clears the cutscene flag

---

*Last updated: shipped pipeline that produced `intro_the_curse.mp4` end-to-end at $0 in ~30 min wall clock. Wan2GP I2V available but unused so far.*
