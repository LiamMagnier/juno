/**
 * Renderer entry point.
 *
 * Two things happen before React does, and both are about the first frame:
 *
 *   1. **The cached theme is applied synchronously.** `app:appearance` is an
 *      IPC round trip, so the true answer arrives a frame or two after paint.
 *      On an OLED dark theme those frames are a white flash across the whole
 *      window — the most visible defect the app can ship, and the one users
 *      describe as "it looks broken when it opens". The last known value is
 *      replayed from local storage and then corrected by the real one.
 *   2. **The stylesheet is imported here, not linked in the HTML**, so the
 *      bundler owns it. `base.css` is the renderer's single stylesheet entry —
 *      it `@import`s the generated `tokens.css` itself, ahead of the Tailwind
 *      directives, and Vite inlines that before PostCSS runs. Importing
 *      tokens.css here as well would emit the token block twice.
 *
 * There is no inline bootstrap script in index.html for step 1, because the CSP
 * main serves has `script-src 'self'` with no `'unsafe-inline'`. That is the
 * correct policy and this is the correct place for the work.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import { STORAGE_KEYS, asBoolean, asRecord, readStoredJson } from './lib/storage.js';
import './styles/base.css';

applyCachedTheme();

const container = document.getElementById('root');
if (!container) {
  /* Not recoverable and not worth a fallback: index.html is ours, and if the
     mount point is missing the build is broken, not the environment. */
  throw new Error('Renderer root element (#root) is missing from index.html.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/**
 * Paint the last known theme immediately.
 *
 * Deliberately identical in effect to `applyAppearanceToDocument` in
 * system-state, minus the accessibility flags — those have no visual effect
 * before React mounts, and duplicating them here would create a second place
 * that has to stay in step.
 */
function applyCachedTheme(): void {
  const stored = asRecord(readStoredJson(STORAGE_KEYS.appearance));
  const dark = asBoolean(stored?.['dark'], false);
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.dataset['theme'] = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';
}
