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

export interface LookPresetOption {
  id: LookPreset;
  label: string;
  description: string;
}

export const LOOK_PRESETS: LookPresetOption[] = [
  {
    id: 'islands-dark',
    label: 'Islands Dark',
    description: 'JetBrains-inspired dark panels on a tinted frame',
  },
  {
    id: 'islands-light',
    label: 'Islands Light',
    description: 'JetBrains-inspired light panels on a soft tinted frame',
  },
  {
    id: 'minimal',
    label: 'Minimal',
    description: 'Flat monochrome with warm off-white accent',
  },
  {
    id: 'graphite',
    label: 'Graphite',
    description: 'Cool neon blue with subtle glow',
  },
  {
    id: 'midnight',
    label: 'Midnight',
    description: 'Graphite with pure black terminals',
  },
  {
    id: 'classic',
    label: 'Classic',
    description: 'Original dark utilitarian look',
  },
  {
    id: 'indigo',
    label: 'Indigo',
    description: 'Deep indigo base with electric violet accents',
  },
  {
    id: 'ember',
    label: 'Ember',
    description: 'Warm copper highlights and contrast',
  },
  {
    id: 'glacier',
    label: 'Glacier',
    description: 'Clean teal accents with softer depth',
  },
  {
    id: 'zenburnesque',
    label: 'Zenburnesque',
    description: 'Warm sage and muted earth tones',
  },
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    description: 'Pastel mauve accents on the cozy Catppuccin Mocha palette',
  },
  {
    id: 'workbench',
    label: 'Workbench',
    description: 'VS Code-inspired flat three-tier dark with cobalt blue',
  },
];

const LOOK_PRESET_IDS = new Set<string>(LOOK_PRESETS.map((p) => p.id));

export function isLookPreset(value: unknown): value is LookPreset {
  return typeof value === 'string' && LOOK_PRESET_IDS.has(value);
}
