/**
 * A rough guess of how hard a password is to guess, only to warn about weak ones. It is not a
 * rule: any password of at least MIN_PASSWORD characters is accepted. Guessing is slow anyway,
 * since every guess goes to the server, which locks the store after a few tries.
 *
 * The estimate is length times log2 of the alphabet the characters come from (lowercase,
 * uppercase, digits, anything else), where a run of the same character ("aaaa") or a simple
 * sequence ("1234", "abcd", "4321") counts as one character.
 */

/** The minimum the participant app asks for. The server's check is in apps/server/src/keys.ts. */
export const MIN_PASSWORD = 6;

/** Below this many bits a password is called weak: e.g. 7 random digits (23 bits) are, 6 random lowercase letters (28 bits) are not. */
export const WEAK_BITS = 25;

export function passwordBits(password: string): number {
  const chars = [...password];
  if (chars.length === 0) return 0;
  let pool = 0;
  if (chars.some((c) => /[a-z]/.test(c))) pool += 26;
  if (chars.some((c) => /[A-Z]/.test(c))) pool += 26;
  if (chars.some((c) => /[0-9]/.test(c))) pool += 10;
  if (chars.some((c) => !/[a-zA-Z0-9]/.test(c))) pool += 33;
  return effectiveLength(chars) * Math.log2(pool);
}

export function isWeakPassword(password: string): boolean {
  return passwordBits(password) < WEAK_BITS;
}

/** The number of characters, where each run or simple sequence counts once. */
function effectiveLength(chars: string[]): number {
  let length = 1;
  let step: number | undefined;
  for (let i = 1; i < chars.length; i++) {
    const diff = chars[i]!.codePointAt(0)! - chars[i - 1]!.codePointAt(0)!;
    // Continues a run (diff 0) or a sequence (diff ±1) that started before.
    if (Math.abs(diff) <= 1 && (step === undefined || step === diff)) {
      step = diff;
      continue;
    }
    step = undefined;
    length += 1;
  }
  return length;
}
