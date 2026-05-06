import type { KeyBinding } from './keybindings';

type ShortcutHandler = (e: KeyboardEvent) => void;
type ActionHandler = (e: KeyboardEvent) => void;

interface Shortcut {
  key: string;
  ctrl?: boolean;
  cmdOrCtrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** When true, the shortcut fires even when an input/textarea/select is focused (e.g. inside a terminal). */
  global?: boolean;
  /** When true, the shortcut fires even when a dialog overlay is open. */
  dialogSafe?: boolean;
  handler: ShortcutHandler;
}

const shortcuts: Shortcut[] = [];

function matches(e: KeyboardEvent, s: Shortcut): boolean {
  const ctrlMatch = s.cmdOrCtrl ? e.ctrlKey || e.metaKey : !!e.ctrlKey === !!s.ctrl;
  // For non-cmdOrCtrl shortcuts, require metaKey to not be pressed
  const metaMatch = s.cmdOrCtrl || !e.metaKey;

  return (
    e.key.toLowerCase() === s.key.toLowerCase() &&
    ctrlMatch &&
    metaMatch &&
    !!e.altKey === !!s.alt &&
    !!e.shiftKey === !!s.shift
  );
}

export function registerShortcut(shortcut: Shortcut): () => void {
  shortcuts.push(shortcut);
  return () => {
    const idx = shortcuts.indexOf(shortcut);
    if (idx >= 0) shortcuts.splice(idx, 1);
  };
}

interface ZoomShortcutHandlers {
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
}

export function registerZoomShortcuts(handlers: ZoomShortcutHandlers): () => void {
  const cleanups = [
    // Zoom in/out: variants for keyboard layouts where matches() needs an
    // exact shift-state match (so each case needs its own registration).
    //   key '=' no shift  — Ctrl+= on US/UK keyboards
    //   key '+' shift     — Ctrl+Shift+= on US/UK keyboards
    //   key '+' no shift  — Ctrl++ on European keyboards and NumPad+
    registerShortcut({
      key: '=',
      cmdOrCtrl: true,
      global: true,
      dialogSafe: true,
      handler: () => handlers.zoomIn(),
    }),
    registerShortcut({
      key: '+',
      cmdOrCtrl: true,
      shift: true,
      global: true,
      dialogSafe: true,
      handler: () => handlers.zoomIn(),
    }),
    registerShortcut({
      key: '+',
      cmdOrCtrl: true,
      global: true,
      dialogSafe: true,
      handler: () => handlers.zoomIn(),
    }),
    registerShortcut({
      key: '-',
      cmdOrCtrl: true,
      global: true,
      dialogSafe: true,
      handler: () => handlers.zoomOut(),
    }),
    // Some layouts require Shift to produce the digit 0, so Ctrl+0 would miss
    // the registry binding's exact shift-state match without this variant.
    registerShortcut({
      key: '0',
      cmdOrCtrl: true,
      shift: true,
      global: true,
      dialogSafe: true,
      handler: () => handlers.resetZoom(),
    }),
  ];

  return () => cleanups.forEach((cleanup) => cleanup());
}

/**
 * Register Shift variants of Cmd+1..9 jump-to-task shortcuts.
 *
 * The canonical bindings (Cmd+1..9 without Shift) live in the keybindings
 * registry so they appear in the Keyboard Shortcuts UI and are user-overridable.
 * The Shift variants exist only so layouts where the digit row requires Shift
 * (e.g. AZERTY) still work — keeping them out of the registry avoids 9 duplicate
 * rows in the UI, mirroring how the Cmd+0 reset-zoom shift variant is handled.
 */
export function registerJumpToTaskShortcuts(handler: (index: number) => void): () => void {
  const cleanups = Array.from({ length: 9 }, (_, i) =>
    registerShortcut({
      key: `${i + 1}`,
      cmdOrCtrl: true,
      shift: true,
      global: true,
      handler: () => handler(i),
    }),
  );
  return () => cleanups.forEach((cleanup) => cleanup());
}

/** Whether a dialog overlay is currently mounted in the DOM. */
function isDialogOpen(): boolean {
  return document.querySelector('.dialog-overlay') !== null;
}

/** Returns true if the event matches any shortcut that should bypass terminal input. */
export function matchesGlobalShortcut(e: KeyboardEvent): boolean {
  const dialogOpen = isDialogOpen();
  return shortcuts.some((s) => (s.global || (dialogOpen && s.dialogSafe)) && matches(e, s));
}

export function initShortcuts(): () => void {
  const handler = (e: KeyboardEvent) => {
    // Don't intercept when typing in input/textarea — unless the shortcut is global
    const tag = (e.target as HTMLElement)?.tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    // Suppress non-dialog-safe shortcuts when a dialog overlay is open
    const dialogOpen = isDialogOpen();

    for (const s of shortcuts) {
      if (matches(e, s) && (!inInput || s.global) && (!dialogOpen || s.dialogSafe)) {
        e.preventDefault();
        e.stopPropagation();
        s.handler(e);
        return;
      }
    }
  };

  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}

export function registerFromRegistry(
  bindings: KeyBinding[],
  handlers: Record<string, ActionHandler>,
): () => void {
  const cleanups: (() => void)[] = [];

  for (const binding of bindings) {
    if (binding.layer !== 'app') continue;
    if (!binding.action) continue;

    const handler = handlers[binding.action];
    if (!handler) continue;

    const opts: Shortcut = {
      key: binding.key,
      global: binding.global,
      dialogSafe: binding.dialogSafe,
      handler,
    };

    if (binding.modifiers.cmdOrCtrl) {
      opts.cmdOrCtrl = true;
    }
    if (binding.modifiers.ctrl) {
      opts.ctrl = true;
    }
    if (binding.modifiers.alt) {
      opts.alt = true;
    }
    if (binding.modifiers.shift) {
      opts.shift = true;
    }

    cleanups.push(registerShortcut(opts));
  }

  return () => cleanups.forEach((fn) => fn());
}
