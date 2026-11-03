// Build the key page as one self-contained HTML file: the bundled script and the stylesheet are
// inlined, and the page's Content Security Policy (in a <meta> tag) allows exactly those two by
// their SHA-256 hashes and nothing else. The server sends the same policy as a header.
//
// Writes dist/index.html and dist/index.html.sha256. The build is deterministic, so anyone can
// rebuild the page from the same commit and compare the hash with the published one.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'dist');

const result = await build({
  root,
  configFile: false,
  logLevel: 'warn',
  build: {
    write: false,
    target: 'es2022',
    // Not minified, so the page can be read and reviewed as it is served.
    minify: false,
    sourcemap: false,
    lib: { entry: join(root, 'src/main.ts'), formats: ['es'], fileName: 'keys' },
    rollupOptions: { output: { codeSplitting: false } },
  },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output);
const chunks = outputs.filter((o) => o.type === 'chunk');
if (chunks.length !== 1) throw new Error(`expected one script chunk, got ${chunks.length}`);
const script = chunks[0].code.trim();
if (/<\/script|<!--/i.test(script)) throw new Error('the bundle contains a sequence that would end the inline script');

const style = readFileSync(join(root, 'src/style.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s*\n\s*/g, '\n')
  .trim();

const hash = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
const csp = [
  "default-src 'none'",
  `script-src ${hash(script)}`,
  `style-src ${hash(style)}`,
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ');

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const template = readFileSync(join(root, 'index.html'), 'utf8');
const html = template
  .replace('__CSP__', () => csp)
  .replace('__VERSION__', () => version)
  .replace('__STYLE__', () => style)
  .replace('__SCRIPT__', () => script);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'index.html'), html);
const digest = createHash('sha256').update(html).digest('hex');
writeFileSync(join(out, 'index.html.sha256'), `${digest}  combray-keys.html\n`);
console.log(`key page: ${(html.length / 1024).toFixed(0)} KiB, sha256 ${digest}`);
