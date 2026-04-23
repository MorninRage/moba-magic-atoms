import './idleCraftConfirmModal.css';

export type IdleCraftConfirmOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Use ember/red pulse for destructive wipes. */
  variant?: 'default' | 'danger';
  /** Parent for stacking context; defaults to `document.body`. */
  container?: HTMLElement;
};

/**
 * In-app confirm dialog (replaces `confirm()`): neon glass panel + glowing primary CTA.
 */
export function openIdleCraftConfirm(opts: IdleCraftConfirmOptions): Promise<boolean> {
  const parent = opts.container ?? document.body;
  const confirmLabel = opts.confirmLabel ?? 'Confirm';
  const cancelLabel = opts.cancelLabel ?? 'Cancel';

  return new Promise((resolve) => {
    const shell = document.createElement('div');
    shell.className = 'idlecraft-confirm';
    shell.setAttribute('role', 'dialog');
    shell.setAttribute('aria-modal', 'true');
    shell.setAttribute('aria-labelledby', 'idlecraft-confirm-title');

    shell.innerHTML = `
      <div class="idlecraft-confirm__backdrop" data-icm-backdrop tabindex="-1" aria-hidden="true"></div>
      <div class="idlecraft-confirm__panel">
        <p class="idlecraft-confirm__kicker">Idle Craft</p>
        <h2 id="idlecraft-confirm-title" class="idlecraft-confirm__title"></h2>
        <p class="idlecraft-confirm__body"></p>
        <div class="idlecraft-confirm__actions">
          <button type="button" class="idlecraft-confirm__btn idlecraft-confirm__btn--cancel" data-icm-cancel></button>
          <button type="button" class="idlecraft-confirm__btn idlecraft-confirm__btn--ok" data-icm-ok></button>
        </div>
      </div>
    `;

    const titleEl = shell.querySelector('.idlecraft-confirm__title') as HTMLElement;
    const bodyEl = shell.querySelector('.idlecraft-confirm__body') as HTMLElement;
    const okBtn = shell.querySelector('[data-icm-ok]') as HTMLButtonElement;
    const cancelBtn = shell.querySelector('[data-icm-cancel]') as HTMLButtonElement;
    titleEl.textContent = opts.title;
    bodyEl.textContent = opts.message;
    okBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;
    if (opts.variant === 'danger') {
      okBtn.classList.add('idlecraft-confirm__btn--danger');
    }

    let settled = false;
    const finish = (v: boolean): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      shell.remove();
      resolve(v);
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    };

    shell.querySelector('[data-icm-backdrop]')?.addEventListener('click', () => finish(false));
    cancelBtn.addEventListener('click', () => finish(false));
    okBtn.addEventListener('click', () => finish(true));

    parent.appendChild(shell);
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => okBtn.focus());
  });
}
