import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSandbox, ScriptError, type ScriptSandbox } from '../src';

let sandbox: ScriptSandbox;
beforeAll(async () => {
  sandbox = await createSandbox({ callMs: 100, memoryBytes: 8 * 1024 * 1024 });
});
afterAll(() => sandbox.dispose());

describe('script sandbox', () => {
  it('runs pure functions on JSON values', () => {
    const f = sandbox.compile('(url) => url.match(/video\\/(\\d+)/)?.[1] ?? null');
    expect(f('https://www.tiktok.com/@a/video/123')).toBe('123');
    expect(f('nothing')).toBeNull();
    const g = sandbox.compile('(value, row) => ({ n: row.items.length, first: row.items[0] })');
    expect(g(null, { items: ['a', 'b'] })).toEqual({ n: 2, first: 'a' });
  });

  it('turns undefined into null', () => {
    expect(sandbox.compile('() => undefined')()).toBeNull();
  });

  it('has no network, DOM or host access', () => {
    for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'document', 'window', 'process', 'require', 'importScripts', 'setTimeout']) {
      expect(sandbox.compile(`() => typeof ${name}`)(), name).toBe('undefined');
    }
  });

  it('stops runaway scripts', () => {
    const loop = sandbox.compile('() => { while (true) {} }');
    expect(() => loop()).toThrow(ScriptError);
    expect(() => loop()).toThrow(/too long/);
    // The sandbox is still usable afterwards.
    expect(sandbox.compile('(x) => x + 1')(1)).toBe(2);
  });

  it('bounds memory', () => {
    const hog = sandbox.compile('() => new Array(4000000).fill(1).length');
    expect(() => hog()).toThrow(ScriptError);
  });

  it('reports errors from scripts', () => {
    expect(() => sandbox.compile('(x) => x.y.z')(null)).toThrow(ScriptError);
    expect(() => sandbox.compile('42')).toThrow(/must be a function/);
    expect(() => sandbox.compile('(x) =>')).toThrow(ScriptError);
  });
});
