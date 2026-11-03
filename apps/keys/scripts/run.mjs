// Run a TypeScript script from this folder with Vite's module runner (no extra dependencies):
//   node scripts/run.mjs synthetic-donation <args…>
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const [name, ...args] = process.argv.slice(2);
const file = fileURLToPath(new URL(`./${name}.ts`, import.meta.url));
const { module } = await runnerImport(file, { root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, logLevel: 'error' });
try {
  await module.main(...args);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
