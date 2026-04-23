# IDLE-CRAFT — Lore Bible

**Canonical narrative reference for IDLE-CRAFT.** All cutscenes, in-game text, card flavor, NPC dialog, achievements, UI copy, and marketing material should align with this document. When in doubt, refer here. When this document is silent on a detail, treat it as **not yet canon** and propose an addition before locking it in.

**Companion docs:** `GAME_MASTER.md` (systems map), `docs/CUTSCENE_PIPELINE.md` (how to make new cutscenes), `PLAN.md` (delivery log), `vibejam_portal_solo_battle.md` (jam alignment).

---

## 1. Premise (one-paragraph pitch)

You are **the Vanguard Wizard** — the realm's master of water-magic, born of an ancient bloodline that the **Witches Guild** has long resented and feared. They took your daughter **Mira** and bound her in a dream-state from which only dreamers can reach her. You followed her into the dream to bring her home — and the Guild was waiting. They shattered your talisman, drained your water-magic, and sealed you in a deep slumber. The cards you draw and the slots you fill — *the entire idle-deck mechanic* — are the bars of your dream-prison. As you reclaim your power, you weaken their spell. When the spell finally breaks, you wake into the world (the 3D world). Then you go to find Mira.

**Why this premise matters mechanically:** the idle-deck loop is not arbitrary scaffolding wrapped in flavor — it IS the curse. Every card unlocked is a fragment of stolen power returning. Every craft station rebuilt is a memory restored. The act of "playing the game" is the act of breaking the spell. The eventual transition from the deck-UI to a WASD 3D world is the diegetic moment of awakening.

**Visual note — the awakened world is dream-tinted.** When the player breaks the spell into 3D awakened mode, the world they walk in is not the unaltered "real" world — Mira's water-magic has soaked into every surface during the long slumber, refracting the ground into vivid cyan / magenta / amber bands, and giving rise to the bouncing **drip-mushrooms** that grow where the dream's neon pools the deepest. The naturalistic forest tones are still visible under the tint, but the land reads as half-dream, half-waking. (See `docs/TRIPPY_TERRAIN_AND_BOUNCE_MUSHROOMS_PLAN.md` for the technical implementation.)

---

## 2. The Vanguard Wizard (player character)

| Attribute | Canon |
|---|---|
| **Title** | The Vanguard Wizard (also: "the Vanguard," "the Master of Rivers") |
| **Bloodline** | Ancient — explicitly resented by the Guild ("jealous of my blood. Fearful of my craft.") |
| **Domain** | Water magic — rivers, mist, oceans, rain, ice. Cyan / turquoise glow is his signature. |
| **Conduit** | A silver staff and a silver talisman (talisman shattered in ambush; staff status TBD) |
| **Appearance** | Tall, regal. Silver-streaked black hair, beard. Deep blue and silver river-rune robes. Older but not frail. |
| **Voice** | Weighted, weary, ancient. Speaks slowly. Carries gravitas of someone who has lost. |
| **Current state** | Sealed in a deep dream-slumber. Mostly powerless. Recovers power as the player progresses. |

**Naming note:** "Vanguard Wizard" reads as a title, not a personal name. The Vanguard does not have a first name in canon yet — keep it that way until a story reason demands one.

---

## 3. Mira (daughter, the goal)

| Attribute | Canon |
|---|---|
| **Name** | Mira |
| **Age** | About seven |
| **Appearance** | Long auburn hair, often wearing a daisy crown. Light, joyful presence. |
| **State** | Suspended in a dream-state. Reachable only by another dreamer. |
| **Status in story** | Goal. Player has not yet reached her. |
| **Relationship to player** | Daughter. Single most important person to him. |

**Tone rule:** Mira is shown in *memory* (gardens, golden hour, wildflowers, laughter). She is never shown in *peril on-screen* in cutscenes — the threat is implied, not exploited. This keeps her a beacon, not a damsel-in-distress beat.

---

## 4. The Witches Guild (antagonists)

| Attribute | Canon |
|---|---|
| **Name** | The Witches Guild |
| **Motive** | Envy of the Vanguard's bloodline. Fear of his craft. Political — this is establishment magicians threatened by lineage they can't claim. |
| **Methods** | Council magic. Sigils. Hexes that drain or seal rather than destroy. |
| **Appearance** | Hooded, faces shrouded. Moss-green and bone-white robes with silver thread runes. Glowing eyes when in council. |
| **Magic signature** | Green witch-fire on wand-tips. Spectral chains. Runic sigils. |
| **Setting** | Stone gothic chambers, ancient council halls, vaulted ceilings. |
| **Number** | At least three council members shown. Wider Guild membership unspecified — assume "many." |

The Guild are not cackling cartoon villains. They're an institution. Treat them as cold, deliberate, procedural. They held a council meeting before they took Mira. They have a chain of command.

---

## 5. The Talisman (artifact)

| Attribute | Canon |
|---|---|
| **Form** | Silver. Worn on the Vanguard's person. |
| **Function** | Conduit and amplifier for his water magic. Possibly heirloom of the bloodline. |
| **State** | **Shattered** during the ambush. Fragments stolen by the Guild. |
| **Recovery** | Recovered piece by piece as the player progresses. Each fragment recovered = power returned. (Mechanic-to-lore mapping is open — could be card unlocks, late-game items, etc.) |

This is the central plot device. Anything that gates progression should ideally tie back to talisman fragments.

---

## 6. The Curse (the dream-prison)

The slumber the Witches Guild placed the Vanguard in **is the game itself.** This is the core conceit:

- The deck = the bars of his prison
- The cards = fragments of his stolen self
- The slots = the patterns the curse imposes
- The crafting and gathering = the slow muscle-memory of recovering who he is
- The eventual breaking of the spell = the diegetic transition from deck-UI to 3D WASD movement

**Cosmology of the dream:**
- It is *not* the same plane as the dream Mira is held in. Mira's dream is deeper / further inward. The Vanguard's dream-prison is closer to the surface — a holding cell.
- Time inside the dream is unclear. Could be moments, could be years. Lean into ambiguity.
- Other dreamers might exist in the prison-layer. (Future content hook — multiplayer / NPC framing.)

---

## 7. Visual identity

The cutscenes establish the canonical look. All future visual content should align.

| Dimension | Canon |
|---|---|
| **Medium** | Dark fantasy oil painting. Painterly brushwork. |
| **Reference artists (prompt)** | Greg Rutkowski (composition, light), Zdzislaw Beksinski (atmosphere, dread), James Gurney (warmth, memory shots) |
| **Palette — magic** | Cyan / turquoise (Vanguard's water) vs. green witch-fire (Guild) vs. gold/amber (memory of Mira) |
| **Palette — mood** | Deep blues, blacks, ash-greys for present. Warm ambers and rose-golds for memory. Cold greens for villain scenes. |
| **Lighting** | Cinematic chiaroscuro. Single dominant key light. Strong vignette. Two pale moons in the realm sky. |
| **Composition** | Theatrical — full-frame painted tableaux, not action shots. Subjects often centered or rule-of-thirds. |
| **Texture** | Visible brushwork. Slight grain. No "AI smoothness." Embrace painterly imperfection. |

**For new cutscenes:** start every Pollinations / image-gen prompt with the formula: `"dark fantasy oil painting, [subject], painterly brushwork by Greg Rutkowski and Zdzislaw Beksinski, cinematic chiaroscuro lighting, deep shadows, [mood adjective]"`. See `docs/CUTSCENE_PIPELINE.md` §6 for the full formula.

---

## 8. Auditory identity

| Element | Canon |
|---|---|
| **Narrator voice (Vanguard)** | The Vanguard himself, speaking as "I." Voice is weighted, weary, slow. Old without being feeble. |
| **Piper voice settings (Vanguard)** | `en_GB-alan-medium`, `length_scale=1.3`, `pitch=0.93` |
| **Witch A (eastern coven, sneering)** | `en_GB-cori-medium`, `length_scale=1.05`, `pitch=1.0`. British female, calm/cruel/eerie. |
| **Witch B (iron-box, procedural)** | `en_GB-jenny_dioco-medium`, `length_scale=1.1`, `pitch=1.0`. British female, soft/cold. |
| **Witch C (mocking, cackling)** | `en_US-kristin-medium`, `length_scale=1.0`, `pitch=1.0`, plus a real CC0 cackle SFX (`ghostly_cackle_laugh_1.ogg` from OpenGameArt) baked in after her spoken line. American female, warm-cool delivery. |
| **Cutscene music — `intro_the_curse`** | `public/audio/music/menu-01.ogg` ("Insistent" — OpenGameArt). Continuity with menu music is intentional — the cutscene flows seamlessly into the title screen. |
| **Cutscene music — `intro_the_shattering`** | **None.** Shattering plays AFTER the game UI mounts, so the game's own menu/ambient audio plays under the cutscene. |
| **Diegetic sound rules** | Water (Vanguard's magic) — soft chimes, bell-tones, droplets. Witch-fire — low hiss, wood-crackle. Memory (Mira) — distant garden ambience, single wind-chime. |

**For real-laughter / scream / gasp moments** in future cutscenes: Piper cannot synthesize these. Download a CC0 SFX (OpenGameArt, Pixabay, Freesound CC0) and concatenate it onto the spoken Piper WAV via FFmpeg's concat demuxer. See `docs/CUTSCENE_BUILD_LOG.md` §7 for the bake-in recipe. The current shipped example is the s7d witch cackle.

Future scoring should keep the music palette **minor key, ambient, slow tempo**. Avoid orchestral bombast — this is a brooding intimate story, not a heroic epic.

---

## 9. Naming conventions

These are the official spellings and capitalizations. Use them everywhere.

| Term | Canonical form |
|---|---|
| The player character | **the Vanguard Wizard** (or "the Vanguard"; never "Vanguard" without the article) |
| The daughter | **Mira** |
| The antagonist organization | **the Witches Guild** (capital W, capital G) |
| The artifact | **the talisman** (lowercase unless beginning a sentence) |
| The realm of the curse | **the dream-prison** (lowercase, hyphenated) |
| The realm Mira is held in | **the dream beneath** or **the deeper dream** |
| The player's magic | **water-magic** (hyphenated) or **the craft** (when said by Guild members in fear) |

**Avoid:** "wizard hero," "the witch's curse" (singular — they are a guild), "the magical talisman" (redundant), "Princess Mira" (she is a daughter, not royalty).

---

## 10. Three-act story arc

This is the macro-story the game tells. Each phase has a corresponding cutscene anchor.

### Act 1 — The Curse (shipped: `intro_the_curse`)
The player learns who they are, what was lost, and why they are stuck. Establishes Vanguard, Mira, Guild, talisman, and the dream-prison conceit.
- **Anchor cutscene:** `intro_the_curse` (~51s)
- **Game state at this point:** new game, no power, deck-UI is the entire world.

### Act 2 — Recovery (cutscenes TBD — likely 1-2 mid-game stingers)
The Vanguard reclaims fragments of his power. Talisman pieces return. He starts to remember more. Echoes of Mira reach him. The Guild becomes aware that their seal is weakening.
- **Possible cutscene anchors:**
  - `first_spark` (~15s stinger when player unlocks `c_magic_awakening`) — first cyan flicker, distant whisper of Mira
  - `the_seal_weakens` (~20s stinger mid-late game) — Guild council reacts, plans countermeasures
- **Game state:** mid-to-late deck progression, magic system online.

### Act 3 — Awakening (cutscenes TBD)
The seal breaks. The Vanguard wakes from the dream-prison into the 3D world. He still must find and free Mira from the deeper dream.
- **Anchor cutscene:** `awakening_break_the_spell` (~30-45s) — bridge from deck-UI to WASD 3D
- **Game state:** transition moment from idle-deck mode to 3D world mode (currently unimplemented; cutscene exists as scaffold for future work)

### Act 4 — The Deeper Dream (future content; not yet planned)
The Vanguard, restored, descends into the dream that holds Mira. This is the eventual rescue arc. Currently outside scope.

---

## 11. Magical construction & wards

**Canon:** Before the curse, the Vanguard Wizard was as renowned for his **rune-bound architecture** as for his water-magic. The settlements that once ringed his domain were built of bound logs — each beam joined not just with iron bands but with **rivers of script** etched along the joints, reinforced with **crystal wraps** drawn from his own talisman. A house built by his hand could weather a Witches Guild raid for a season; a fortress could weather a year. After the talisman shattered, this craft went with the rest of his power into the dream — sleeping, recoverable.

**Why this matters mechanically:** when the Vanguard wakes into the 3D world (Act 3, see §10), the building craft returns piece by piece. The materials he can bind into a structure walk the same hierarchy as his other recoveries — rough log first, then oak, then copper-banded joinery, then the precious metals (silver, gold, platinum) which let the runes burn properly again. Crystal wraps applied to a built piece restore facets of the binding magic the talisman once provided: defense (the cyan shield-runes of his old work), regeneration (the green-blue grove-script), offense (the violet wrath-script the Guild itself fears), and lesser utility wards (light, deterrence).

**Tone for in-game text on building:**
- Card flavor and tooltips: speak of *recovery*, never of *invention*. The Vanguard is not learning to build — he is **remembering**.
- Failed placements: "The runes will not hold here." (Not "Invalid placement.")
- Tier unlock: when a tier of metal banding becomes available, the discovery feels like dawn — quiet, recognized, inevitable.
- Crystal wrap application: "The wrap settles. The runes wake." Brief, ritual phrasing.
- Destroyed pieces: lose them with weight. A Guild raid that breaks a wall is not a "build cost" — it is a **wound**.

**Visual rules for building:**
- Every tier still reads as **log cabin** — the silhouette is wood. Bands and runes are accents that grow brighter and more elaborate at higher tiers, never replacements for the timber. The Vanguard's craft is *bound timber*, not *transmuted metal*.
- Crystal wraps glow with the same bioluminescent palette as his staff orb (cyan / green-blue / violet / amber) — visual continuity between his hand-magic and his architecture.
- A platinum-tier wall under a defense wrap, lit at night, should read as **a fragment of his old domain** — the kind of thing the Guild burned to put him in the dream.

**System map:** mechanical specification in [`docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md`](docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md). Awakened-mode framing in [`docs/AWAKENING_AND_FREE_ROAM_PLAN.md`](docs/AWAKENING_AND_FREE_ROAM_PLAN.md) §15.

---

## 12. Tone & voice

**For the Vanguard's narration:**
- Speak in past tense for backstory, present tense for current state.
- Use simple, weighted words. Never wordy.
- Two beats per line. Pauses matter.
- Repetition for emphasis is allowed and good ("And Mira... my Mira.")
- Never sarcastic. Never modern. Never explanatory. He has no audience but himself.

**For Guild dialog (when needed):**
- Cold, procedural, plural ("we have decided…").
- They never say his name. They call him "the bloodline" or "the wizard."
- They believe they are right.

**For Mira (when ever speaking):**
- Light, present, child-like — but not babyish. She knows more than she says.
- She calls him "papa."

**For the game's UI / system text:**
- Stay neutral. The world is grim but the UI is functional. Don't lore-flavor every button. Reserve flavor for cards, item descriptions, achievements, and cutscenes.

---

## 13. Continuity rules — what's canon vs. open

**Locked canon (do not contradict):**
- Vanguard exists, is male, has water-magic, has silver-streaked hair, has been ambushed and sealed.
- Mira exists, is his daughter, is roughly seven, has auburn hair, is in a dream-state.
- The Witches Guild exists, took her, and ambushed him.
- The talisman is silver and shattered.
- The deck-game IS the prison. Breaking the deck = breaking the seal.

**Open / future-decidable (treat as not-yet-canon):**
- The Vanguard's first name (currently none — keep it that way unless story needs it)
- His age in years
- Mira's mother (presence/absence, alive/dead, role) — currently unspecified
- The realm's geographic / political structure
- How many Guild members exist beyond the council of three shown
- The mechanism by which fragments of the talisman are recovered (mechanic-to-lore mapping is open)
- Whether other dreamers exist in the prison
- Mira's own magic (if any)

**When in doubt:** add it to the "open" list and ask before locking.

---

## 14. Reference: shipped cutscenes

> **2026-04-22 — boot integration UNWIRED.** Both `.mp4` files are preserved on disk and the production pipeline (`docs/CUTSCENE_PIPELINE.md` + `docs/CUTSCENE_BUILD_LOG.md`) remains canonical for any future cutscene production. The Acts 1-3 arc below is **unchanged** — these cutscenes are still the canonical narrative reference. Only the `src/main.ts` boot integration was removed (per player feedback that the cutscenes were "too heavy"); see `docs/SESSION_2026_04_22_CUTSCENE_REMOVAL_AND_BOOT_TIGHTENING.md`. Re-enabling is a one-commit revert.

| Cutscene | Acts | Status | Source |
|---|---|---|---|
| `intro_the_curse` | Act 1 (premise) | **Built (canonical narrative reference); unwired from boot 2026-04-22.** Establishes Vanguard, Mira, Witches Guild, broad backstory, dream-prison conceit. ~51s. | `public/cutscenes/intro_the_curse.mp4` |
| `intro_the_shattering` | Act 1b (objective) | **Built (canonical narrative reference); unwired from boot 2026-04-22.** Shows the bloodline magic in detail, the talisman shattering, three witches taking the shards (each with a distinct female voice), and ends on the title card **"RECLAIM THE SHARDS"**. Includes a real CC0 cackle SFX layered into the third witch's line. ~76s, no music bed. | `public/cutscenes/intro_the_shattering.mp4` |

See `docs/CUTSCENE_PIPELINE.md` for how new cutscenes are produced and (when re-enabled) integrated.

---

## 15. How to use this document

- **Writing card flavor / item descriptions / NPC text:** consult §2-§9 for names, palette, voice rules.
- **Writing a new cutscene:** consult §10 for which act it lives in, §11 for tone, then go to `docs/CUTSCENE_PIPELINE.md` for the production recipe.
- **Designing a new mechanic:** see if it can be tied to a §10 act beat or §6 talisman-fragment-recovery framing — mechanics that map to lore feel meaningful.
- **Adding a new character or place:** propose it as an addition to this document first. Lock it here, then ship.

---

*Last updated 2026-04-22: §14 status flipped to "built but unwired from boot" — both `.mp4` files preserved on disk and the production pipeline remains canonical, but `src/main.ts` no longer imports the cutscene modules per player feedback that the cutscenes were "too heavy." The narrative arc in §10 is unchanged — these cutscenes remain the canonical reference for Acts 1 / 1b framing. Acts 2-3 cutscene anchors still pending; Act 4 not yet planned. See `docs/SESSION_2026_04_22_CUTSCENE_REMOVAL_AND_BOOT_TIGHTENING.md`.*
