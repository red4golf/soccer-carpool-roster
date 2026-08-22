import { h } from './util.js';

/**
 * A focus-trapped modal.
 *
 * Returns { host, close } and takes care of Escape, click-outside, restoring
 * focus to whatever opened it, and locking background scroll — the things
 * that make a dialog usable with a keyboard and a screen reader rather than
 * only with a mouse.
 */
export function modal(title, inner, { wide = false, eyebrow = 'TEAM RIDE BOARD' } = {}) {
  const previous = document.activeElement;
  const host = document.createElement('div');
  host.className = 'modalBackdrop';
  host.innerHTML = `
    <div class="modal ${wide ? 'wideModal' : ''}" role="dialog" aria-modal="true" aria-label="${h(title)}">
      <button class="close" aria-label="Close">×</button>
      <p class="eyebrow">${h(eyebrow)}</p>
      <h2>${h(title)}</h2>
      ${inner}
    </div>`;
  document.body.append(host);
  document.body.style.overflow = 'hidden';

  const close = () => {
    host.remove();
    if (!document.querySelector('.modalBackdrop')) document.body.style.overflow = '';
    previous?.focus?.();
  };

  host.querySelector('.close').addEventListener('click', close);
  host.addEventListener('click', event => {
    if (event.target === host) close();
  });
  host.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = [...host.querySelectorAll('button,input,select,textarea,a[href]')]
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  requestAnimationFrame(() => host.querySelector('input,select,button:not(.close)')?.focus());
  return { host, close };
}

/** Inline confirm for a destructive action, so it is never a bare window.confirm. */
export function confirmInline(host, message, onConfirm) {
  const slot = document.createElement('div');
  slot.className = 'confirmSlot';
  slot.innerHTML = `
    <p>${h(message)}</p>
    <div><button class="danger" data-yes>Yes, do it</button>
    <button class="outline" data-no>Cancel</button></div>`;
  host.replaceChildren(slot);
  slot.querySelector('[data-yes]').addEventListener('click', onConfirm);
  slot.querySelector('[data-no]').addEventListener('click', () => slot.remove());
}

export const notice = (message, kind = '') =>
  message ? `<div class="notice ${kind}" role="status">${h(message)}</div>` : '';
