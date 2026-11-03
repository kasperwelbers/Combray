/**
 * Synthetic data donation packages, for trying a platform in the studio without a real one. They
 * are the test fixtures (fixtures/{name}/input), loaded only when a researcher picks one.
 */
const sources = import.meta.glob<string>('./fixtures/*/input/**/*', { query: '?raw', import: 'default' });

export interface ExamplePackage {
  id: string;
  /** The platform pack it belongs to. */
  pack: string;
  /** English: the studio is English only. */
  name: string;
  /** The package's files, by their path inside the package. */
  load(): Promise<{ path: string; text: string }[]>;
}

const EXAMPLES: Omit<ExamplePackage, 'load'>[] = [
  { id: 'google-takeout-en', pack: 'google-takeout', name: 'Google Takeout, in English (JSON)' },
  { id: 'google-takeout-nl-html', pack: 'google-takeout', name: 'Google Takeout, in Dutch (HTML)' },
  { id: 'tiktok-2023', pack: 'tiktok', name: 'TikTok, 2023 format' },
  { id: 'tiktok-2025', pack: 'tiktok', name: 'TikTok, 2025 format' },
];

export const examplePackages: ExamplePackage[] = EXAMPLES.map((example) => ({
  ...example,
  async load() {
    const prefix = `./fixtures/${example.id}/input/`;
    const files = Object.entries(sources).filter(([path]) => path.startsWith(prefix));
    return Promise.all(files.map(async ([path, read]) => ({ path: path.slice(prefix.length), text: await read() })));
  },
}));
