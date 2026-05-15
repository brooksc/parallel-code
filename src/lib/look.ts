export type LookPreset =
  | 'classic'
  | 'graphite'
  | 'midnight'
  | 'indigo'
  | 'ember'
  | 'glacier'
  | 'minimal'
  | 'zenburnesque'
  | 'catppuccin-mocha'
  | 'islands-dark'
  | 'islands-light'
  | 'workbench';

export type AppearanceMode = 'light' | 'dark' | 'system';

export interface LookPresetOption {
  id: LookPreset;
  label: string;
  description: string;
  tone: 'light' | 'dark';
}

export const LOOK_PRESETS: LookPresetOption[] = [
  {
    id: 'islands-dark',
    label: 'Islands Dark',
    description: 'JetBrains-inspired dark panels on a tinted frame',
    tone: 'dark',
  },
  {
    id: 'islands-light',
    label: 'Islands Light',
    description: 'JetBrains-inspired light panels on a soft tinted frame',
    tone: 'light',
  },
  {
    id: 'minimal',
    label: 'Minimal',
    description: 'Flat monochrome with warm off-white accent',
    tone: 'dark',
  },
  {
    id: 'graphite',
    label: 'Graphite',
    description: 'Cool neon blue with subtle glow',
    tone: 'dark',
  },
  {
    id: 'midnight',
    label: 'Midnight',
    description: 'Graphite with pure black terminals',
    tone: 'dark',
  },
  {
    id: 'classic',
    label: 'Classic',
    description: 'Original dark utilitarian look',
    tone: 'dark',
  },
  {
    id: 'indigo',
    label: 'Indigo',
    description: 'Deep indigo base with electric violet accents',
    tone: 'dark',
  },
  {
    id: 'ember',
    label: 'Ember',
    description: 'Warm copper highlights and contrast',
    tone: 'dark',
  },
  {
    id: 'glacier',
    label: 'Glacier',
    description: 'Clean teal accents with softer depth',
    tone: 'dark',
  },
  {
    id: 'zenburnesque',
    label: 'Zenburnesque',
    description: 'Warm sage and muted earth tones',
    tone: 'dark',
  },
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    description: 'Pastel mauve accents on the cozy Catppuccin Mocha palette',
    tone: 'dark',
  },
  {
    id: 'workbench',
    label: 'Workbench',
    description: 'VS Code-inspired flat three-tier dark with cobalt blue',
    tone: 'dark',
  },
];

export function presetsForTone(tone: 'light' | 'dark'): LookPresetOption[] {
  return LOOK_PRESETS.filter((p) => p.tone === tone);
}

export function defaultPresetForTone(tone: 'light' | 'dark'): LookPreset {
  return tone === 'light' ? 'islands-light' : 'islands-dark';
}

const LOOK_PRESET_IDS = new Set<string>(LOOK_PRESETS.map((p) => p.id));

export function isLookPreset(value: unknown): value is LookPreset {
  return typeof value === 'string' && LOOK_PRESET_IDS.has(value);
}
