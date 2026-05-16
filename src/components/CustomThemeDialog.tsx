import { createSignal, createEffect, Show, For, createUniqueId, on } from 'solid-js';
import { Dialog } from './Dialog';
import { theme, sectionLabelStyle } from '../lib/theme';
import { generateThemePrompt, parseThemeYaml, checkThemeContrast } from '../lib/custom-theme';
import type { CustomTheme, ContrastWarning } from '../lib/custom-theme';
import { store, saveCustomTheme, setDarkTheme, setLightTheme } from '../store/store';
import { osIsDark } from '../lib/os-appearance';

interface CustomThemeDialogProps {
  open: boolean;
  /** When set, we're editing an existing custom theme */
  editId?: string | null;
  /** Pre-filled YAML (e.g. from a cloned built-in preset) */
  initialYaml?: string;
  onClose: () => void;
}

function buildYamlForEdit(theme: CustomTheme): string {
  const varLines = Object.entries(theme.vars)
    .map(([k, v]) => `  ${k}: "${v}"`)
    .join('\n');
  return `name: ${theme.name}\nterminalBackground: "${theme.terminalBackground}"\nvars:\n${varLines}\n`;
}

export function CustomThemeDialog(props: CustomThemeDialogProps) {
  const titleId = createUniqueId();
  const [yaml, setYaml] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [warnings, setWarnings] = createSignal<ContrastWarning[]>([]);
  const [copied, setCopied] = createSignal(false);
  const [showPrompt, setShowPrompt] = createSignal(false);

  // Reset state when dialog opens/closes or switches edit target
  createEffect(
    on(
      () => [props.open, props.editId, props.initialYaml] as const,
      ([open, editId, initialYaml]) => {
        if (!open) return;
        setError(null);
        setCopied(false);
        setShowPrompt(false);
        if (editId && store.customThemes[editId]) {
          setYaml(buildYamlForEdit(store.customThemes[editId]));
        } else if (initialYaml) {
          setYaml(initialYaml);
        } else {
          setYaml('');
        }
      },
    ),
  );

  // Live validation + contrast check
  createEffect(() => {
    const text = yaml().trim();
    if (!text) {
      setError(null);
      setWarnings([]);
      return;
    }
    try {
      const parsed = parseThemeYaml(text);
      setError(null);
      setWarnings(checkThemeContrast(parsed.vars));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setWarnings([]);
    }
  });

  function parsed() {
    try {
      return parseThemeYaml(yaml().trim());
    } catch {
      return null;
    }
  }

  function handleSave() {
    const result = parsed();
    if (!result) return;
    const id = props.editId ?? crypto.randomUUID();
    const newTheme: CustomTheme = { id, ...result };
    saveCustomTheme(newTheme);
    // Record the new theme in the appropriate slot so applyAppearanceMode()
    // restores it correctly on OS switches and relaunches.
    const mode = store.appearanceMode;
    const slot = mode === 'system' ? (osIsDark() ? 'dark' : 'light') : mode;
    if (slot === 'light') {
      setLightTheme(store.lightThemePreset, id);
    } else {
      setDarkTheme(store.darkThemePreset, id);
    }
    props.onClose();
  }

  function handleCopyPrompt() {
    const currentYaml = yaml().trim();
    const prompt = generateThemePrompt(currentYaml || undefined);
    void navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const isValid = () => yaml().trim().length > 0 && parsed() !== null;

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      width="560px"
      zIndex={1200}
      labelledBy={titleId}
      panelStyle={{ 'max-width': 'calc(100vw - 32px)', padding: '24px', gap: '16px' }}
    >
      <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}>
        <h2
          id={titleId}
          style={{ margin: '0', 'font-size': '17px', color: theme.fg, 'font-weight': '600' }}
        >
          {props.editId ? 'Edit Theme' : 'New Custom Theme'}
        </h2>
        <button
          onClick={() => props.onClose()}
          aria-label="Close"
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.fgMuted,
            cursor: 'pointer',
            'font-size': '19px',
            padding: '0 4px',
            'line-height': '1',
          }}
        >
          &times;
        </button>
      </div>

      {/* AI Prompt section */}
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
        <div
          style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' }}
        >
          <span style={sectionLabelStyle}>AI Prompt</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              onClick={() => setShowPrompt((v) => !v)}
              style={{
                background: 'transparent',
                border: `1px solid ${theme.border}`,
                color: theme.fgMuted,
                cursor: 'pointer',
                'font-size': '12px',
                padding: '3px 10px',
                'border-radius': '4px',
              }}
            >
              {showPrompt() ? 'Hide' : 'Show'} prompt
            </button>
            <button
              type="button"
              onClick={handleCopyPrompt}
              style={{
                background: copied() ? theme.success : theme.bgInput,
                border: `1px solid ${copied() ? theme.success : theme.border}`,
                color: copied() ? theme.accentText : theme.fg,
                cursor: 'pointer',
                'font-size': '12px',
                padding: '3px 10px',
                'border-radius': '4px',
                transition: 'background 0.2s, border-color 0.2s',
              }}
            >
              {copied() ? 'Copied!' : 'Copy Prompt'}
            </button>
          </div>
        </div>
        <Show when={showPrompt()}>
          <textarea
            readonly
            value={generateThemePrompt()}
            style={{
              width: '100%',
              height: '120px',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              color: theme.fgMuted,
              'font-family': "'JetBrains Mono', monospace",
              'font-size': '11px',
              padding: '8px',
              'border-radius': '6px',
              resize: 'vertical',
              'box-sizing': 'border-box',
            }}
          />
        </Show>
        <p
          style={{ margin: '0', 'font-size': '12px', color: theme.fgSubtle, 'line-height': '1.5' }}
        >
          Copy the prompt above and paste it into Claude Code (or any AI). The AI will ask about
          your preferences and generate a YAML theme. Paste the result below.
        </p>
      </div>

      {/* YAML paste area */}
      <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
        <span style={sectionLabelStyle}>Theme YAML</span>
        <textarea
          value={yaml()}
          onInput={(e) => setYaml(e.currentTarget.value)}
          placeholder={
            'name: My Theme\nterminalBackground: "#1a1a2e"\nvars:\n  --bg: "#0f0e17"\n  --fg: "#fffffe"'
          }
          spellcheck={false}
          style={{
            width: '100%',
            height: '200px',
            background: theme.bgInput,
            border: `1px solid ${error() ? theme.error : warnings().length > 0 ? theme.warning : isValid() ? theme.success : theme.border}`,
            color: theme.fg,
            'font-family': "'JetBrains Mono', monospace",
            'font-size': '12px',
            padding: '10px',
            'border-radius': '6px',
            resize: 'vertical',
            'box-sizing': 'border-box',
            outline: 'none',
            transition: 'border-color 0.15s',
          }}
        />
        <Show when={error()}>
          <p style={{ margin: '0', 'font-size': '12px', color: theme.error, 'line-height': '1.5' }}>
            {error()}
          </p>
        </Show>
        <Show when={parsed()} keyed>
          {(p) => (
            <p
              style={{
                margin: '0',
                'font-size': '12px',
                color: warnings().length > 0 ? theme.warning : theme.success,
              }}
            >
              Theme is valid — {Object.keys(p.vars).length} variable(s) defined.
              {warnings().length > 0 ? ` ${warnings().length} contrast warning(s).` : ''}
            </p>
          )}
        </Show>
        <Show when={warnings().length > 0}>
          <div
            style={{
              display: 'flex',
              'flex-direction': 'column',
              gap: '4px',
              padding: '8px 10px',
              background: `color-mix(in srgb, ${theme.warning} 8%, transparent)`,
              border: `1px solid color-mix(in srgb, ${theme.warning} 25%, transparent)`,
              'border-radius': '6px',
            }}
          >
            <span style={{ 'font-size': '11px', 'font-weight': '600', color: theme.warning }}>
              Contrast warnings (theme will still save)
            </span>
            <For each={warnings()}>
              {(w) => (
                <span
                  style={{
                    'font-size': '11px',
                    color: theme.fgMuted,
                    'font-family': "'JetBrains Mono', monospace",
                  }}
                >
                  {w.fgVar} on {w.bgVar}: {w.ratio.toFixed(2)}:1 (need {w.required}:1)
                </span>
              )}
            </For>
          </div>
        </Show>
      </div>

      {/* Actions */}
      <div
        style={{ display: 'flex', 'justify-content': 'flex-end', gap: '8px', 'margin-top': '4px' }}
      >
        <button
          type="button"
          onClick={() => props.onClose()}
          style={{
            background: 'transparent',
            border: `1px solid ${theme.border}`,
            color: theme.fgMuted,
            cursor: 'pointer',
            'font-size': '14px',
            padding: '7px 18px',
            'border-radius': '6px',
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={!isValid()}
          style={{
            background: isValid() ? theme.accent : theme.bgInput,
            border: `1px solid ${isValid() ? theme.accent : theme.border}`,
            color: isValid() ? theme.accentText : theme.fgSubtle,
            cursor: isValid() ? 'pointer' : 'not-allowed',
            'font-size': '14px',
            'font-weight': '600',
            padding: '7px 18px',
            'border-radius': '6px',
            transition: 'background 0.15s, border-color 0.15s',
          }}
        >
          {props.editId ? 'Update Theme' : 'Save & Apply'}
        </button>
      </div>
    </Dialog>
  );
}
