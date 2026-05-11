import { describe, it, expect } from 'vitest';
import { validateCustomTheme, buildCustomThemeCss } from './custom-theme';

describe('validateCustomTheme', () => {
  it('returns a CustomTheme for a valid object', () => {
    const input = {
      name: 'My Theme',
      terminalBackground: '#1a1a2e',
      vars: { '--bg': '#0f0e17', '--fg': '#fffffe' },
    };
    const result = validateCustomTheme(input);
    expect(result.name).toBe('My Theme');
    expect(result.terminalBackground).toBe('#1a1a2e');
    expect(result.vars['--bg']).toBe('#0f0e17');
  });

  it('throws for missing name', () => {
    expect(() => validateCustomTheme({ terminalBackground: '#000', vars: {} })).toThrow('name');
  });

  it('throws for missing terminalBackground', () => {
    expect(() => validateCustomTheme({ name: 'x', vars: {} })).toThrow('terminalBackground');
  });

  it('throws for non-object vars', () => {
    expect(() =>
      validateCustomTheme({ name: 'x', terminalBackground: '#000', vars: 'bad' }),
    ).toThrow('vars');
  });

  it('ignores unknown var keys and keeps known ones', () => {
    const result = validateCustomTheme({
      name: 'x',
      terminalBackground: '#000',
      vars: { '--bg': '#111', '--unknown-key': '#fff' },
    });
    expect('--bg' in result.vars).toBe(true);
    expect('--unknown-key' in result.vars).toBe(false);
  });
});

describe('buildCustomThemeCss', () => {
  it('generates a css rule for data-look=custom:id', () => {
    const css = buildCustomThemeCss({
      id: 'abc',
      name: 'Test',
      terminalBackground: '#111',
      vars: { '--bg': '#0f0e17', '--fg': '#fff' },
    });
    expect(css).toContain("html[data-look='custom:abc']");
    expect(css).toContain('--bg: #0f0e17');
    expect(css).toContain('--fg: #fff');
  });

  it('returns empty string for theme with no vars', () => {
    const css = buildCustomThemeCss({
      id: 'x',
      name: 'Empty',
      terminalBackground: '#000',
      vars: {},
    });
    expect(css).toBe('');
  });
});
