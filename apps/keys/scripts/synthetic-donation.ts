/**
 * Seal a synthetic donation to a project's key and send it, as a participant's browser would.
 * For trying the key page before the participant donate screen exists, and for the pilot's
 * manual test (docs/researcher-keys.md#manual-test-checklist-before-the-pilot).
 *
 *   pnpm synthetic-donation https://combray.example willow
 *
 * The data is made up. Prints the donation id and its withdrawal token.
 */
import { donationRequest, encodePayload, fingerprint, fromBase64Url, sealDonation } from '@combray/seal';

export async function main(server: string, project: string): Promise<void> {
  const base = server.replace(/\/+$/, '');
  const config = (await (await fetch(`${base}/api/v1/p/${project}/config`)).json()) as {
    donation_key?: { public_key: string; fingerprint: string };
  };
  if (!config.donation_key) throw new Error(`Project ${project} has no project key yet: create it on the key page first.`);
  const publicKey = fromBase64Url(config.donation_key.public_key);
  if ((await fingerprint(publicKey)) !== config.donation_key.fingerprint) throw new Error('The project key does not match its fingerprint.');

  const days = ['2026-10-01', '2026-10-02', '2026-10-03'];
  const fields = ['title', 'channel', 'day'];
  const payload = await encodePayload({
    format: 'combray-donation/2',
    // Each path once, with the names it is donated as and how its rows are told apart.
    entries: fields.map((field) => ({
      platform: 'youtube',
      path: ['watch-history.json', '[*]', field],
      table: 'watch_history',
      field,
      rows: [{ table: 'watch_history', steps: 2 }],
    })),
    // One value per field and row, as a participant's browser sends them: its entry and position.
    values: days.flatMap((day, row) =>
      [`Synthetic video ${row + 1}`, row % 2 ? 'Garden channel' : 'Cooking channel', day].map((value, entry): [number, number[], string] => [entry, [row], value]),
    ),
    answers: { reflection: 'This is a synthetic donation.' },
  });
  const donation = await sealDonation(payload, { projectId: project, projectPublicKey: publicKey });
  const response = await fetch(`${base}/api/v1/p/${project}/donations`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/octet-stream' },
    body: donationRequest(donation),
  });
  if (!response.ok) throw new Error(`The server answered ${response.status}: ${await response.text()}`);
  const result = (await response.json()) as { donation: string; withdrawal_token: string };
  console.log(`donation ${result.donation}\nwithdrawal token ${result.withdrawal_token}`);
}
