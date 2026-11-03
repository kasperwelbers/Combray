/**
 * Project keys. Each project has one X-Wing key pair. Participants' browsers seal every donation
 * key to its public key. Its private key seed is stored on the server once per member, sealed to
 * that member's personal key, so only a member's own key page can open it.
 *
 *   sealed project key = HPKE.seal(member public key,
 *                                  info = "combray/project-key/v1" \0 project id \0 researcher id,
 *                                  plaintext = project seed)
 */
import { type Bytes, fromBase64Url, toBase64Url } from './bytes';
import { type Sealed, info, newSeed, open, publicKeyOf, seal } from './hpke';

export interface ProjectKey {
  seed: Bytes;
  publicKey: Bytes;
}

/** Sealed bytes as they travel to and from the server. */
export interface SealedJson {
  enc: string;
  ciphertext: string;
}

export function sealedToJson(s: Sealed): SealedJson {
  return { enc: toBase64Url(s.enc), ciphertext: toBase64Url(s.ciphertext) };
}

export function sealedFromJson(s: SealedJson): Sealed {
  return { enc: fromBase64Url(s.enc), ciphertext: fromBase64Url(s.ciphertext) };
}

export async function newProjectKey(): Promise<ProjectKey> {
  const seed = newSeed();
  return { seed, publicKey: await publicKeyOf(seed) };
}

const label = (projectId: string, researcherId: string) => info('combray/project-key/v1', projectId, researcherId);

/** Seal the project key for one member, given that member's personal public key. */
export async function sealProjectKey(
  projectSeed: Uint8Array,
  memberPublicKey: Uint8Array,
  projectId: string,
  researcherId: string,
): Promise<Sealed> {
  return seal(memberPublicKey, label(projectId, researcherId), projectSeed);
}

/** Open this member's sealed copy of the project key with their personal key. */
export async function openProjectKey(
  sealed: Sealed,
  personalSeed: Uint8Array,
  projectId: string,
  researcherId: string,
): Promise<ProjectKey> {
  const seed = await open(personalSeed, label(projectId, researcherId), sealed);
  return { seed, publicKey: await publicKeyOf(seed) };
}
