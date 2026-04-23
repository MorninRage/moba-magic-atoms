# IDLE-CRAFT — Cutscene Build Log & Runbook

> **2026-04-22 STATUS — Boot integration UNWIRED.** Both shipped cutscenes (`intro_the_curse.mp4` + `intro_the_shattering.mp4`) and their player overlay (`src/cutscenes/introCutscene.ts` + `introSplash.ts`) are preserved on disk but **no longer imported from the boot graph** (`src/main.ts`). Per player feedback that the cutscenes were "too heavy," the boot was simplified to title-flow-direct in 2026-04-22. **This runbook is still canonical** for reproducing the production of either shipped cutscene or building new ones — the pipeline tooling is unchanged. Re-enabling the boot integration is a one-commit revert. See `docs/SESSION_2026_04_22_CUTSCENE_REMOVAL_AND_BOOT_TIGHTENING.md` for the removal diff and `LEARNINGS.md` for lessons learned.

**The exhaustive, command-by-command record of how the cutscene system was built and how every cutscene shipped so far was actually produced.** Use this as a runbook to reproduce any step, debug any output, or onboard a new agent into the cutscene production loop.

**Companion docs:**
- `docs/CUTSCENE_PIPELINE.md` — high-level recipe ("how to make a new cutscene")
- `LORE.md` — narrative bible (what to write *about*; characters, palette, voice rules)
- `PLAN.md` Phase 7 — delivery log (currently flagged with the 2026-04-22 unwiring)
- `GAME_MASTER.md` — system map
- `docs/SESSION_2026_04_22_CUTSCENE_REMOVAL_AND_BOOT_TIGHTENING.md` — 2026-04-22 boot-removal session

---

## 1. What this doc is

Three things in one:

1. **Toolchain reference.** Every install command, every script, every schema, every config.
2. **Production logs.** The actual commands run, in order, that produced `intro_the_curse.mp4` and `intro_the_shattering.mp4` — including the iteration loops (hand re-rolls, voice swaps, cackle SFX integration).
3. **Common-task playbook.** "Re-roll one still", "swap one voice", "add a sound effect", "add a new cutscene", "fix a broken render" — each with the exact commands.

If `docs/CUTSCENE_PIPELINE.md` is the "how to make a cutscene" recipe, this is the "what I literally typed to make these specific cutscenes" history.

---

## 2. Architecture (one-screen mental model)

```
[ shots.json ]                       (creative source of truth)
      |
      v
[ Pollinations.ai ]   ---->   public/stills/<id>.jpg     (original art, free, no key)
[ ComfyUI + Depthflow ] -->   public/clips/<id>.mp4      (2.5D parallax motion)
[ Piper TTS + ffmpeg ] -->    public/audio/<id>.wav      (narration with voice/pitch overrides)
[ optional: SFX ]      -->    public/sfx/<file>.ogg      (CC0 sound effects)
      |
      v
[ Remotion composition ] ---> output/<cutscene>.mp4      (final 1080p30 H.264)
      |
      v
[ Game integration ] ----->   idle deck/public/cutscenes/<cutscene>.mp4
                              + src/cutscenes/<player>.ts triggers it
```

**Key principles:**
- Every step is idempotent — safe to re-run any single piece without redoing the rest.
- All assets live OUTSIDE the game repo at `C:\Users\Limin\cutscenes\`. Only finished MP4s are copied into the game.
- Per-shot overrides (voice, motion preset) live in the shot list JSON so the data drives the pipeline, not the code.
- Game integration is a tiny overlay player that takes a video src and resolves on `ended` or skip — same player handles all cutscenes.

---

## 3. One-time install (everything you need)

These commands set up the entire toolchain from a stock Windows machine. Order matters in places (7-Zip needed before ComfyUI extract, ComfyUI needed before its custom nodes, etc.).

### 3.1 System prerequisites (verify, install if missing)

```powershell
# Verify (most likely already there on a dev machine)
python --version          # need 3.10+ — verified 3.11.9
node --version            # need 18+ — verified 22.22.0
git --version             # any recent — verified 2.53.0
ffmpeg -version           # need 4+ — verified 8.0.1 (gyan.dev build)
nvidia-smi                # for ComfyUI/Depthflow GPU work — verified RTX 4060 Ti 8GB
```

If any are missing, install via `winget`:
```powershell
winget install --id 7zip.7zip --silent --accept-source-agreements --accept-package-agreements
# python: download from python.org if missing
# node: winget install OpenJS.NodeJS.LTS
# git: winget install Git.Git
```

### 3.2 Workspace skeleton

```powershell
$ws = "C:\Users\Limin\cutscenes"
New-Item -ItemType Directory -Force -Path $ws,"$ws\tools","$ws\models","$ws\projects","$ws\output","$ws\scripts" | Out-Null
```

### 3.3 ComfyUI portable (for Depthflow)

```powershell
$ProgressPreference = 'SilentlyContinue'
$rel = Invoke-RestMethod "https://api.github.com/repos/comfyanonymous/ComfyUI/releases/latest"
$asset = $rel.assets | Where-Object { $_.name -eq "ComfyUI_windows_portable_nvidia.7z" }
Invoke-WebRequest $asset.browser_download_url -OutFile "C:\Users\Limin\cutscenes\tools\ComfyUI.7z" -UserAgent "Mozilla/5.0"
& "C:\Program Files\7-Zip\7z.exe" x "C:\Users\Limin\cutscenes\tools\ComfyUI.7z" -o"C:\Users\Limin\cutscenes\tools" -y
Remove-Item "C:\Users\Limin\cutscenes\tools\ComfyUI.7z"
```

### 3.4 ComfyUI custom nodes (Manager, Depthflow, DepthAnythingV2, VHS)

```powershell
cd "C:\Users\Limin\cutscenes\tools\ComfyUI_windows_portable\ComfyUI\custom_nodes"
git clone --depth 1 https://github.com/Comfy-Org/ComfyUI-Manager.git
git clone --depth 1 https://github.com/akatz-ai/ComfyUI-Depthflow-Nodes.git
git clone --depth 1 https://github.com/kijai/ComfyUI-DepthAnythingV2.git
git clone --depth 1 https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git

# Install Python deps for each into ComfyUI's embedded Python
$py = "C:\Users\Limin\cutscenes\tools\ComfyUI_windows_portable\python_embeded\python.exe"
$nodesRoot = "C:\Users\Limin\cutscenes\tools\ComfyUI_windows_portable\ComfyUI\custom_nodes"
foreach ($node in @("ComfyUI-Manager","ComfyUI-DepthAnythingV2","ComfyUI-Depthflow-Nodes","ComfyUI-VideoHelperSuite")) {
    & $py -m pip install -r "$nodesRoot\$node\requirements.txt" --no-warn-script-location
}
```

### 3.5 Piper TTS

```powershell
$piperDir = "C:\Users\Limin\cutscenes\tools\piper"
New-Item -ItemType Directory -Force -Path "$piperDir\voices" | Out-Null

# Download Piper Windows binary
Invoke-WebRequest "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip" `
    -OutFile "$piperDir\piper.zip" -UserAgent "Mozilla/5.0"
Expand-Archive -Path "$piperDir\piper.zip" -DestinationPath $piperDir -Force
Remove-Item "$piperDir\piper.zip"

# Download voice models (multiple — see §6 for the full inventory used in shipped cutscenes)
$base = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en"
$voices = @(
    @{lang="en_GB";name="alan";quality="medium"},               # protagonist (Vanguard)
    @{lang="en_GB";name="cori";quality="medium"},               # witch A (eastern)
    @{lang="en_GB";name="jenny_dioco";quality="medium"},        # witch B (iron-box)
    @{lang="en_US";name="kristin";quality="medium"},            # witch C (mocking)
    @{lang="en_US";name="amy";quality="medium"},                # backup female
    @{lang="en_US";name="lessac";quality="medium"},             # backup female
    @{lang="en_US";name="ryan";quality="medium"},               # explored, unused
    @{lang="en_US";name="norman";quality="medium"}              # explored, unused
)
foreach ($v in $voices) {
    $f = "$($v.lang)-$($v.name)-$($v.quality)"
    Invoke-WebRequest "$base/$($v.lang)/$($v.name)/$($v.quality)/$f.onnx"      -OutFile "$piperDir\voices\$f.onnx"      -UserAgent "Mozilla/5.0"
    Invoke-WebRequest "$base/$($v.lang)/$($v.name)/$($v.quality)/$f.onnx.json" -OutFile "$piperDir\voices\$f.onnx.json" -UserAgent "Mozilla/5.0"
}
```

### 3.6 Wan2GP (optional — installed but not yet used in production)

```powershell
cd "C:\Users\Limin\cutscenes\tools"
git clone --depth 1 https://github.com/deepbeepmeep/Wan2GP.git
cd Wan2GP
python setup.py install --env venv --auto
# Auto-install picks Python 3.11 + Torch 2.10 cu130 + Triton + SageAttn + FlashAttn + Nunchaku + GGUF kernels.
# ~10 min and ~5 GB on a fresh box. First I2V run downloads another ~5-10 GB of model weights.
```

### 3.7 Per-cutscene-project Remotion install

For each new cutscene, scaffold a Remotion project:

```powershell
$proj = "C:\Users\Limin\cutscenes\projects\<NEW_CUTSCENE_ID>"
New-Item -ItemType Directory -Force -Path $proj | Out-Null
cd $proj
npm init -y
npm install --save remotion@^4 @remotion/cli@^4 @remotion/bundler@^4 @remotion/renderer@^4 react@18 react-dom@18
npm install --save-dev typescript@5.6 @types/react@18 @types/react-dom@18 @types/node
```

Then copy the four `src/` template files (`index.ts`, `Root.tsx`, `Shot.tsx`, `TitleCard.tsx`) and `tsconfig.json`/`remotion.config.ts` from `C:\Users\Limin\cutscenes\projects\intro-the-curse\`. (For multi-cutscene work, just keep adding compositions to the existing `intro-the-curse` project — that's what we did for `TheCurse` + `TheShattering`.)

### 3.8 Booting ComfyUI (must be running for any Depthflow operation)

```powershell
cd "C:\Users\Limin\cutscenes\tools\ComfyUI_windows_portable"
.\python_embeded\python.exe -s ComfyUI\main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch
# Leave running in a separate terminal. Verify at http://127.0.0.1:8188
# Look for "🌊 DEPTHFLOW NODES 🌊" in boot log to confirm Depthflow loaded.
```

---

## 4. Workspace tree (annotated)

```
C:\Users\Limin\cutscenes\
│
├── tools\                                      # all installed tools (one-time)
│   │
│   ├── ComfyUI_windows_portable\               # 4 GB extracted; runs on port 8188
│   │   ├── python_embeded\python.exe           # use this Python for ComfyUI tasks
│   │   ├── run_nvidia_gpu.bat                  # alt boot script
│   │   └── ComfyUI\
│   │       ├── models\depthanything\           # Depth Anything V2 model weights live here
│   │       │   ├── depth_anything_v2_vits_fp32.safetensors  (~100 MB) auto-downloaded
│   │       │   └── depth_anything_v2_vitb_fp32.safetensors  (~370 MB) auto-downloaded
│   │       └── custom_nodes\
│   │           ├── ComfyUI-Manager\
│   │           ├── ComfyUI-Depthflow-Nodes\    # the Depthflow integration
│   │           ├── ComfyUI-DepthAnythingV2\    # depth-map generation node
│   │           └── ComfyUI-VideoHelperSuite\   # VHS_LoadImagePath, VHS_VideoCombine
│   │
│   ├── Wan2GP\                                 # optional, installed but unused so far
│   │   └── env_venv\                           # auto-created venv
│   │
│   └── piper\
│       ├── piper\piper.exe                     # Windows binary
│       └── voices\                             # ONNX voice models (see §6)
│           ├── en_GB-alan-medium.onnx          # PROTAGONIST: the Vanguard
│           ├── en_GB-cori-medium.onnx          # WITCH A: eastern coven witch
│           ├── en_GB-jenny_dioco-medium.onnx   # WITCH B: iron-box witch
│           ├── en_US-kristin-medium.onnx       # WITCH C: mocking witch
│           ├── en_US-amy-medium.onnx           # backup
│           ├── en_US-lessac-medium.onnx        # backup
│           ├── en_US-ryan-medium.onnx          # explored, unused
│           └── en_US-norman-medium.onnx        # explored, unused
│
├── scripts\                                    # the 4 pipeline drivers
│   ├── gen_stills.py                           # Pollinations → stills
│   ├── gen_narration.py                        # Piper → WAVs (per-shot voice override + pitch shift)
│   ├── depthflow_run.py                        # one image → one parallax MP4 (ComfyUI API)
│   └── depthflow_batch.py                      # batch driver over a shot list
│
├── projects\
│   └── intro-the-curse\                        # ONE Remotion project hosts BOTH cutscenes
│       ├── package.json
│       ├── tsconfig.json
│       ├── remotion.config.ts
│       │
│       ├── shots.json                          # CURSE shot list (8 shots)
│       ├── shots_shattering.json               # SHATTERING shot list (11 shots)
│       │
│       ├── shots_regen_*.json                  # one-off temp shot lists used during iteration
│       ├── shots_s7d_redo.json                 # one-off for s7d hand-fix re-roll
│       ├── shots_depthflow_final.json          # one-off for Depthflow batch on subset
│       │
│       ├── public\                             # Remotion's static asset folder
│       │   ├── audio\
│       │   │   ├── music.ogg                   # CC0 ambient bed (only used by TheCurse)
│       │   │   ├── 01_vanguard.wav   .. 08_title.wav        # CURSE narrations
│       │   │   └── narration_smoke.wav         # vestigial smoke-test wav
│       │   ├── audio_shattering\
│       │   │   ├── s1_bloodline_river.wav .. s8_the_vow.wav # SHATTERING narrations
│       │   │   └── s7d_witch_mocking.wav       # CACKLE BAKED IN: kristin line + 0.4s + cackle SFX
│       │   ├── stills\
│       │   │   ├── 01_vanguard.jpg .. 07_fall.jpg, test_sorcerer.jpg     # CURSE stills
│       │   │   └── 02_mira.jpg
│       │   ├── stills_shattering\
│       │   │   └── s1_bloodline_river.jpg .. s7d_witch_mocking.jpg       # SHATTERING stills
│       │   ├── stills_regen_review\            # iteration scratch — re-rolls before approval
│       │   ├── clips\                          # Depthflow MP4s (CURSE)
│       │   ├── clips_shattering\               # Depthflow MP4s (SHATTERING)
│       │   └── sfx\                            # CC0 sound effects + intermediate audio
│       │       ├── witch_cackle.ogg            # very short cackle (rejected)
│       │       ├── evil_cackle_laugh_1.ogg     # 9.3s cackle (option 1, rejected)
│       │       ├── evil_cackle_laugh_2.ogg     # 2.8s cackle (option 2, rejected)
│       │       ├── ghostly_cackle_laugh_1.ogg  # 4.2s cackle (option 3, USED)
│       │       ├── ghostly_cackle_laugh_1.wav  # mono 22050 conversion of above
│       │       ├── silence.wav                 # 0.4s silence used in concat
│       │       └── concat_*.txt                # ffmpeg concat-demuxer file lists
│       │
│       ├── src\
│       │   ├── index.ts                        # registerRoot(RemotionRoot)
│       │   ├── Root.tsx                        # registers ALL compositions
│       │   ├── shots.ts                        # imports shots.json
│       │   ├── shots_shattering.ts             # imports shots_shattering.json
│       │   ├── Shot.tsx                        # generic per-shot component (clipsDir/audioDir props)
│       │   ├── TitleCard.tsx                   # terminal title-card component (audioDir/brandText/titleText props)
│       │   ├── TheCurse.tsx                    # CURSE composition (uses clips/, audio/, music bed)
│       │   ├── TheShattering.tsx               # SHATTERING composition (uses clips_shattering/, audio_shattering/, NO music)
│       │   ├── Placeholder.tsx                 # original smoke-test composition
│       │   └── Smoke.tsx                       # smoke-test composition
│       │
│       └── out\                                # Remotion intermediate render targets
│
├── output\                                     # FINAL render targets — only these get copied to the game
│   ├── intro_the_curse_FINAL.mp4              # 32.8 MB, 51s — shipped as game's intro_the_curse.mp4
│   ├── intro_the_shattering_FINAL.mp4         # 47.7 MB, ~76s — shipped as game's intro_the_shattering.mp4
│   ├── intro_the_curse.mp4 / _v2 / _v3        # iteration history
│   ├── intro_the_shattering.mp4 / _v2         # iteration history
│   ├── voice_tests\                            # WAV samples used to A/B/C voices
│   ├── tc_*.jpg, shat_*.jpg                    # ffmpeg-extracted preview frames
│   └── depthflow_smoke.mp4                     # earliest pipeline test
│
├── REVIEW\                                     # human-review staging folders
│   ├── new_stills\                             # stills awaiting approve/reroll
│   │   ├── *.jpg
│   │   └── READ_ME_FIRST.txt / READ_ME_S7D.txt # human-readable instructions per batch
│   └── voices_for_witches\                     # voice-pick A/B/C tests + cackle options
│       ├── *.wav
│       └── READ_ME_FIRST.txt / READ_ME_S7D_CACKLE.txt
│
└── models\                                     # raw downloaded model weights (some redundant with ComfyUI's path)
    └── depth_anything_v2\
```

---

## 5. Script reference (`scripts/`)

All four scripts are idempotent. Re-running them overwrites their outputs.

### 5.1 `gen_stills.py`

Generate stills via Pollinations.ai (FLUX). Free, no API key. **Pollinations rate-limits to ~1 concurrent request per IP**, so use `--workers 1` in production.

```
python scripts/gen_stills.py <shot_list.json> <out_dir> [--width 1920] [--height 1080] [--workers 1]
```

Shot list format (minimal — only `id`, `seed`, `prompt` required):
```json
[
  { "id": "01_vanguard", "seed": 11, "prompt": "dark fantasy oil painting, ..." },
  ...
]
```

Output: `<out_dir>/<id>.jpg` per shot.

Notes:
- Pollinations free tier ignores the requested dimensions and returns 1024×576. Acceptable — Depthflow + Remotion at 1080p output looks fine because of motion + vignette.
- Same `seed` + same `prompt` returns a cached result in ~1s. Different seed = fresh generation (~30-90s).
- The script auto-retries once after a 429 with a 30s backoff.

### 5.2 `gen_narration.py`

Pipe each shot's `narration` field through Piper TTS. Supports per-shot voice/pitch/length overrides via shot fields, plus FFmpeg pitch-shift post-processing.

```
python scripts/gen_narration.py <shot_list.json> <out_dir> \
    [--voice <onnx-path>]              # default: en_GB-alan-medium (the Vanguard)
    [--length-scale 1.05]              # >1 slows, <1 speeds. Default for Vanguard: 1.3
    [--pitch 1.0]                      # <1 lower, >1 higher. Default for Vanguard: 0.93
    [--noise-scale 0.667]
    [--noise-w 0.8]
    [--speaker N]                      # for multi-speaker voice models
```

Per-shot overrides (any combination):
```json
{
  "id": "s7c_witch_iron",
  "narration": "Keep yours close...",
  "voice": "en_GB-jenny_dioco-medium",   // looks up sibling .onnx in same voices dir
  "voice_length": 1.1,                    // overrides --length-scale for this shot
  "voice_pitch": 1.0                      // overrides --pitch for this shot
}
```

Output: `<out_dir>/<id>.wav` per shot.

Pitch shift trick: uses `asetrate` (lowers pitch + lengthens duration) chained with `atempo` (restores duration), avoiding the need for the `rubberband` filter.

### 5.3 `depthflow_run.py`

Drive ComfyUI to apply Depthflow 2.5D parallax to a single image.

```
python scripts/depthflow_run.py <input.jpg> <output.mp4> \
    [--seconds 5] \
    [--motion orbital]                # orbital | dolly | circle | horizontal | vertical | zoom
```

ComfyUI must be running on port 8188. The script:
1. Builds a workflow JSON with `VHS_LoadImagePath` → `DownloadAndLoadDepthAnythingV2Model` → `DepthAnything_V2` → `DepthflowMotionPreset<Motion>` → `DepthflowEffectVignette` → `DepthflowEffectDOF` → `Depthflow` → `VHS_VideoCombine`.
2. POSTs to `/prompt`, polls `/history/<id>` until done.
3. Fetches the resulting MP4 from `/view` and saves to `output`.

Defaults baked in (tune `MOTION_PRESETS` dict in the script for per-preset adjustments):
- Vignette: `intensity=0.45, decay=25` (heavy edge darkening)
- DOF: `start=0.55, end=1.0, intensity=0.7` (background blur)
- Output: 30 fps H.264 MP4

### 5.4 `depthflow_batch.py`

Loop `depthflow_run.py` over every shot in a list whose `motion` is a Depthflow preset. Skips `motion: title`.

```
python scripts/depthflow_batch.py <shot_list.json> <stills_dir> <out_dir>
```

Per-shot fields used: `id`, `motion`, `duration`. Other fields ignored (so you can pass the full `shots.json` or a trimmed subset).

---

## 6. Voice library (Piper voices)

All voices are CC0 from https://huggingface.co/rhasspy/piper-voices.

| Voice file | Vibe | Used for |
|---|---|---|
| `en_GB-alan-medium.onnx` | British male, mid-aged | **The Vanguard Wizard** narrator (length 1.3, pitch 0.93) |
| `en_GB-cori-medium.onnx` | British female, calm/eerie | **WITCH A** — `s7b_witch_eastern` (length 1.05, pitch 1.0) |
| `en_GB-jenny_dioco-medium.onnx` | British female, softer | **WITCH B** — `s7c_witch_iron` (length 1.1, pitch 1.0) |
| `en_US-kristin-medium.onnx` | American female, warm-cool | **WITCH C** — `s7d_witch_mocking` (length 1.0, pitch 1.0) |
| `en_US-amy-medium.onnx` | American female, neutral | Backup / future use |
| `en_US-lessac-medium.onnx` | American female, flat-cold | Backup / future use |
| `en_US-ryan-medium.onnx` | American tenor (male) | Tested for in-the-moment Vanguard, unused |
| `en_US-norman-medium.onnx` | American older male | Tested as witch voice, replaced when user asked for all-female |

Adding a new voice: drop the `.onnx` + `.onnx.json` pair into `tools/piper/voices/`. Reference by `en_XX-name-quality` in shot list `voice` field.

---

## 7. SFX library (CC0 sound effects)

All in `projects/intro-the-curse/public/sfx/`. CC0 = free for any use, no credit required.

| File | Source | Length | Used? |
|---|---|---|---|
| `witch_cackle.ogg` | OpenGameArt — AntumDeluge | 1.16s | Tried, rejected (too short) |
| `evil_cackle_laugh_1.ogg` | OpenGameArt — AuraVoice | 9.29s | Option 1 (not picked) |
| `evil_cackle_laugh_2.ogg` | OpenGameArt — AuraVoice | 2.78s | Option 2 (not picked) |
| `ghostly_cackle_laugh_1.ogg` | OpenGameArt — AuraVoice | 4.20s | **Option 3 — IN USE** at end of `s7d` |
| `silence.wav` | ffmpeg `anullsrc` | 0.4s | Spacer between Piper line and SFX in concat |

**The cackle integration trick** (Piper can't synthesize realistic laughter from "ha ha ha" text):

```powershell
# 1. Generate the spoken line WITHOUT fake "haha"
$cleanLine = "Let him chase us. He has no power. He has no daughter. He has only... cards."
$cleanLine | & piper.exe --model en_US-kristin-medium.onnx --output_file s7d.wav --length_scale 1.0

# 2. Convert SFX to matching format (mono 22050 Hz)
ffmpeg -y -i ghostly_cackle_laugh_1.ogg -ar 22050 -ac 1 ghostly_cackle_laugh_1.wav

# 3. Generate 0.4s of silence (matching format)
ffmpeg -y -f lavfi -i "anullsrc=r=22050:cl=mono" -t 0.4 -ar 22050 -ac 1 silence.wav

# 4. Concat via demuxer (NOT the `concat:` URL — that fails silently for WAVs)
$listFile = "concat_final.txt"
"file 'absolute/path/to/s7d.wav'`nfile 'absolute/path/to/silence.wav'`nfile 'absolute/path/to/ghostly_cackle_laugh_1.wav'" | Set-Content $listFile -Encoding ASCII
ffmpeg -y -f concat -safe 0 -i $listFile -ar 22050 -ac 1 s7d_with_cackle.wav
# Result: spoken line → 0.4s pause → real cackle, all in one WAV
```

Final shot duration (`shots_shattering.json` → `s7d.duration`) must be ≥ the concatenated WAV length. For the shipped cackle: spoken ~5.5s + silence 0.4s + cackle 4.2s = ~10.1s → set `duration: 10.8` for breathing room.

---

## 8. shots.json schema (canonical)

```typescript
type Shot = {
  // REQUIRED
  id: string;            // unique slug, used as filename root for stills/clips/audio
  seed: number;          // Pollinations seed for reproducibility (use 0 for non-image shots like title cards)
  narration: string;     // Piper says this. Empty string = no audio for this shot.
  motion: "orbital" | "dolly" | "circle" | "horizontal" | "vertical" | "zoom"
        | "title"        // skipped by Depthflow; rendered by TitleCard component
        | "wan_i2v";     // reserved for future Wan2GP I2V; currently no-op
  duration: number;      // seconds. Must be ≥ narration audio length + ~0.5s breathing room
  prompt: string;        // empty for "title" shots, otherwise the Pollinations prompt

  // OPTIONAL — per-shot voice overrides (else falls back to gen_narration.py CLI defaults)
  voice?: string;        // e.g. "en_GB-jenny_dioco-medium" — looks up <voice>.onnx in tools/piper/voices/
  voice_length?: number; // overrides --length-scale for this shot
  voice_pitch?: number;  // overrides --pitch for this shot
};
```

---

## 9. Production log: `intro_the_curse` (8 shots, ~51s)

The exact command sequence that produced the curse cutscene, with iteration steps. Started from a clean Remotion project.

### 9.1 Initial run (8 shots)

```powershell
cd C:\Users\Limin\cutscenes\projects\intro-the-curse

# 1. Write shots.json with 8 shots (see file in repo for the canonical content)

# 2. Generate stills (sequential, ~3-5 min total at ~30-90s each due to Pollinations rate limit)
python C:\Users\Limin\cutscenes\scripts\gen_stills.py shots.json public\stills --workers 1

# 3. Generate narrations (Vanguard voice, slow + slightly aged)
python C:\Users\Limin\cutscenes\scripts\gen_narration.py shots.json public\audio --length-scale 1.3 --pitch 0.93

# 4. Render Depthflow on shots 1-7 (shot 8 is the title card, auto-skipped)
python C:\Users\Limin\cutscenes\scripts\depthflow_batch.py shots.json public\stills public\clips

# 5. Copy ambient music bed from the game
Copy-Item "C:\Users\Limin\idle deck\public\audio\music\menu-01.ogg" public\audio\music.ogg -Force

# 6. Render the master MP4
npx remotion render src/index.ts TheCurse C:\Users\Limin\cutscenes\output\intro_the_curse.mp4

# 7. Copy into game
Copy-Item C:\Users\Limin\cutscenes\output\intro_the_curse.mp4 "C:\Users\Limin\idle deck\public\cutscenes\intro_the_curse.mp4" -Force
```

### 9.2 Iteration 1 — old voice was too vigorous

```powershell
# Re-generate ALL narrations with new settings
python C:\Users\Limin\cutscenes\scripts\gen_narration.py shots.json public\audio --length-scale 1.3 --pitch 0.93
# (these became the canonical Vanguard settings)
npx remotion render src/index.ts TheCurse C:\Users\Limin\cutscenes\output\intro_the_curse_v2.mp4
```

### 9.3 Iteration 2 — `01_vanguard` had crab-claw hands

Two re-rolls before approval. Final approved version: Tang-scholar pose with arms folded, hands tucked into opposite sleeves.

```powershell
# Write a one-shot temp shots_regen_3.json with the new prompt for 01_vanguard at seed 3001
# (see the file in the project root; key change: arms folded across chest, sleeves cover hands)

python C:\Users\Limin\cutscenes\scripts\gen_stills.py shots_regen_3.json public\stills_regen_review --workers 1
# Manual review: inspect public\stills_regen_review\01_vanguard.jpg

# After approval: copy to canonical location
Copy-Item public\stills_regen_review\01_vanguard.jpg public\stills\01_vanguard.jpg -Force

# Re-Depthflow just that one shot
python C:\Users\Limin\cutscenes\scripts\depthflow_run.py public\stills\01_vanguard.jpg public\clips\01_vanguard.mp4 --seconds 7.0 --motion orbital

# Re-render the master
npx remotion render src/index.ts TheCurse C:\Users\Limin\cutscenes\output\intro_the_curse_FINAL.mp4
Copy-Item C:\Users\Limin\cutscenes\output\intro_the_curse_FINAL.mp4 "C:\Users\Limin\idle deck\public\cutscenes\intro_the_curse.mp4" -Force
```

**Final state:** `intro_the_curse.mp4` 32.8 MB, 51s, 8 shots, music bed enabled, Tang-scholar opener.

---

## 10. Production log: `intro_the_shattering` (11 shots, ~76s)

Same project, second composition (`TheShattering`). Built second after the curse, with additional iteration on hand-fixes, witch voices, and a real cackle SFX.

### 10.1 Initial run (8 shots)

```powershell
cd C:\Users\Limin\cutscenes\projects\intro-the-curse

# Wrote shots_shattering.json with 8 shots (s1-s7 + s8_the_vow title card)

# Created separate output folders to avoid clashing with curse assets
New-Item -ItemType Directory -Force -Path public\stills_shattering, public\clips_shattering, public\audio_shattering | Out-Null

python C:\Users\Limin\cutscenes\scripts\gen_stills.py     shots_shattering.json public\stills_shattering --workers 1
python C:\Users\Limin\cutscenes\scripts\gen_narration.py  shots_shattering.json public\audio_shattering --length-scale 1.3 --pitch 0.93
python C:\Users\Limin\cutscenes\scripts\depthflow_batch.py shots_shattering.json public\stills_shattering public\clips_shattering

# Wrote src/shots_shattering.ts and src/TheShattering.tsx
# Registered TheShattering composition in src/Root.tsx
# (Shot.tsx and TitleCard.tsx generalized at this point with clipsDir/audioDir props)

npx remotion render src/index.ts TheShattering C:\Users\Limin\cutscenes\output\intro_the_shattering.mp4
Copy-Item C:\Users\Limin\cutscenes\output\intro_the_shattering.mp4 "C:\Users\Limin\idle deck\public\cutscenes\intro_the_shattering.mp4" -Force
```

### 10.2 Iteration 1 — placement change (game integration)

Moved cutscene from "before start flow" to "after Begin click, before game appears". Pure code change in `idle deck/src/main.ts`. See §11.

### 10.3 Iteration 2 — drop music (game audio plays underneath)

Removed the `<Audio src="music.ogg">` block from `src/TheShattering.tsx`. Re-rendered:

```powershell
npx remotion render src/index.ts TheShattering C:\Users\Limin\cutscenes\output\intro_the_shattering_v2.mp4
```

### 10.4 Iteration 3 — fix hands on `s1_bloodline_river`, add 3 witch shots, witches need voices

This was the big batch.

**Step A — extend `gen_narration.py` to support per-shot voice override** (already done — see §5.2).

**Step B — update `shots_shattering.json`:**
- Replace `s1_bloodline_river` prompt (side-profile, arms folded, river spiral around body)
- Insert `s7b_witch_eastern`, `s7c_witch_iron`, `s7d_witch_mocking` between `s7_the_taking` and `s8_the_vow`
- Each new witch shot has `voice`, `voice_length`, `voice_pitch` fields

**Step C — update `src/TheShattering.tsx` ORDER array** to include the 3 new IDs.

**Step D — generate new stills sequentially** (4 stills total: s1 + 3 witches):

```powershell
# Wrote shots_regen_4.json with [s1_bloodline_river, s7b_witch_eastern, s7c_witch_iron, s7d_witch_mocking]
python C:\Users\Limin\cutscenes\scripts\gen_stills.py shots_regen_4.json public\stills_shattering --workers 1
```

**Step E — regenerate all narrations** (witch voices applied via per-shot overrides):

```powershell
python C:\Users\Limin\cutscenes\scripts\gen_narration.py shots_shattering.json public\audio_shattering --length-scale 1.3 --pitch 0.93
```

**Step F — Depthflow the new clips:**

```powershell
# Wrote shots_depthflow_4.json with just the 4 new shot IDs + their motion presets
python C:\Users\Limin\cutscenes\scripts\depthflow_batch.py shots_depthflow_4.json public\stills_shattering public\clips_shattering
```

**Step G — re-render:**

```powershell
npx remotion render src/index.ts TheShattering C:\Users\Limin\cutscenes\output\intro_the_shattering_v3.mp4
```

### 10.5 Iteration 4 — re-roll s7c (back-view), s7d (face-only), all-female voices, cackle SFX

**S7c re-roll** — back-view composition so no hands in frame. Wrote `shots_regen_3.json` with new prompts for `01_vanguard`, `s7c_witch_iron`, `s7d_witch_mocking`. Generated to a review folder for human approval:

```powershell
python C:\Users\Limin\cutscenes\scripts\gen_stills.py shots_regen_3.json public\stills_regen_review --workers 1
```

**S7d re-roll** — face-only old hag witch. Wrote `shots_s7d_redo.json` with explicit "no body / hood / scattered cards" prompt and new seed 4099:

```powershell
python C:\Users\Limin\cutscenes\scripts\gen_stills.py shots_s7d_redo.json C:\Users\Limin\cutscenes\REVIEW\new_stills --workers 1
```

**Voice exploration** — downloaded 4 additional Piper female voices (cori, jenny_dioco, kristin, amy, lessac), generated 5 sample WAVs all saying the same witch line, presented in `REVIEW\voices_for_witches\` with a `READ_ME_FIRST.txt`:

```powershell
$piper = "C:\Users\Limin\cutscenes\tools\piper\piper\piper.exe"
$voices = "C:\Users\Limin\cutscenes\tools\piper\voices"
$out = "C:\Users\Limin\cutscenes\REVIEW\voices_for_witches"
$line = "Let him chase us. He has no power. He has no daughter. He has only cards."
foreach ($v in @("en_GB-cori-medium","en_GB-jenny_dioco-medium","en_US-kristin-medium","en_US-amy-medium","en_US-lessac-medium")) {
    $line | & $piper --model "$voices\$v.onnx" --output_file "$out\$v.wav" --length_scale 1.05 --noise_scale 0.667 --noise_w 0.8
}
```

**User picks A (cori) / B (jenny_dioco) / C (kristin)** for the three witches in order.

**Cackle SFX** — Piper can't synthesize realistic laughter from "ha ha ha" text. Downloaded 3 CC0 cackle options from OpenGameArt (AuraVoice), concatenated each with kristin's clean spoken line, presented for review:

```powershell
$sfxDir = "public\sfx"
foreach ($sfx in @("evil_cackle_laugh_1.ogg","evil_cackle_laugh_2.ogg","ghostly_cackle_laugh_1.ogg")) {
    Invoke-WebRequest "https://opengameart.org/sites/default/files/$sfx" -OutFile "$sfxDir\$sfx" -UserAgent "Mozilla/5.0"
}
# Convert each to matching mono 22050 WAV, then concat with kristin's clean line + 0.4s silence
# (see §7 for the full concat recipe)
```

**User picks Option 3 (`ghostly_cackle_laugh_1.ogg`, 4.2s).**

**Final batch:**

```powershell
# Update shots_shattering.json: s7d → voice=kristin, length=1.0, pitch=1.0, duration=10.8 (room for the cackle)
# Update s7c voice to en_GB-jenny_dioco-medium

# Copy approved stills to canonical paths
Copy-Item REVIEW\new_stills\01_vanguard_NEW.jpg        public\stills\01_vanguard.jpg -Force
Copy-Item REVIEW\new_stills\s7c_witch_iron_NEW.jpg     public\stills_shattering\s7c_witch_iron.jpg -Force
Copy-Item REVIEW\new_stills\s7d_witch_mocking_v2.jpg   public\stills_shattering\s7d_witch_mocking.jpg -Force

# Depthflow only the changed shots
python C:\Users\Limin\cutscenes\scripts\depthflow_run.py    public\stills\01_vanguard.jpg public\clips\01_vanguard.mp4 --seconds 7.0 --motion orbital
python C:\Users\Limin\cutscenes\scripts\depthflow_batch.py  shots_depthflow_final.json public\stills_shattering public\clips_shattering
# (where shots_depthflow_final.json contains just s7c_witch_iron and s7d_witch_mocking)

# Regenerate ALL narrations (cheap — ~8s for 11 shots)
python C:\Users\Limin\cutscenes\scripts\gen_narration.py shots_shattering.json public\audio_shattering --length-scale 1.3 --pitch 0.93

# Bake the cackle into s7d's WAV (replaces the file in place)
ffmpeg -y -f lavfi -i "anullsrc=r=22050:cl=mono" -t 0.4 -ar 22050 -ac 1 public\sfx\silence.wav
ffmpeg -y -i public\sfx\ghostly_cackle_laugh_1.ogg -ar 22050 -ac 1 public\sfx\ghostly_cackle_laugh_1.wav
$listFile = "public\sfx\concat_final.txt"
"file 'public/audio_shattering/s7d_witch_mocking.wav'`nfile 'public/sfx/silence.wav'`nfile 'public/sfx/ghostly_cackle_laugh_1.wav'" | Set-Content $listFile -Encoding ASCII
ffmpeg -y -f concat -safe 0 -i $listFile -ar 22050 -ac 1 public\audio_shattering\s7d_witch_mocking_BAKED.wav
Move-Item public\audio_shattering\s7d_witch_mocking_BAKED.wav public\audio_shattering\s7d_witch_mocking.wav -Force

# Re-render
npx remotion render src/index.ts TheShattering C:\Users\Limin\cutscenes\output\intro_the_shattering_FINAL.mp4
Copy-Item C:\Users\Limin\cutscenes\output\intro_the_shattering_FINAL.mp4 "C:\Users\Limin\idle deck\public\cutscenes\intro_the_shattering.mp4" -Force
```

**Final state:** `intro_the_shattering.mp4` 47.7 MB, ~76s, 11 shots, no music bed, three female witch voices, real cackle SFX baked into s7d.

---

## 11. Game integration (in `idle deck/`)

Two cutscene-specific files + edits to two existing files.

### 11.1 New files

**`src/cutscenes/introSplash.ts`** — "press anywhere to begin" gate. Single user gesture unlocks autoplay-with-audio for all subsequent cutscenes.

**`src/cutscenes/introCutscene.ts`** — generic cutscene overlay player. Takes `videoSrc` + `ariaLabel` options, mounts a fullscreen overlay (z-index 99999), plays the video, supports skip via Skip button (1.5s grace) / Esc / Space / Enter, resolves on `ended` or skip.

```typescript
export const INTRO_VIDEOS = {
  curse:      'cutscenes/intro_the_curse.mp4',
  shattering: 'cutscenes/intro_the_shattering.mp4',
} as const;

export function playIntroCutscene(parent, options): Promise<void>;
```

### 11.2 Modified files

**`src/main.ts`** — wires the splash + cutscenes into the boot flow.

```
Page load
    ↓
[ TAP-TO-BEGIN SPLASH ]      <- presentIntroSplash(appRoot)
    ↓
[ INTRO_THE_CURSE ]          <- playIntroCutscene(appRoot, {videoSrc: INTRO_VIDEOS.curse})
    ↓
[ START FLOW ]               <- showStartFlow() (mountStartFlow with Begin/Continue/New)
    ↓ Begin/Continue/New
[ enterGame ]                <- mountApp + dock preload
    ↓
[ INTRO_THE_SHATTERING ]     <- playIntroCutscene(appRoot, {videoSrc: INTRO_VIDEOS.shattering})
                                (game UI is mounted at z-index 0; cutscene overlays at z 99999)
    ↓
[ GAME ]                     <- cutscene overlay removes itself, game is visible underneath
```

**`src/core/gameStore.ts:reset()`** — clears the cutscene seen-flag so a Reset All Progress replays the intro chain.

```typescript
reset(): void {
  setBattleMusicMode(false);
  getRoomHub().leaveRoom();
  try {
    localStorage.removeItem('idle-craft-intro-cutscene-seen-v1');
  } catch { /* private mode */ }
  this.state = createInitialState();
  this.emit();
}
```

### 11.3 Game-side file tree

```
idle deck/
├── public/
│   ├── cutscenes/
│   │   ├── intro_the_curse.mp4         # ⇐ copied from C:\Users\Limin\cutscenes\output\
│   │   └── intro_the_shattering.mp4    # ⇐ copied from C:\Users\Limin\cutscenes\output\
│   └── audio/music/                    # CC0 game music; menu-01.ogg used as cutscene bed for TheCurse
└── src/
    ├── main.ts                          # bootIntroExperience() + enterGame() wire it all up
    ├── cutscenes/
    │   ├── introSplash.ts/.css         # press-anywhere gate
    │   └── introCutscene.ts/.css       # generic overlay player
    └── core/
        └── gameStore.ts                # reset() clears the cutscene flag
```

---

## 12. Common-task playbook

### 12.1 Re-roll a single still

```powershell
cd C:\Users\Limin\cutscenes\projects\intro-the-curse

# Make a one-shot temp file
'[{"id": "01_vanguard", "seed": 9001, "prompt": "<new prompt>"}]' | Set-Content tmp.json -Encoding utf8

# Generate to a review folder for human approval
python C:\Users\Limin\cutscenes\scripts\gen_stills.py tmp.json C:\Users\Limin\cutscenes\REVIEW\new_stills --workers 1

# Inspect, then if good:
Copy-Item C:\Users\Limin\cutscenes\REVIEW\new_stills\01_vanguard.jpg public\stills\01_vanguard.jpg -Force

# Re-Depthflow just that shot
python C:\Users\Limin\cutscenes\scripts\depthflow_run.py public\stills\01_vanguard.jpg public\clips\01_vanguard.mp4 --seconds 7.0 --motion orbital

# Re-render the affected master
npx remotion render src/index.ts TheCurse C:\Users\Limin\cutscenes\output\intro_the_curse.mp4

Remove-Item tmp.json
```

### 12.2 Swap one voice without touching anything else

Edit the shot's `voice` / `voice_length` / `voice_pitch` fields in `shots_shattering.json`, then:

```powershell
python C:\Users\Limin\cutscenes\scripts\gen_narration.py shots_shattering.json public\audio_shattering --length-scale 1.3 --pitch 0.93
npx remotion render src/index.ts TheShattering C:\Users\Limin\cutscenes\output\intro_the_shattering.mp4
```

(The narration regen is fast — ~8s for 11 shots — so just regenerate all of them.)

### 12.3 Add a sound effect to a shot

1. Drop the SFX file in `public/sfx/` (download from OpenGameArt / Pixabay / Freesound CC0).
2. Convert to mono 22050 Hz WAV: `ffmpeg -y -i input.ogg -ar 22050 -ac 1 output.wav`
3. Concat with the shot's narration WAV via the demuxer recipe in §7.
4. Bump the shot's `duration` in shots JSON to fit the new WAV length.
5. Re-render the master.

### 12.4 Add a new cutscene

1. Write a new shot list `shots_<name>.json` (use existing as template).
2. Optionally: separate `stills_<name>/`, `clips_<name>/`, `audio_<name>/` dirs (or share with curse if no name collisions).
3. `gen_stills.py` → `gen_narration.py` → `depthflow_batch.py`.
4. Write `src/shots_<name>.ts` and `src/The<Name>.tsx` (clone TheShattering as template — change `ORDER`, `CLIPS_DIR`, `AUDIO_DIR`, optional music bed).
5. Register the composition in `src/Root.tsx`.
6. Render, copy to `idle deck/public/cutscenes/`.
7. Add to `INTRO_VIDEOS` map in `idle deck/src/cutscenes/introCutscene.ts`.
8. Wire into the game flow in `idle deck/src/main.ts` at the appropriate point.

### 12.5 ComfyUI is down / Depthflow returning HTTP 400

```powershell
# Check
Get-NetTCPConnection -LocalPort 8188 -State Listen -ErrorAction SilentlyContinue

# Restart
cd "C:\Users\Limin\cutscenes\tools\ComfyUI_windows_portable"
.\python_embeded\python.exe -s ComfyUI\main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch
# Wait for "🌊 DEPTHFLOW NODES 🌊" and "Starting server" in log before retrying
```

If `depthflow_run.py` returns HTTP 400 specifically, it's almost always a motion-preset input mismatch — different presets have different required fields (`MOTION_PRESETS` dict in the script has the canonical defaults).

### 12.6 Pollinations rate-limit (HTTP 429)

`gen_stills.py` already auto-retries once with a 30s backoff. If you still hit 429s, you tried with `--workers > 1`. Use `--workers 1` always.

---

## 13. End-to-end reproducibility check

The minimum command set to fully rebuild both shipped cutscenes from scratch (assumes §3 install is complete and ComfyUI is running):

```powershell
cd C:\Users\Limin\cutscenes\projects\intro-the-curse

# CURSE
python C:\Users\Limin\cutscenes\scripts\gen_stills.py     shots.json public\stills --workers 1
python C:\Users\Limin\cutscenes\scripts\gen_narration.py  shots.json public\audio --length-scale 1.3 --pitch 0.93
python C:\Users\Limin\cutscenes\scripts\depthflow_batch.py shots.json public\stills public\clips
Copy-Item "C:\Users\Limin\idle deck\public\audio\music\menu-01.ogg" public\audio\music.ogg -Force
npx remotion render src/index.ts TheCurse C:\Users\Limin\cutscenes\output\intro_the_curse.mp4

# SHATTERING
python C:\Users\Limin\cutscenes\scripts\gen_stills.py     shots_shattering.json public\stills_shattering --workers 1
python C:\Users\Limin\cutscenes\scripts\gen_narration.py  shots_shattering.json public\audio_shattering --length-scale 1.3 --pitch 0.93
python C:\Users\Limin\cutscenes\scripts\depthflow_batch.py shots_shattering.json public\stills_shattering public\clips_shattering

# Cackle bake-in for s7d
ffmpeg -y -f lavfi -i "anullsrc=r=22050:cl=mono" -t 0.4 -ar 22050 -ac 1 public\sfx\silence.wav
ffmpeg -y -i public\sfx\ghostly_cackle_laugh_1.ogg -ar 22050 -ac 1 public\sfx\ghostly_cackle_laugh_1.wav
"file 'public/audio_shattering/s7d_witch_mocking.wav'`nfile 'public/sfx/silence.wav'`nfile 'public/sfx/ghostly_cackle_laugh_1.wav'" | Set-Content public\sfx\concat_final.txt -Encoding ASCII
ffmpeg -y -f concat -safe 0 -i public\sfx\concat_final.txt -ar 22050 -ac 1 public\audio_shattering\_baked.wav
Move-Item public\audio_shattering\_baked.wav public\audio_shattering\s7d_witch_mocking.wav -Force

npx remotion render src/index.ts TheShattering C:\Users\Limin\cutscenes\output\intro_the_shattering.mp4

# COPY TO GAME
Copy-Item C:\Users\Limin\cutscenes\output\intro_the_curse.mp4      "C:\Users\Limin\idle deck\public\cutscenes\intro_the_curse.mp4" -Force
Copy-Item C:\Users\Limin\cutscenes\output\intro_the_shattering.mp4 "C:\Users\Limin\idle deck\public\cutscenes\intro_the_shattering.mp4" -Force
```

Total wall time on the dev machine: ~25 minutes (mostly Pollinations stills @ ~30-90s each).

---

## 14. Why each design choice

| Choice | Why |
|---|---|
| Cutscene workspace OUTSIDE the game repo | Keeps the game lightweight (no node_modules / model weights / Python venvs in the game). Only finished MP4s ship. |
| ONE Remotion project hosting BOTH cutscenes | Shared `Shot.tsx` and `TitleCard.tsx` components; less duplication; trivial to add a third cutscene later. |
| Per-shot voice overrides in shots JSON | Keeps creative direction (which witch sounds like what) data-driven, not hard-coded in the renderer. |
| Cackle as a real CC0 SFX, not synthesized | Piper TTS literally pronounces "ha ha ha" as syllables. Real laughter requires either pre-recorded SFX or a much more capable model (none free in 2026). The bake-in concat trick is reliable and simple. |
| Music bed on `TheCurse`, NO music on `TheShattering` | Curse plays on first paint with no game audio running. Shattering plays AFTER game UI mounts (so game's own menu/ambient audio is already active under the cutscene). |
| Splash gesture before cutscene | Browser autoplay policy requires a user gesture for audio. Splash captures one click that authorizes both subsequent cutscenes. |
| Skip with 1.5s grace + Esc/Space/Enter | Prevents accidental skips during the title-fade-in. Multiple shortcuts so accessibility users get a real escape hatch. |
| Reset clears the cutscene seen-flag | Narrative: a Reset = the curse re-takes you. Mechanic: makes testing trivial (Reset = replay the intro). |

---

*Last updated when both `intro_the_curse_FINAL.mp4` (Tang-scholar 01_vanguard) and `intro_the_shattering_FINAL.mp4` (3 female witch voices + ghostly cackle SFX baked into s7d) shipped. Total cost: $0. Total render time end-to-end: ~25 min.*
