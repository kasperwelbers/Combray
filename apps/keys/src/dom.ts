/**
 * A tiny DOM builder. Text always goes in as text nodes, never as HTML: the page's CSP has
 * Trusted Types with no policies, so any HTML sink would throw anyway.
 */

type Child = Node | string | false | null | undefined;
type Props = Record<string, string | boolean | ((e: Event) => void) | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (typeof value === 'function') el.addEventListener(key.replace(/^on/, '').toLowerCase(), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === false || child === null || child === undefined) continue;
    el.append(child);
  }
  return el;
}

/** Replace the page's main content and move focus to its heading, for screen readers. */
export function show(...children: Child[]): void {
  const main = document.getElementById('main');
  if (!main) return;
  main.replaceChildren(...children.filter((c): c is Node | string => !!c));
  const heading = main.querySelector('h1, h2');
  if (heading instanceof HTMLElement) {
    heading.tabIndex = -1;
    heading.focus();
  }
}

/** A button that shows it is busy while its action runs, and reports errors next to it. */
export function action(label: string, run: () => Promise<void>, props: Props = {}): HTMLElement {
  const error = h('p', { class: 'error', role: 'alert' });
  const button = h('button', { type: 'button', ...props }, label);
  button.addEventListener('click', async () => {
    button.disabled = true;
    error.textContent = '';
    try {
      await run();
    } catch (e) {
      error.textContent = message(e);
    } finally {
      button.disabled = false;
    }
  });
  return h('span', { class: 'action' }, button, error);
}

export function message(e: unknown): string {
  if (e instanceof DOMException && e.name === 'NotAllowedError') return 'The passkey prompt was closed or timed out. Try again when you are ready.';
  return e instanceof Error ? e.message : String(e);
}

/** Offer bytes as a file download. Nothing is written anywhere unless the researcher saves it. */
export function download(name: string, content: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
