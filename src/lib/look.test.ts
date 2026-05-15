import { describe, it, expect } from 'vitest';
import { LOOK_PRESETS, presetsForTone, defaultPresetForTone } from './look';

describe('presetsForTone', () => {
  it('returns only dark presets for tone dark', () => {
    const dark = presetsForTone('dark');
    expect(dark.length).toBeGreaterThan(0);
    expect(dark.every((p) => p.tone === 'dark')).toBe(true);
  });

  it('returns only light presets for tone light', () => {
    const light = presetsForTone('light');
    expect(light.length).toBeGreaterThan(0);
    expect(light.every((p) => p.tone === 'light')).toBe(true);
  });

  it('dark + light covers every preset exactly once', () => {
    const all = [...presetsForTone('dark'), ...presetsForTone('light')];
    expect(all.length).toBe(LOOK_PRESETS.length);
    expect(new Set(all.map((p) => p.id)).size).toBe(LOOK_PRESETS.length);
  });

  it('islands-light is the only light preset', () => {
    const light = presetsForTone('light');
    expect(light.map((p) => p.id)).toEqual(['islands-light']);
  });
});

describe('defaultPresetForTone', () => {
  it('returns islands-light for light', () => {
    expect(defaultPresetForTone('light')).toBe('islands-light');
  });

  it('returns islands-dark for dark', () => {
    expect(defaultPresetForTone('dark')).toBe('islands-dark');
  });
});
