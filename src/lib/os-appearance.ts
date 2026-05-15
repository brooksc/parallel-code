import { createSignal } from 'solid-js';

// In non-browser environments (tests, SSR) window.matchMedia doesn't exist.
// Return a plain accessor rather than a reactive signal — callers only need
// the () => boolean interface; reactivity isn't needed outside the browser.
function makeOsIsDark(): () => boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => true; // default: assume dark
  }
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const [sig, setSig] = createSignal(query.matches);
  query.addEventListener('change', (e) => setSig(e.matches));
  return sig;
}

export const osIsDark = makeOsIsDark();
