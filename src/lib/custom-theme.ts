import { parse as parseYaml } from 'yaml';
import { colord, extend } from 'colord';
import a11yPlugin from 'colord/plugins/a11y';

extend([a11yPlugin]);

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
    'App-wide page background. Can be a hex color or CSS gradient (e.g. "radial-gradient(130% 120% at 18% 0%, #202044 0%, #171c30 58%, #12151f 100%)")',
  '--bg-elevated': 'Raised surfaces: panels, dropdowns, tooltips',
  '--bg-input': 'Input fields and code editor backgrounds',
  '--bg-hover': 'Hover state background for buttons and list items',
  '--bg-selected': 'Selected item background (active task, highlighted row)',
  '--bg-selected-subtle':
    'Subtle selected state — same hue as --bg-selected with ~25% alpha (e.g. "#2d2b5840")',
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
  if (!input || typeof input !== 'object') throw new Error('Theme must be an object');
  const obj = input as Record<string, unknown>;

  if (typeof obj['name'] !== 'string' || !obj['name'].trim())
    throw new Error('"name" must be a non-empty string');

  if (typeof obj['terminalBackground'] !== 'string' || !obj['terminalBackground'].trim())
    throw new Error('"terminalBackground" must be a hex color string (e.g. "#1a1a2e")');

  if (!obj['vars'] || typeof obj['vars'] !== 'object' || Array.isArray(obj['vars']))
    throw new Error('"vars" must be a mapping of CSS variable names to values');

  const rawVars = obj['vars'] as Record<string, unknown>;
  const vars: Partial<Record<CssVar, string>> = {};
  // Non-string values and unknown var names are silently ignored
  for (const [key, value] of Object.entries(rawVars)) {
    if (CSS_VAR_SET.has(key) && typeof value === 'string') {
      vars[key as CssVar] = value;
    }
  }

  return { name: obj['name'].trim(), terminalBackground: obj['terminalBackground'].trim(), vars };
}

/** Parse a YAML theme string (comments preserved by user/AI are fine) and validate it. */
export function parseThemeYaml(yamlString: string): Omit<CustomTheme, 'id'> {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlString);
  } catch (e) {
    throw new Error(`Invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  return validateCustomTheme(parsed);
}

export function buildCustomThemeCss(theme: CustomTheme): string {
  const entries = Object.entries(theme.vars);
  if (entries.length === 0) return '';
  const body = entries.map(([k, v]) => `  ${k}: ${v};`).join('\n');
  return `html[data-look='custom:${theme.id}'] {\n${body}\n}`;
}

export interface ContrastWarning {
  fgVar: CssVar;
  bgVar: CssVar;
  fg: string;
  bg: string;
  ratio: number;
  required: number;
}

/** Pairs to check: [fgVar, bgVar, minimumRatio] */
const CONTRAST_PAIRS: [CssVar, CssVar, number][] = [
  ['--fg', '--bg-elevated', 4.5],
  ['--fg-muted', '--bg-elevated', 3.0],
  ['--fg', '--bg-selected', 4.5],
  ['--accent-text', '--accent', 4.5],
];

/** Alpha-blend a color over an opaque background, returning the composited hex. */
function blendOver(color: string, backdrop: string): string {
  const c = colord(color).toRgb();
  const b = colord(backdrop).toRgb();
  const a = c.a ?? 1;
  return colord({
    r: Math.round(c.r * a + b.r * (1 - a)),
    g: Math.round(c.g * a + b.g * (1 - a)),
    b: Math.round(c.b * a + b.b * (1 - a)),
  }).toHex();
}

export function checkThemeContrast(vars: Partial<Record<CssVar, string>>): ContrastWarning[] {
  const warnings: ContrastWarning[] = [];
  const bgElevated = vars['--bg-elevated'];

  for (const [fgVar, bgVar, required] of CONTRAST_PAIRS) {
    const fg = vars[fgVar];
    const bg = vars[bgVar];
    if (!fg || !bg) continue;
    try {
      // If the bg has alpha, composite it over --bg-elevated before checking.
      // Without blending, rgba(x,y,z,0.2) would be compared against white,
      // producing false positives for intentionally translucent selected states.
      const resolvedBg = bgElevated && colord(bg).alpha() < 1 ? blendOver(bg, bgElevated) : bg;

      const ratio = colord(fg).contrast(colord(resolvedBg));
      if (isFinite(ratio) && ratio < required) {
        warnings.push({ fgVar, bgVar, fg, bg, ratio: Math.round(ratio * 100) / 100, required });
      }
    } catch {
      // unparseable color value — skip
    }
  }
  return warnings;
}

/** Serializes theme data back to the YAML format the dialog accepts. */
export function themeToYaml(
  name: string,
  terminalBackground: string,
  vars: Partial<Record<CssVar, string>>,
): string {
  const varLines = CSS_VARS.filter((v) => v in vars)
    .map((v) => `  ${v}: "${vars[v]}"`)
    .join('\n');
  return `name: ${name}\nterminalBackground: "${terminalBackground}"\nvars:\n${varLines}\n`;
}

const RULES = `RULES:
- All --bg-* and --fg-* values must be hex colors (no gradients)
- --bg may be a CSS gradient if the aesthetic calls for it
- --bg-selected-subtle should be the same hue as --bg-selected with ~25% opacity appended (e.g. "#2d2b5840")
- --island-radius should be "12px", "8px", or "0px"
- Ensure sufficient contrast: --fg on --bg-elevated should meet WCAG AA (4.5:1 ratio)
- terminalBackground must be an opaque hex value
- Wrap any value containing a colon or special characters in double quotes`;

export function generateThemePrompt(existingYaml?: string): string {
  const varList = CSS_VARS.map((v) => `  ${v}: "..." # ${CSS_VAR_DESCRIPTIONS[v]}`).join('\n');
  const preamble = `You are a UI theme designer for Parallel Code, a dark-mode terminal multiplexer and AI coding assistant.`;

  if (existingYaml) {
    return `${preamble}

I have an existing theme I'd like to modify. Ask me what I'd like to change, then output the complete updated YAML (keep inline comments where helpful).

CURRENT THEME:
\`\`\`yaml
${existingYaml.trim()}
\`\`\`

VARIABLES AND THEIR ROLES:
${CSS_VARS.map((v) => `• ${v}: ${CSS_VAR_DESCRIPTIONS[v]}`).join('\n')}

• terminalBackground: Opaque hex color for the terminal emulator (hex only, no gradients)

${RULES}
`;
  }

  return `${preamble}

Help me create a custom color theme by asking about my aesthetic preferences, then filling in the YAML template.

VARIABLES AND THEIR ROLES:
${CSS_VARS.map((v) => `• ${v}: ${CSS_VAR_DESCRIPTIONS[v]}`).join('\n')}

• terminalBackground: Opaque hex color for the terminal emulator (hex only, no gradients — should match --task-panel-bg conceptually)

Please:
1. Ask me about my aesthetic preferences (mood, accent color, reference themes I like, light vs dark)
2. Generate a complete theme in this exact YAML format when ready (keep the comments — they help the user understand each value):

name: My Theme Name
terminalBackground: "#hex"
vars:
${varList}

${RULES}
`;
}
