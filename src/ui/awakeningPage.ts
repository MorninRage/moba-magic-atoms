/**
 * Awakening tab — Acts 2 → 3 progress UI per `LORE.md` §10 + `docs/AWAKENING_AND_FREE_ROAM_PLAN.md`.
 *
 * Shows the three talisman-shard slots (cori / jenny / kristin) — empty until the
 * corresponding witch has been defeated, filled with a glowing shard glyph + recovery
 * note once dropped. The big "Break the spell" button activates when all three are
 * recovered (or the dev flag is on); clicking it asks for confirm and then calls
 * `store.breakTheSpell()` which flips `realmMode` to `'awakened'` for the free-roam world.
 *
 * Phase A: visual + state flip only — the awakened-mode 3D / WASD / Tab-menu wiring
 * lands in Phase C. We deliberately keep this page thin so the awakening flow can be
 * iterated independently of the world rendering.
 */
import type { GameStore } from '../core/gameStore';
import type { ShardState, WitchShardId } from '../core/types';
import { openIdleCraftConfirm } from './idleCraftConfirmModal';

interface ShardCopy {
  id: WitchShardId;
  witchName: string;
  flavor: string;
  /** Voice metadata from `LORE.md` §8 — useful for future witch dialog wiring. */
  voice: string;
}

const SHARDS: ShardCopy[] = [
  {
    id: 'cori',
    witchName: 'Witch of the Eastern Coven',
    flavor:
      'The first to take a shard. Calm. Cruel. She watched the Vanguard fall.',
    voice: 'en_GB-cori-medium',
  },
  {
    id: 'jenny',
    witchName: 'The Iron-Box Witch',
    flavor:
      'Procedural in her cruelty. She filed his power away like a clerk closing a ledger.',
    voice: 'en_GB-jenny_dioco-medium',
  },
  {
    id: 'kristin',
    witchName: 'The Mocking Witch',
    flavor:
      'She laughed as she vanished with the last shard. She is still laughing somewhere.',
    voice: 'en_US-kristin-medium',
  },
];

function shardSlotHtml(copy: ShardCopy, recovered: boolean): string {
  const label = recovered ? 'Recovered' : 'Missing';
  const labelClass = recovered ? 'shard-status shard-status--ok' : 'shard-status shard-status--miss';
  const sigil = recovered ? '◆' : '◇';
  return `
    <li class="shard-slot ${recovered ? 'shard-slot--filled' : 'shard-slot--empty'}">
      <div class="shard-sigil" aria-hidden="true">${sigil}</div>
      <div class="shard-meta">
        <div class="shard-name">${copy.witchName}</div>
        <div class="shard-flavor">${copy.flavor}</div>
        <div class="${labelClass}">${label}</div>
      </div>
    </li>
  `;
}

export function renderAwakening(el: HTMLElement, store: GameStore): void {
  const shards: ShardState = store.getShards();
  const count = store.getShardCount();
  const canBreak = store.getCanBreakFree();
  const realm = store.getRealmMode();
  const next = store.getNextWitchId();

  const wrap = document.createElement('div');
  wrap.className = 'awakening-page';
  wrap.innerHTML = `
    <div class="panel-block awakening-intro">
      <h2>Reclaim the shards</h2>
      <p>
        Three shards of your shattered talisman were carried into the dream by the witches
        who took your daughter. Defeat each in turn to recover them. With all three returned,
        the spell that holds you in this dream-prison can be broken.
      </p>
      <p class="awakening-progress">
        <strong>${count} of 3</strong> recovered.
        ${
          next
            ? `<span class="awakening-next">Next witch: <em>${
                SHARDS.find((s) => s.id === next)?.witchName ?? next
              }</em>.</span>`
            : '<span class="awakening-next">All three witches have been defeated.</span>'
        }
      </p>
    </div>

    <div class="panel-block">
      <ul class="shard-list">
        ${SHARDS.map((s) => shardSlotHtml(s, !!shards[s.id])).join('')}
      </ul>
    </div>

    <div class="panel-block awakening-action">
      ${
        realm === 'awakened'
          ? `
            <button type="button" class="btn btn-awakening" data-awakening-return>
              Return to the dream-prison
            </button>
            <p class="awakening-hint">
              You walk the world again. Step back into the dream any time to revisit the deck —
              your inventory and progress carry both ways.
            </p>
          `
          : `
            <button
              type="button"
              class="btn btn-awakening"
              data-awakening-break
              ${canBreak ? '' : 'disabled'}
            >
              Break the spell
            </button>
            <p class="awakening-hint">
              ${
                canBreak
                  ? 'You are ready. Step out of the dream-prison and into the world.'
                  : 'The spell still holds. Recover the shards from the witches first.'
              }
            </p>
          `
      }
    </div>
  `;
  el.appendChild(wrap);

  const breakBtn = wrap.querySelector<HTMLButtonElement>('button[data-awakening-break]');
  if (breakBtn) {
    breakBtn.addEventListener('click', () => {
      if (!store.getCanBreakFree()) return;
      void openIdleCraftConfirm({
        title: 'Break the spell?',
        message:
          'You will wake from the dream-prison into the world. You can return to the deck at any time from this tab.',
        confirmLabel: 'Wake',
        cancelLabel: 'Stay in the dream',
        variant: 'default',
      }).then((ok) => {
        if (!ok) return;
        store.breakTheSpell();
      });
    });
  }
  const returnBtn = wrap.querySelector<HTMLButtonElement>('button[data-awakening-return]');
  if (returnBtn) {
    returnBtn.addEventListener('click', () => {
      void openIdleCraftConfirm({
        title: 'Return to the dream?',
        message:
          'You step back into the dream-prison. The deck and its tabs return; you can wake again at any time.',
        confirmLabel: 'Return',
        cancelLabel: 'Stay awake',
        variant: 'default',
      }).then((ok) => {
        if (!ok) return;
        store.setRealmMode('deck');
      });
    });
  }
}
