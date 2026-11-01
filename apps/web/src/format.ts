/** Small display helpers for participant screens, kept free of React so they can be tested. */

const FILE = /\.(json|jsonl|csv|tsv|html?|xml|txt|js)$/i;

/** An HTML element name with classes or an id (`div.outer-cell`), not a file (`a.json`). */
const isElement = (name: string) => /^[a-z][a-z0-9]*(\[\d+\])?[.#]/.test(name) && !FILE.test(name);

/**
 * Where a table is, for people: names only, and a long run folded (`history › … › url`). HTML
 * element names lose their classes.
 */
export function foldedPath(path: string[]): string {
  const names = path.filter((n) => n !== '[*]' && n !== '{*}').map((n) => (isElement(n) ? n.split(/[.#]/)[0]! : n));
  return names.length <= 3 ? names.join(' › ') : `${names[0]} › … › ${names.slice(-2).join(' › ')}`;
}
