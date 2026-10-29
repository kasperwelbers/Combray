/**
 * Browser-side XSS defences. See docs/security.md#xss-and-code-integrity.
 *
 * The server's Content Security Policy enforces Trusted Types: DOM sinks that can run code
 * (`innerHTML`, `eval`, script and worker URLs) refuse plain strings unless a policy approves
 * them. The CSP allows exactly one policy, `default`, defined here. It approves same-origin
 * script URLs (Vite's worker and chunk URLs) and nothing else: no HTML, no script text.
 */

interface TrustedTypePolicyFactory {
  createPolicy(
    name: string,
    rules: {
      createHTML?: (input: string) => string;
      createScript?: (input: string) => string;
      createScriptURL?: (input: string) => string;
    },
  ): unknown;
}

/** Allow a script URL only if it is on our own origin. */
export function sameOriginScriptUrl(input: string, base: string): string {
  const url = new URL(input, base);
  if (url.origin !== new URL(base).origin) throw new TypeError('blocked a cross-origin script URL');
  return url.href;
}

export function installTrustedTypesPolicy(): void {
  const factory = (globalThis as { trustedTypes?: TrustedTypePolicyFactory }).trustedTypes;
  // Browsers without Trusted Types ignore the CSP directive; React escapes text anyway.
  if (!factory) return;
  factory.createPolicy('default', {
    createHTML: () => {
      throw new TypeError('blocked raw HTML');
    },
    createScript: () => {
      throw new TypeError('blocked script text');
    },
    createScriptURL: (input) => sameOriginScriptUrl(input, location.href),
  });
}

/**
 * A link from participant data, made safe for `href`: only http(s) URLs, never `javascript:`,
 * `data:` or other schemes. Returns undefined for anything else.
 */
export function safeHref(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}
