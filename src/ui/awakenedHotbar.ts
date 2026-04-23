/**
 * Awakened-mode hotbar (`docs/AWAKENING_AND_FREE_ROAM_PLAN.md` §5).
 *
 * Bottom-of-screen overlay that surfaces, at-a-glance:
 *   - The Vanguard's currently-equipped weapon / pick / shield (so the player can see
 *     what they're carrying without opening the Tab menu).
 *   - The magic spells in their combat deck (cards with `attackStyle: 'spell'`),
 *     positioned for future quick-cast input (`1`-`9` keys, next session).
 *   - Top-N inventory items by count, so the player can see at a glance "I have N wood"
 *     without opening Inventory.
 *   - Live mana / HP bars (the deck-mode HUD is hidden in awakened mode).
 *
 * **Read-only for now.** Equipment swap + spell cast wiring lands in the next session;
 * this hotbar is the visual surface those will hook into.
 *
 * Re-renders on every store emit (cheap — small DOM, no expensive deps).
 */
import type { GameStore } from '../core/gameStore';
import { allCards } from '../core/gameStore';
import { openSpellPickerModal } from './spellPickerModal';

interface HotbarHandle {
  /** Tear down DOM + unsubscribe from the store. Called by `mountApp` on realm flip. */
  dispose(): void;
}

const SPELL_GLYPH = '✦';
const SPELL_DEF_GLYPH = '◈';
const WEAPON_GLYPH = '⚔';
const PICK_GLYPH = '⛏';
const SHIELD_GLYPH = '🛡';

/** Top-N items shown in the inventory strip (by count, ignoring tools/weapons/equipment ids). */
const HOTBAR_ITEM_LIMIT = 8;

/** Items we deliberately exclude from the inventory strip (already shown in the equipment strip). */
const HOTBAR_ITEM_EXCLUDE = new Set([
  'axe', 'copper_axe', 'bronze_axe', 'brass_axe', 'iron_axe', 'steel_axe',
  'bronze_sword', 'iron_sword', 'steel_sword', 'silver_sword', 'gold_sword', 'platinum_sword',
  'apprentice_wand', 'journeyman_staff', 'archmage_staff',
  'pickaxe', 'copper_pickaxe', 'iron_pickaxe', 'bronze_pickaxe', 'brass_pickaxe',
  'steel_pickaxe', 'silver_pickaxe', 'gold_pickaxe', 'platinum_pickaxe',
  'wooden_shield',
]);

function pretty(id: string): string {
  return id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildHotbarDom(): HTMLElement {
  const root = document.createElement('div');
  root.className = 'awakened-hotbar';
  /* Four vital meters in a 2-column stack (HP / Hunger left, Mana / Thirst right) so the
   * hotbar stays compact horizontally — adding hunger + thirst as a second row instead of
   * lengthening the strip keeps it from spanning the whole viewport at fullscreen. */
  root.innerHTML = `
    <div class="awakened-hotbar__group awakened-hotbar__vitals">
      <div class="awakened-hotbar__bar awakened-hotbar__bar--hp">
        <div class="awakened-hotbar__bar-label">HP</div>
        <div class="awakened-hotbar__bar-track"><div class="awakened-hotbar__bar-fill" data-hp-fill></div></div>
        <div class="awakened-hotbar__bar-value" data-hp-value></div>
      </div>
      <div class="awakened-hotbar__bar awakened-hotbar__bar--mana">
        <div class="awakened-hotbar__bar-label">Mana</div>
        <div class="awakened-hotbar__bar-track"><div class="awakened-hotbar__bar-fill" data-mana-fill></div></div>
        <div class="awakened-hotbar__bar-value" data-mana-value></div>
      </div>
      <div class="awakened-hotbar__bar awakened-hotbar__bar--hunger">
        <div class="awakened-hotbar__bar-label">Food</div>
        <div class="awakened-hotbar__bar-track"><div class="awakened-hotbar__bar-fill" data-hunger-fill></div></div>
        <div class="awakened-hotbar__bar-value" data-hunger-value></div>
      </div>
      <div class="awakened-hotbar__bar awakened-hotbar__bar--thirst">
        <div class="awakened-hotbar__bar-label">Water</div>
        <div class="awakened-hotbar__bar-track"><div class="awakened-hotbar__bar-fill" data-thirst-fill></div></div>
        <div class="awakened-hotbar__bar-value" data-thirst-value></div>
      </div>
    </div>
      <div class="awakened-hotbar__group awakened-hotbar__equipment" data-equipment></div>
      <div class="awakened-hotbar__group awakened-hotbar__magic-slots" data-magic-slots></div>
      <div class="awakened-hotbar__group awakened-hotbar__spells" data-spells></div>
      <div class="awakened-hotbar__group awakened-hotbar__inventory" data-inventory></div>
  `;
  return root;
}

function renderEquipmentSlot(label: string, glyph: string, itemId: string | null): string {
  const empty = !itemId;
  return `
    <div class="awakened-hotbar__slot ${empty ? 'awakened-hotbar__slot--empty' : ''}" title="${label}: ${empty ? 'unequipped' : pretty(itemId!)}">
      <div class="awakened-hotbar__slot-glyph">${glyph}</div>
      <div class="awakened-hotbar__slot-label">${empty ? '—' : pretty(itemId!)}</div>
    </div>
  `;
}

function renderEquipment(state: ReturnType<GameStore['getState']>): string {
  return [
    renderEquipmentSlot('Weapon', WEAPON_GLYPH, state.equipment.weapon),
    renderEquipmentSlot('Pick', PICK_GLYPH, state.equipment.pick),
    renderEquipmentSlot('Shield', SHIELD_GLYPH, state.equipment.shield),
  ].join('');
}

/**
 * Two dedicated magic-equipment slots — Offensive (LMB cast) + Defensive (RMB ward).
 * Both are click-to-open-picker. Renders the equipped spell name + mana cost when set,
 * "Click to equip" label when empty. Glyph color cues offense (cyan ✦) vs defense
 * (magenta ◈) to match the matching reticle / ward visuals.
 */
function renderMagicSlot(
  label: string,
  glyph: string,
  cardName: string | null,
  manaCost: number | null,
  pickerKey: 'offense' | 'defense',
): string {
  const empty = !cardName;
  const klass = `awakened-hotbar__slot awakened-hotbar__slot--magic awakened-hotbar__slot--magic-${pickerKey}${empty ? ' awakened-hotbar__slot--empty' : ''}`;
  const meta = !empty && manaCost != null ? `<div class="awakened-hotbar__slot-meta">${manaCost}m</div>` : '';
  return `
    <button type="button" class="${klass}" data-magic-pick="${pickerKey}" title="${label}: ${empty ? 'click to equip a spell' : cardName}">
      <div class="awakened-hotbar__slot-glyph">${glyph}</div>
      <div class="awakened-hotbar__slot-label">${empty ? `+ ${label}` : cardName}</div>
      ${meta}
    </button>
  `;
}

function renderMagicSlots(state: ReturnType<GameStore['getState']>): string {
  const offCard = state.equippedOffensiveSpellId
    ? allCards.find((c) => c.id === state.equippedOffensiveSpellId)
    : null;
  const defCard = state.equippedDefensiveSpellId
    ? allCards.find((c) => c.id === state.equippedDefensiveSpellId)
    : null;
  return [
    renderMagicSlot(
      'Offensive spell',
      SPELL_GLYPH,
      offCard?.name ?? null,
      offCard?.battle?.manaCost ?? null,
      'offense',
    ),
    renderMagicSlot(
      'Defensive ward',
      SPELL_DEF_GLYPH,
      defCard?.name ?? null,
      defCard?.battle?.manaCost ?? null,
      'defense',
    ),
  ].join('');
}

function renderSpells(state: ReturnType<GameStore['getState']>): string {
  /* Filter the combat deck for cards that are spells (attackStyle === 'spell'). Show
   * up to 6; pad with empty slots so the strip width is consistent. */
  const unlocked = new Set(state.unlockedCardIds);
  const spellCards = state.combatDeck
    .map((id) => allCards.find((c) => c.id === id))
    .filter((c) => c && unlocked.has(c.id) && c.battle?.attackStyle === 'spell');
  const slots: string[] = [];
  for (let i = 0; i < 6; i++) {
    const c = spellCards[i];
    if (c) {
      const cost = c.battle?.manaCost ?? 0;
      slots.push(`
        <div class="awakened-hotbar__slot awakened-hotbar__slot--spell" title="${c.name} (mana ${cost})">
          <div class="awakened-hotbar__slot-glyph">${SPELL_GLYPH}</div>
          <div class="awakened-hotbar__slot-label">${c.name}</div>
          <div class="awakened-hotbar__slot-meta">${cost}m</div>
          <div class="awakened-hotbar__slot-key">${i + 1}</div>
        </div>
      `);
    } else {
      slots.push(`
        <div class="awakened-hotbar__slot awakened-hotbar__slot--empty awakened-hotbar__slot--spell" title="No spell slotted">
          <div class="awakened-hotbar__slot-glyph">·</div>
          <div class="awakened-hotbar__slot-label">empty</div>
          <div class="awakened-hotbar__slot-key">${i + 1}</div>
        </div>
      `);
    }
  }
  return slots.join('');
}

function renderInventoryStrip(state: ReturnType<GameStore['getState']>): string {
  const rows = Object.entries(state.inventory)
    .filter(([k, v]) => v >= 1 && !HOTBAR_ITEM_EXCLUDE.has(k))
    .sort((a, b) => b[1] - a[1])
    .slice(0, HOTBAR_ITEM_LIMIT);
  if (rows.length === 0) {
    return `<div class="awakened-hotbar__inv-empty">No stockpile yet — gather to fill your bag.</div>`;
  }
  return rows
    .map(([id, n]) => `
      <div class="awakened-hotbar__inv-cell" title="${pretty(id)}: ${Math.floor(n)}">
        <div class="awakened-hotbar__inv-name">${pretty(id)}</div>
        <div class="awakened-hotbar__inv-count">${Math.floor(n)}</div>
      </div>
    `)
    .join('');
}

export function mountAwakenedHotbar(host: HTMLElement, store: GameStore): HotbarHandle {
  const root = buildHotbarDom();
  host.appendChild(root);

  const eqEl = root.querySelector<HTMLElement>('[data-equipment]')!;
  const magicEl = root.querySelector<HTMLElement>('[data-magic-slots]')!;
  const spellsEl = root.querySelector<HTMLElement>('[data-spells]')!;
  const invEl = root.querySelector<HTMLElement>('[data-inventory]')!;
  /* Click delegation for the two magic slots — opens the spell picker modal for the
   * matching slot kind. The modal closes automatically after equip / unequip and
   * the store emits, refreshing the hotbar via the existing subscribe path. */
  magicEl.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-magic-pick]');
    if (!target) return;
    const kind = target.dataset.magicPick as 'offense' | 'defense' | undefined;
    if (kind !== 'offense' && kind !== 'defense') return;
    /* Mount the picker as a child of the same host element the hotbar lives in
     * (the game shell), so its z-index sits above the hotbar without needing a
     * separate overlay layer. */
    openSpellPickerModal({ kind, host, store });
  });
  const hpFill = root.querySelector<HTMLElement>('[data-hp-fill]')!;
  const hpValue = root.querySelector<HTMLElement>('[data-hp-value]')!;
  const manaFill = root.querySelector<HTMLElement>('[data-mana-fill]')!;
  const manaValue = root.querySelector<HTMLElement>('[data-mana-value]')!;
  const hungerFill = root.querySelector<HTMLElement>('[data-hunger-fill]')!;
  const hungerValue = root.querySelector<HTMLElement>('[data-hunger-value]')!;
  const thirstFill = root.querySelector<HTMLElement>('[data-thirst-fill]')!;
  const thirstValue = root.querySelector<HTMLElement>('[data-thirst-value]')!;

  /* String-signature gate so we don't redraw DOM nodes if nothing visible changed. */
  let lastSig = '';

  function refresh(): void {
    const s = store.getState();
    const maxMana = store.getEffectiveMaxMana();
    const hpPct = Math.max(0, Math.min(100, (s.playerHp / Math.max(1, s.playerMaxHp)) * 100));
    const manaPct = Math.max(0, Math.min(100, (s.mana / Math.max(1, maxMana)) * 100));
    /* Hunger / thirst are stored 0-100 in the store (matches the deck-mode HUD bars in
     * `refreshHudImmediate`). Clamp defensively in case decay drives them slightly negative. */
    const hungerPct = Math.max(0, Math.min(100, s.hunger));
    const thirstPct = Math.max(0, Math.min(100, s.thirst));

    const sig = [
      s.equipment.weapon, s.equipment.pick, s.equipment.shield,
      s.equippedOffensiveSpellId, s.equippedDefensiveSpellId,
      s.combatDeck.join(','),
      /* Unlocked card set is included so the picker's eligibility list stays in
       * sync after a spell craft (otherwise we'd render the OLD list until some
       * other state field changed). */
      s.unlockedCardIds.join(','),
      Math.round(s.playerHp), s.playerMaxHp, Math.round(s.mana * 10) / 10, Math.round(maxMana * 10) / 10,
      /* Top items signature — bucket inventory to whole numbers so float drift doesn't redraw. */
      Object.entries(s.inventory)
        .filter(([k, v]) => v >= 1 && !HOTBAR_ITEM_EXCLUDE.has(k))
        .sort((a, b) => b[1] - a[1])
        .slice(0, HOTBAR_ITEM_LIMIT)
        .map(([k, v]) => `${k}:${Math.floor(v)}`)
        .join('|'),
    ].join('§');

    /* Always update the bars (cheap — just style writes) */
    hpFill.style.width = `${hpPct}%`;
    hpValue.textContent = `${Math.ceil(s.playerHp)}/${s.playerMaxHp}`;
    manaFill.style.width = `${manaPct}%`;
    manaValue.textContent = `${Math.floor(s.mana)}/${Math.floor(maxMana)}`;
    hungerFill.style.width = `${hungerPct}%`;
    hungerValue.textContent = `${Math.round(hungerPct)}`;
    thirstFill.style.width = `${thirstPct}%`;
    thirstValue.textContent = `${Math.round(thirstPct)}`;

    if (sig === lastSig) return;
    lastSig = sig;
    eqEl.innerHTML = renderEquipment(s);
    magicEl.innerHTML = renderMagicSlots(s);
    spellsEl.innerHTML = renderSpells(s);
    invEl.innerHTML = renderInventoryStrip(s);
  }

  refresh();
  const unsub = store.subscribe(refresh);

  return {
    dispose(): void {
      unsub();
      root.remove();
    },
  };
}
