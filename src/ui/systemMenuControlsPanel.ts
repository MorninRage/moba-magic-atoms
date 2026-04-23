/**
 * Controls reference popup — standalone modal that opens ON TOP of the
 * Esc system menu. Pressing Esc or clicking the backdrop / Close button
 * dismisses the popup and returns the player to the underlying Esc menu
 * (the menu doesn't close — it's still visible behind the popup the
 * whole time the popup is up).
 *
 * Lists every interactive binding the player has access to, grouped by mode
 * (Universal, Dock camera, Dream mode, Awakened — Free Roam, Awakened — Combat,
 * Build Mode). Read-only — purely informational; no settings to wire.
 *
 * Sources of truth:
 *   - `src/world/freeRoamControls.ts` — WASD, Q lock, T lock-on, L torch, M combat, E
 *     interact, Space jump, 1-6 hotbar, Tab overlay, build keys
 *   - `src/world/cameraLockController.ts` — pointer-lock / mouse-look
 *   - `src/world/lockOnController.ts` — target cycling
 *   - `src/visual/characterScenePreview.ts` — dock orbit / pan / zoom / reset
 *   - `src/ui/mountApp.ts` — combat LMB, block RMB, ingame comm Enter
 *   - `src/ui/systemMenu.ts` — Esc behavior + this popup's open trigger
 */

interface ControlEntry {
  /** What to press / do (chord-friendly: "Shift + Drag", "Wheel", "1 — 6"). */
  key: string;
  /** What it does, brief sentence-case action. */
  action: string;
  /** Optional inline note (e.g. "while camera locked"). */
  note?: string;
}

interface ControlSection {
  id: string;
  title: string;
  blurb?: string;
  entries: ControlEntry[];
}

const CONTROL_SECTIONS: readonly ControlSection[] = [
  {
    id: 'universal',
    title: 'Universal',
    blurb: 'Works in any mode, on any screen.',
    entries: [
      { key: 'Esc', action: 'Open this Camp relay menu / close menus + modals' },
      { key: 'Enter', action: 'Open ingame voice + chat panel', note: 'online sessions' },
    ],
  },
  {
    id: 'dock-camera',
    title: 'Dock camera (3D view)',
    blurb: 'Orbit the procedural dock from any page. Disabled in Awakened mouse-look mode (press Q to toggle).',
    entries: [
      { key: 'Left-drag', action: 'Orbit the camera around the avatar' },
      { key: 'Right-drag', action: 'Pan the view' },
      { key: 'Middle-drag', action: 'Pan the view' },
      { key: 'Shift + Left-drag', action: 'Pan the view (alt)' },
      { key: 'Mouse wheel', action: 'Zoom in / out (smoothed)' },
      { key: 'Double-click', action: 'Reset camera to default framing' },
    ],
  },
  {
    id: 'dream-mode',
    title: 'Dream mode (Deck pages)',
    blurb: 'The default UI-first mode — gather, craft, deck-build, idle. Click navigation drives most actions; the dock camera controls above also work here.',
    entries: [
      { key: 'Click tabs', action: 'Switch pages: Gather / Craft / Inventory / Decks / Idle / Battle / Hire / RPG / Awakening / Portal' },
      { key: 'Click resources', action: 'Trigger gather / craft / interact (on the relevant page)' },
      { key: 'Esc', action: 'Open Camp relay (this menu)' },
    ],
  },
  {
    id: 'awakened-roam',
    title: 'Awakened — Free Roam',
    blurb: 'Active after you Break the Spell on the Awakening page. WASD walks the avatar through the world.',
    entries: [
      { key: 'W A S D', action: 'Move (camera-relative)' },
      { key: 'Arrow keys', action: 'Move (alternate)' },
      { key: 'Shift (hold)', action: 'Sprint' },
      { key: 'Space', action: 'Jump (double-tap mid-air = forward flip)' },
      { key: 'E', action: 'Interact / harvest (reticle if camera locked, proximity otherwise)' },
      { key: 'Tab', action: 'Open / close Awakened deck overlay (Inventory / Decks / etc. over the world)' },
      { key: '1 — 6', action: 'Use consumable / spell hotbar slot' },
    ],
  },
  {
    id: 'awakened-camera',
    title: 'Awakened — Camera & Combat',
    blurb: 'Camera lock turns the cursor into FPS-style mouse-look. Required for melee / ranged combat aiming.',
    entries: [
      { key: 'Q', action: 'Toggle camera lock (mouse-look)', note: 'Esc once to release pointer; press again to open menu' },
      { key: 'T', action: 'Toggle lock-on / cycle nearby target', note: 'requires camera lock' },
      { key: 'L', action: 'Equip / unequip torch', note: 'requires torch in inventory' },
      { key: 'M', action: 'Toggle combat mode (melee vs magic + melee)' },
      { key: 'Left mouse', action: 'Attack (melee swing or ranged cast)', note: 'while camera locked' },
      { key: 'Right mouse (hold)', action: 'Block / raise ward', note: 'while camera locked' },
      { key: 'Mouse move', action: 'Aim yaw + pitch', note: 'while camera locked' },
    ],
  },
  {
    id: 'awakened-build',
    title: 'Awakened — Build Mode',
    blurb: 'Active while placing a craft station / cabin piece (start from the Build action).',
    entries: [
      { key: 'Left mouse', action: 'Confirm placement' },
      { key: 'E', action: 'Confirm placement (alt)' },
      { key: 'R', action: 'Rotate ghost 90°' },
      { key: 'Mouse wheel', action: 'Fine-rotate ghost ±15°' },
      { key: 'Esc', action: 'Cancel placement (does not open menu)' },
    ],
  },
];

/**
 * Public handle returned by `installControlsPopup()`. The caller (typically
 * `systemMenu.ts`) calls `open()` from a button click and `dispose()` only
 * on game tear-down.
 */
export interface ControlsPopupHandle {
  /** Mount the popup on top of whatever's already open. Idempotent. */
  open(): void;
  /** Hide the popup. Idempotent. */
  close(): void;
  /** True iff the popup is currently visible. */
  isOpen(): boolean;
  /** Tear down event listeners + DOM. Game-end only. */
  dispose(): void;
}

/**
 * Build the controls popup once (lazy-mount the DOM on first `open`) and
 * return a handle. The popup uses its own backdrop + Esc handler with
 * `stopPropagation` so dismissing it leaves the underlying Esc system
 * menu visible and focused.
 *
 * The popup re-uses the `system-menu` CSS classes for visual consistency
 * (same panel chrome, same backdrop, same close-button styling) but with
 * a dedicated `controls-popup` modifier so its z-index can sit above the
 * Esc menu without conflicts.
 */
export function installControlsPopup(): ControlsPopupHandle {
  let shell: HTMLElement | null = null;
  let lastFocus: HTMLElement | null = null;
  let mounted = false;
  let visible = false;

  function ensureMounted(): void {
    if (mounted && shell) return;
    shell = buildPopupShell();
    document.body.appendChild(shell);
    wireShell(shell);
    mounted = true;
  }

  function open(): void {
    if (visible) return;
    ensureMounted();
    if (!shell) return;
    lastFocus = document.activeElement as HTMLElement | null;
    shell.classList.add('system-menu--open');
    shell.setAttribute('aria-hidden', 'false');
    /* Focus the close button so screen readers + Esc-released-pointer
     * players land on a sensible target. The summary <details> elements
     * are open by default so the content is immediately visible. */
    const closeBtn = shell.querySelector('[data-controls-popup-close]') as HTMLButtonElement | null;
    closeBtn?.focus();
    visible = true;
  }

  function close(): void {
    if (!visible || !shell) return;
    shell.classList.remove('system-menu--open');
    shell.setAttribute('aria-hidden', 'true');
    visible = false;
    /* Restore focus to whatever opened us — typically the "Controls"
     * button in the Esc system menu, which leaves the player on the
     * menu they came from (not back to game world). */
    lastFocus?.focus?.();
    lastFocus = null;
  }

  function wireShell(s: HTMLElement): void {
    const closeBtn = s.querySelector('[data-controls-popup-close]') as HTMLButtonElement | null;
    const backdrop = s.querySelector('[data-controls-popup-backdrop]') as HTMLButtonElement | null;
    closeBtn?.addEventListener('click', () => close());
    backdrop?.addEventListener('click', () => close());
    /* Capture-phase Esc handler so we run BEFORE systemMenu.ts's
     * document-level Esc handler. When the popup is up, Esc dismisses
     * the popup (returning to Esc menu) and stops propagation so the
     * Esc menu's handler doesn't ALSO fire and close the menu too. */
    document.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;
        if (!visible) return;
        e.preventDefault();
        e.stopPropagation();
        /* `stopImmediatePropagation` so any other capture-phase Esc
         * listener registered after us also gets short-circuited. The
         * only other capture-phase listener that matters is the
         * Esc-menu's, which is registered on `document` without
         * `capture: true` — but defending against future additions. */
        e.stopImmediatePropagation();
        close();
      },
      { capture: true },
    );
  }

  function dispose(): void {
    if (!mounted || !shell) return;
    shell.remove();
    shell = null;
    mounted = false;
    visible = false;
    lastFocus = null;
  }

  return { open, close, isOpen: () => visible, dispose };
}

function buildPopupShell(): HTMLElement {
  const shell = document.createElement('div');
  shell.id = 'controls-popup-overlay';
  /* Re-use the system-menu base classes for free CSS styling, plus a
   * `controls-popup` modifier so we can stack z-index above the parent
   * Esc menu (CSS handles the +1 z-index). Aria pattern matches the
   * Esc menu's own dialog setup. */
  shell.className = 'system-menu controls-popup';
  shell.setAttribute('role', 'dialog');
  shell.setAttribute('aria-modal', 'true');
  shell.setAttribute('aria-labelledby', 'controls-popup-title');
  shell.setAttribute('aria-hidden', 'true');

  const sectionsHtml = CONTROL_SECTIONS.map((section) => {
    const blurb = section.blurb
      ? `<p class="system-menu__controls-blurb">${escapeHtml(section.blurb)}</p>`
      : '';
    const rows = section.entries
      .map((entry) => {
        const note = entry.note
          ? ` <span class="system-menu__controls-note">— ${escapeHtml(entry.note)}</span>`
          : '';
        return `
          <li class="system-menu__controls-row">
            <kbd class="system-menu__controls-key">${escapeHtml(entry.key)}</kbd>
            <span class="system-menu__controls-action">${escapeHtml(entry.action)}${note}</span>
          </li>`;
      })
      .join('');
    return `
      <details class="system-menu__controls-section" data-controls-section="${section.id}" open>
        <summary class="system-menu__controls-summary">${escapeHtml(section.title)}</summary>
        ${blurb}
        <ul class="system-menu__controls-list">${rows}</ul>
      </details>`;
  }).join('');

  shell.innerHTML = `
    <button type="button" class="system-menu__backdrop" data-controls-popup-backdrop aria-label="Close controls"></button>
    <div class="system-menu__panel controls-popup__panel">
      <p class="system-menu__kicker">Idle Craft</p>
      <h2 id="controls-popup-title" class="system-menu__title">Controls reference</h2>
      <p class="system-menu__hint">
        Every key + mouse binding the game listens for. Click a section title to
        collapse it. Press Esc or click outside to close — the Camp relay menu
        stays open behind this popup.
      </p>
      <div class="system-menu__controls-stack controls-popup__stack">${sectionsHtml}</div>
      <div class="system-menu__actions controls-popup__actions">
        <button type="button" class="system-menu__btn system-menu__btn--primary" data-controls-popup-close>
          Close
        </button>
      </div>
    </div>
  `;

  return shell;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
