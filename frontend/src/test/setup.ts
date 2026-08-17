// =============================================================================
//   TYPHOON — setup vitest : jest-dom + stubs pour les composants
//   @material/web (md-icon, md-filled-button…) qui ne se rendent pas dans
//   jsdom (custom elements non résolus). On ne mocke pas la logique : on
//   transforme les tags <md-*> en <span> simples pour que le contenu
//   (textes, aria-labels, slots) reste testable dans le DOM.
// =============================================================================

import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

/* @material/web custom elements : jsdom ne les définit pas. On enregistre
   des classes minimales pour que le rendu ne casse pas et que le texte des
   slots (ex. <span slot="headline">…) apparaisse dans le DOM. */
const mdTagNames = [
  'md-icon',
  'md-icon-button',
  'md-filled-button',
  'md-outlined-button',
  'md-text-button',
  'md-elevated-button',
  'md-list',
  'md-list-item',
  'md-linear-progress',
  'md-circular-progress',
  'md-dialog',
  'md-outlined-text-field',
  'md-checkbox',
  'md-switch',
  'md-menu',
];

for (const name of mdTagNames) {
  if (!customElements.get(name)) {
    customElements.define(
      name,
      class extends HTMLElement {
        connectedCallback() {
          // Fait apparaître le texte des slots "headline"/"supporting-text"
          // en contenu visible pour les assertions RTL.
          const slotNames = ['start', 'end', 'headline', 'supporting-text', 'trailing-supporting-text', 'icon'];
          for (const slot of slotNames) {
            const el = this.querySelector(`[slot="${slot}"]`);
            if (el) {
              const span = document.createElement('span');
              span.setAttribute('data-slot', slot);
              span.textContent = el.textContent || '';
              this.appendChild(span);
            }
          }
        }
      }
    );
  }
}

/* Mock local/sessionStorage propres par test (jsdom les fournit déjà). */
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
