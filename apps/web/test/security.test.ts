import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { safeHref, sameOriginScriptUrl } from '../src/security';

describe('safeHref', () => {
  it('keeps http(s) links', () => {
    expect(safeHref('https://www.youtube.com/watch?v=abc')).toBe('https://www.youtube.com/watch?v=abc');
    expect(safeHref('http://example.org/a b')).toBe('http://example.org/a%20b');
  });

  it('drops script, data and other schemes, and non-URLs', () => {
    for (const bad of [
      'javascript:alert(1)',
      ' JavaScript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:x',
      'file:///etc/passwd',
      '//evil.example/x',
      '/relative',
      'not a url',
      '',
    ]) {
      expect(safeHref(bad), bad).toBeUndefined();
    }
  });
});

describe('the Trusted Types policy', () => {
  const base = 'https://combray.example.edu/p/willow';

  it('allows same-origin script URLs', () => {
    expect(sameOriginScriptUrl('/assets/data.worker-abc.js', base)).toBe(
      'https://combray.example.edu/assets/data.worker-abc.js',
    );
  });

  it('blocks other origins', () => {
    for (const bad of ['https://evil.example/x.js', '//evil.example/x.js', 'data:text/javascript,1', 'blob:https://evil.example/1']) {
      expect(() => sameOriginScriptUrl(bad, base), bad).toThrow();
    }
  });
});

/** Raw HTML and code-from-string APIs have no place in the client. Use React and parsers. */
describe('client source', () => {
  const roots = ['src', '../../packages/core/src', '../../packages/store/src'].map((r) => join(__dirname, '..', r));
  const banned = /dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|new Function\(|\beval\(/;

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }

  it('uses no raw HTML sinks or eval', () => {
    const offenders = roots.flatMap(files).filter((f) => banned.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
