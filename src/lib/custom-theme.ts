export const CSS_VARS = [
  '--bg',
  '--bg-elevated',
  '--bg-input',
  '--bg-hover',
  '--bg-selected',
  '--bg-selected-subtle',
  '--border',
  '--border-subtle',
  '--border-focus',
  '--fg',
  '--fg-muted',
  '--fg-subtle',
  '--accent',
  '--accent-hover',
  '--accent-text',
  '--link',
  '--success',
  '--error',
  '--warning',
  '--island-bg',
  '--island-border',
  '--island-radius',
  '--task-container-bg',
  '--task-panel-bg',
] as const;

export type CssVar = (typeof CSS_VARS)[number];

export interface CustomTheme {
  id: string;
  name: string;
  terminalBackground: string;
  vars: Partial<Record<CssVar, string>>;
}

const CSS_VAR_SET = new Set<string>(CSS_VARS);

const CSS_VAR_DESCRIPTIONS: Record<CssVar, string> = {
  '--bg':
    'App-wide page background. Can be a hex color or gradient (e.g. "radial-gradient(130% 120% at 18% 0%, #202044 0%, #171c30 58%, #12151f 100%)")',
  '--bg-elevated': 'Raised surfaces: panels, dropdowns, tooltips',
  '--bg-input': 'Input fields and code editor backgrounds',
  '--bg-hover': 'Hover state background for buttons and list items',
  '--bg-selected': 'Selected item background (active task, highlighted row)',
  '--bg-selected-subtle':
    'Subtle selected state — usually same color as --bg-selected with ~25% alpha (e.g. "#2d2b5840")',
  '--border': 'Primary border for panels and inputs',
  '--border-subtle': 'Softer secondary borders',
  '--border-focus': 'Focus ring color when a field is focused (usually matches accent)',
  '--fg': 'Primary text color — must be readable on --bg-elevated',
  '--fg-muted': 'Secondary text, less important labels',
  '--fg-subtle': 'Tertiary text, placeholders, disabled states',
  '--accent': 'Primary interactive color — buttons, checkboxes, active indicators',
  '--accent-hover': 'Lighter/brighter version of accent for hover states',
  '--accent-text': 'Text color ON accent-colored backgrounds (usually white or near-black)',
  '--link': 'Hyperlink color (often a lighter, more saturated accent)',
  '--success': 'Success states, positive indicators (usually green-ish)',
  '--error': 'Error states, destructive actions (usually red-ish)',
  '--warning': 'Warning states, caution indicators (usually amber/orange)',
  '--island-bg':
    'Background of task column "islands" — typically 1-2 shades darker than bg-elevated',
  '--island-border': 'Border around task column islands',
  '--island-radius': 'Corner radius for islands (e.g. "12px", "8px", "0px" for sharp)',
  '--task-container-bg': 'Background of the task list container within an island',
  '--task-panel-bg':
    'Content panel backgrounds inside tasks (conceptually matches terminalBackground)',
};

export function validateCustomTheme(input: unknown): Omit<CustomTheme, 'id'> {
  if (!input || typeof input !== 'object') throw new Error('Theme must be a JSON object');
  const obj = input as Record<string, unknown>;

  if (typeof obj['name'] !== 'string' || !obj['name'].trim())
    throw new Error('"name" must be a non-empty string');

  if (typeof obj['terminalBackground'] !== 'string' || !obj['terminalBackground'].trim())
    throw new Error('"terminalBackground" must be a hex color string (e.g. "#1a1a2e")');

  if (!obj['vars'] || typeof obj['vars'] !== 'object' || Array.isArray(obj['vars']))
    throw new Error('"vars" must be an object mapping CSS variable names to values');

  const rawVars = obj['vars'] as Record<string, unknown>;
  const vars: Partial<Record<CssVar, string>> = {};
  for (const [key, value] of Object.entries(rawVars)) {
    if (CSS_VAR_SET.has(key) && typeof value === 'string') {
      vars[key as CssVar] = value;
    }
  }

  return { name: obj['name'].trim(), terminalBackground: obj['terminalBackground'].trim(), vars };
}

export function buildCustomThemeCss(theme: CustomTheme): string {
  const entries = Object.entries(theme.vars);
  if (entries.length === 0) return '';
  const body = entries.map(([k, v]) => `  ${k}: ${v};`).join('\n');
  return `html[data-look='custom:${theme.id}'] {\n${body}\n}`;
}

export function generateThemePrompt(): string {
  const varList = CSS_VARS.map((v) => `  "${v}": "..."  /* ${CSS_VAR_DESCRIPTIONS[v]} */`).join(
    '\n',
  );
  return `You are a UI theme designer for Parallel Code, a dark-mode terminal multiplexer and AI coding assistant.

Help me create a custom color theme by asking about my aesthetic preferences, then filling in the JSON template.

VARIABLES AND THEIR ROLES:
${CSS_VARS.map((v) => `• ${v}: ${CSS_VAR_DESCRIPTIONS[v]}`).join('\n')}

• terminalBackground: Opaque hex color for the terminal emulator (no gradients — hex only, should match --task-panel-bg conceptually)

Please:
1. Ask me about my aesthetic preferences (mood, accent color, reference themes I like, light vs dark)
2. Generate a complete theme JSON in this exact format when ready:

{
  "name": "My Theme Name",
  "terminalBackground": "#hex",
  "vars": {
${varList}
  }
}

RULES:
- All --bg-* and --fg-* values must be hex colors (no gradients)
- --bg may be a gradient if the aesthetic calls for it
- --bg-selected-subtle should be the same hue as --bg-selected with ~25% opacity appended (e.g. "#2d2b5840")
- --island-radius should be "12px", "8px", or "0px"
- Ensure sufficient contrast: --fg on --bg-elevated should meet WCAG AA (4.5:1 ratio)
- terminalBackground must be an opaque hex value
`;
}
