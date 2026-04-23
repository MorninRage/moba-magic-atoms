# Dock hero figure — LPCA geometry blueprint

> **Vanguard wizard (new character):** The product goal for a **researched, schematic-driven new wizard** is **not** this generic dock blueprint. See **[`VANGUARD_WIZARD_NEW_CHARACTER_HANDOFF.md`](VANGUARD_WIZARD_NEW_CHARACTER_HANDOFF.md)** — we must **create a new vanguard** from online reference + LPCA, **not** revive or lightly modify the old vanguard concept.

**Subject:** IDLE-CRAFT third-person dock survivor (full-body orbit camera).  
**Convention:** Three.js scene units; **feet / locomotion +Z forward** (matches existing dock grounding).  
**Height target:** ~1.8 m read at ~1.8 world units (torso lathe + neck + head stack matches prior inline dock).

## 1. Research (locked schematic)

| Topic | Decision |
|--------|----------|
| Total height | ~1.8 u (same visual weight as legacy dock male) |
| Head unit | 1 u ≈ 0.11 u cranium radius baseline; head root ~0.398 u above torso origin along +Y (matches prior) |
| Pivot names | `torso` (animated root), `headRoot`, `armL` / `armR`, `handL` / `handR`, `legLMesh` / `legRMesh`, `footLMesh` / `footRMesh` (implicit `pelvis` = same node as `torso` for LPCA doc parity) |
| Sole / ground | Boot soles at foot local Y = -0.14, Z = +0.05; avatar world Y positions figure so feet sit on y = 0 (peer clone uses bounding-box min Y) |
| Style | Low-poly LPCA: lathe torso, capsule limbs, box/cranium head — procedural only (no imported meshes) |

## 2. Layer stack (bottom → top)

1. **Foundation:** `torso` group at local origin; children ordered for clone-stable DFS (peer mini-figure).
2. **Trunk:** undertunic lathe → jerkin lathe (offset slightly +Z); **not merged together** (forge-wife preset hides both).
3. **Torso detail:** shoulder pads, **merged ornament ring** (collar + front panel + belt + buckle) where materials allow batching.
4. **Neck cylinder** (skin) — separate mesh (peer scale).
5. **Head:** `headRoot` → cranium, jaw, chin, cheeks, default hair, hat band / crown / brim (hat group), brows, eyes, nose, glasses group.
6. **Arms:** shoulder pivots → merged sleeve chain per side (jerkin + skin elbow) via `mergeByMaterial` on a staging group.
7. **Legs:** capsule pants → boot boxes parented to leg (feet animate in walk idle).

## 3. Merge buckets (draw-call plan)

| Bucket | Contents | Notes |
|--------|-----------|--------|
| Skin (multiple) | Neck, face boxes, palms — **kept separate** where peer code toggles visibility or scales morph targets | Matches `maleDockFaceList` |
| Jerkin | Trunk lathes stay **two meshes** | Forge path hides trunk meshes only |
| Ornaments | Collar, panel, belt, buckle | Candidates for future `mergeByMaterial` |
| Trim / metal | Hat brim disc + edge share brim material | Kept in hat group for hierarchy |

**Runtime merge (deferred):** `buildFullTorsoPeerFigure` pairs `flattenObjectTree(this.torso)` with the clone by **parallel traverse index**. Any merge that removes mesh nodes changes traverse length and breaks palette/topology mapping. Until peer clone switches to stable refs (e.g. `userData` keys), the shipped factory keeps the same mesh count/order as the legacy inline build.

## 4. Integration

- **Factory:** `createDockHeroFigureLPCA` in `src/visual/dockHeroFigureLPCA.ts` returns rig handles + `maleDockFaceList`.
- **Motion:** `src/data/dockCharacterMotion.ts` holds page ambient + idle sway helpers consumed by `CharacterScenePreview`.
- **Presets:** Forge wife / vanguard / artisan overlays remain parented by the preview after the base rig exists.

## 5. Risks

- Merging meshes that `applyPeerTorsoTopologyFromPreset` references by identity would break peer clones — **avoid** merging those meshes.
