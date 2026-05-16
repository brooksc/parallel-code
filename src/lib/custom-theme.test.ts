import { describe, it, expect } from 'vitest';
import { parseThemeCss, buildCustomThemeCss, themeToCss } from './custom-theme';

describe('parseThemeCss', () => {
  it('parses a valid CSS theme with header comment', () => {
    const css = `/*
  name: Midnight Plum
  terminalBackground: #1a1a2e
*/

:root {
  --bg: #0f0e17;
  --fg: #fffffe;
}`;
    const result = parseThemeCss(css);
    expect(result.name).toBe('Midnight Plum');
    expect(result.description).toBe('');
    expect(result.terminalBackground).toBe('#1a1a2e');
    expect(result.vars['--bg']).toBe('#0f0e17');
    expect(result.vars['--fg']).toBe('#fffffe');
  });

  it('preserves inline comments and still parses values', () => {
    const css = `/*
  name: Test
  terminalBackground: #000
*/
:root {
  --bg: #0f0e17; /* App background */
  --fg: #fffffe; /* Primary text */
}`;
    const result = parseThemeCss(css);
    expect(result.vars['--bg']).toBe('#0f0e17');
    expect(result.vars['--fg']).toBe('#fffffe');
  });

  it('throws when header comment is missing', () => {
    expect(() => parseThemeCss(':root { --bg: #000; }')).toThrow('header comment block');
  });

  it('throws when name is missing from header', () => {
    const css = `/* terminalBackground: #000 */\n:root { --bg: #000; }`;
    expect(() => parseThemeCss(css)).toThrow('name');
  });

  it('throws when terminalBackground is missing from header', () => {
    const css = `/* name: My Theme */\n:root { --bg: #000; }`;
    expect(() => parseThemeCss(css)).toThrow('terminalBackground');
  });

  it('silently ignores unknown CSS variable names', () => {
    const css = `/*\n  name: x\n  terminalBackground: #000\n*/\n:root {\n  --bg: #111;\n  --unknown-key: #fff;\n}`;
    const result = parseThemeCss(css);
    expect('--bg' in result.vars).toBe(true);
    expect('--unknown-key' in result.vars).toBe(false);
  });

  it('handles values without trailing semicolon', () => {
    const css = `/*\n  name: x\n  terminalBackground: #000\n*/\n:root {\n  --bg: #111\n}`;
    const result = parseThemeCss(css);
    expect(result.vars['--bg']).toBe('#111');
  });

  it('parses gradient values correctly', () => {
    const css = `/*\n  name: x\n  terminalBackground: #000\n*/\n:root {\n  --bg: radial-gradient(130% 120% at 18% 0%, #202044 0%, #12151f 100%);\n}`;
    const result = parseThemeCss(css);
    expect(result.vars['--bg']).toBe(
      'radial-gradient(130% 120% at 18% 0%, #202044 0%, #12151f 100%)',
    );
  });

  it('correctly parses multiple declarations on one line', () => {
    const css = `/*\n  name: x\n  terminalBackground: #000\n*/\n:root { --bg: #111; --fg: #fff; }`;
    const result = parseThemeCss(css);
    expect(result.vars['--bg']).toBe('#111');
    expect(result.vars['--fg']).toBe('#fff');
  });

  it('throws when :root block contains nested rules', () => {
    const css = `/*\n  name: x\n  terminalBackground: #000\n*/\n:root {\n  --bg: #111;\n  @media (x) { --fg: #fff; }\n}`;
    expect(() => parseThemeCss(css)).toThrow('Nested rules');
  });

  it('throws when :root block is missing', () => {
    const css = `/*\n  name: x\n  terminalBackground: #000\n*/\nbody { --bg: #111; }`;
    expect(() => parseThemeCss(css)).toThrow(':root');
  });

  it('throws when :root block has no recognized CSS variables', () => {
    const css = `/*\n  name: x\n  terminalBackground: #000\n*/\n:root { --unknown-a: #111; --unknown-b: #fff; }`;
    expect(() => parseThemeCss(css)).toThrow('recognized CSS variables');
  });

  it('throws when terminalBackground is not a valid opaque color', () => {
    const css = `/*\n  name: x\n  terminalBackground: linear-gradient(red, blue)\n*/\n:root { --bg: #111; }`;
    expect(() => parseThemeCss(css)).toThrow('terminalBackground');
  });

  it('throws when terminalBackground has transparency (rgba)', () => {
    const css = `/*\n  name: x\n  terminalBackground: rgba(0,0,0,0.5)\n*/\n:root { --bg: #111; }`;
    expect(() => parseThemeCss(css)).toThrow('terminalBackground');
  });

  it('throws when terminalBackground is rgb() instead of hex', () => {
    const css = `/*\n  name: x\n  terminalBackground: rgb(1,2,3)\n*/\n:root { --bg: #111; }`;
    expect(() => parseThemeCss(css)).toThrow('terminalBackground');
  });

  it('ignores variables in non-root blocks', () => {
    const css = `/*\n  name: x\n  terminalBackground: #000\n*/\nbody { --bg: #bad; }\n:root { --fg: #fff; }`;
    const result = parseThemeCss(css);
    expect('--bg' in result.vars).toBe(false);
    expect(result.vars['--fg']).toBe('#fff');
  });

  it('treats commented-out :root block as missing', () => {
    const css = `/*\n  name: x\n  terminalBackground: #000\n*/\n/* :root { --bg: #111; } */`;
    expect(() => parseThemeCss(css)).toThrow(':root');
  });
});

describe('themeToCss', () => {
  it('serializes to the expected CSS format', () => {
    const css = themeToCss('My Theme', 'A moody dark theme', '#1a1a2e', {
      '--bg': '#0f0e17',
      '--fg': '#fffffe',
    });
    expect(css).toContain('name: My Theme');
    expect(css).toContain('terminalBackground: #1a1a2e');
    expect(css).toContain('--bg: #0f0e17;');
    expect(css).toContain('--fg: #fffffe;');
    expect(css).toContain('description: A moody dark theme');
    // round-trips
    const parsed = parseThemeCss(css);
    expect(parsed.name).toBe('My Theme');
    expect(parsed.description).toBe('A moody dark theme');
    expect(parsed.terminalBackground).toBe('#1a1a2e');
    expect(parsed.vars['--bg']).toBe('#0f0e17');
  });
});

describe('buildCustomThemeCss', () => {
  it('generates a css rule for data-look=custom:id', () => {
    const css = buildCustomThemeCss({
      id: 'abc',
      name: 'Test',
      description: '',
      terminalBackground: '#111',
      vars: { '--bg': '#0f0e17', '--fg': '#fff' },
    });
    expect(css).toContain("html[data-custom-theme='abc']");
    expect(css).toContain('--bg: #0f0e17');
    expect(css).toContain('--fg: #fff');
  });

  it('returns empty string for theme with no vars', () => {
    const css = buildCustomThemeCss({
      id: 'x',
      name: 'Empty',
      description: '',
      terminalBackground: '#000',
      vars: {},
    });
    expect(css).toBe('');
  });
});
