/**
 * Names: the readable ids of tables and fields (docs/decisions/0013-names-labels-versions.md).
 *
 * A name is what stories, filters, exports and donations call a table or a field: lowercase
 * letters, digits and underscores, starting with a letter (`watch_history`, `title_text`). What
 * participants see is a label, kept apart from the extractor; without one, they see the name
 * with spaces and a capital (`Watch history`). Typed text becomes a name the way the studio
 * converts it as you type (`toName`), which also turns keys into the names they get by default.
 */

/** Names longer than this are cut: they are ids, not sentences. */
export const MAX_NAME = 64;

const NAME = /^[a-z][a-z0-9_]*$/;

/** Whether a text is a name: lowercase letters, digits and underscores, starting with a letter. */
export function isName(text: string): boolean {
  return text.length <= MAX_NAME && NAME.test(text) && !text.endsWith('_') && !text.includes('__');
}

/**
 * The name for a text or key: accents dropped, words split at spaces, punctuation and camelCase,
 * lowercase, joined with underscores (`Video title` and `videoTitle` become `video_title`).
 * A name starting with a digit gets an `x` in front (`2fa` becomes `x2fa`), as R's janitor does.
 * Empty when nothing of it is left.
 */
export function toName(text: string): string {
  const words = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // camelCase and PascalCase: `titleText`, `URLList` → `title Text`, `URL List`.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let name = words.join('_');
  if (/^[0-9]/.test(name)) name = `x${name}`;
  return name.slice(0, MAX_NAME).replace(/_+$/, '');
}

/**
 * The name as typed, while someone types it: like `toName`, but a space or underscore at the end
 * stays, so the next word can follow (`video ` becomes `video_`).
 */
export function typingName(text: string): string {
  const name = toName(text);
  return name !== '' && /[\s_\-.]$/.test(text) && name.length < MAX_NAME ? `${name}_` : name;
}

/** What participants see when there is no label: the name with spaces and a capital (`Watch history`). */
export function defaultLabel(name: string): string {
  const text = name.replace(/_+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A name not in `taken`: the name itself, else with `_2`, `_3`, … after it. */
export function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name.slice(0, MAX_NAME - String(i).length - 1)}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
