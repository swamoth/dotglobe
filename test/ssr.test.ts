import { describe, expect, it } from 'vitest';

// A server render imports the package with no window and no document. Every module must load
// there, and only createGlobe may need a browser.
describe('server import', () => {
  it('loads every entry in Node', async () => {
    expect(typeof globalThis.document).toBe('undefined');
    const core = await import('../src/index');
    const react = await import('../src/react');
    const land = await import('../src/land');
    expect(typeof core.createGlobe).toBe('function');
    expect(typeof react.useGlobe).toBe('function');
    expect(typeof land.land).toBe('function');
  });
});
