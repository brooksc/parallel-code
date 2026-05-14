import { createSignal, createEffect, Show, createUniqueId, on } from 'solid-js';
import { Dialog } from './Dialog';
import { theme, sectionLabelStyle } from '../lib/theme';
import { generateThemePrompt, parseThemeYaml } from '../lib/custom-theme';
import type { CustomTheme } from '../lib/custom-theme';
import { store, saveCustomTheme, activateCustomTheme } from '../store/store';

interface CustomThemeDialogProps {
  open: boolean;
  /** When set, we're editing an existing theme */
  editId?: string | null;
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
  const [copied, setCopied] = createSignal(false);
  const [showPrompt, setShowPrompt] = createSignal(false);

  // Reset state when dialog opens/closes or switches edit target
  createEffect(
    on(
      () => [props.open, props.editId] as const,
      ([open, editId]) => {
        if (!open) return;
        setError(null);
        setCopied(false);
        setShowPrompt(false);
        if (editId && store.customThemes[editId]) {
          setYaml(buildYamlForEdit(store.customThemes[editId]));
        } else {
          setYaml('');
        }
      },
    ),
  );

  // Live validation
  createEffect(() => {
    const text = yaml().trim();
    if (!text) {
      setError(null);
      return;
    }
    try {
      parseThemeYaml(text);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
    activateCustomTheme(id);
    props.onClose();
  }

  function handleCopyPrompt() {
    void navigator.clipboard.writeText(generateThemePrompt()).then(() => {
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
            border: `1px solid ${error() ? theme.error : isValid() ? theme.success : theme.border}`,
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
            <p style={{ margin: '0', 'font-size': '12px', color: theme.success }}>
              Theme is valid — {Object.keys(p.vars).length} variable(s) defined.
            </p>
          )}
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
