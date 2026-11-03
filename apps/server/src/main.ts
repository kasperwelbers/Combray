/** `combray-server`: run the server, or one of the operator commands below. */
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { Accounts, AccountFailure } from './accounts.ts';
import { createApp } from './app.ts';
import { configFromEnv, VERSION } from './config.ts';
import { KeyService, loadStoreMasterKey, RESET_TTL_SECS } from './keys.ts';
import { log } from './log.ts';
import { validParticipantId, validProjectId } from './projects.ts';

const USAGE = `usage: combray-server [command]

  reset-link <project> <participant-id>   a one-time password reset link for a participant
  researcher add <email>                  create a researcher account (they sign in by email)
  researcher list                         list researcher accounts
  researcher remove <email>               delete an account, its passkeys and memberships
  researcher reset-key <email>            forget a researcher's key after they lost both their
                                          passkeys and recovery code; colleagues grant access again
  project add-researcher <project> <email>
                                          make a researcher a member of a project (the first
                                          member creates the project key on the key page)`;

const config = configFromEnv();
const args = process.argv.slice(2);

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

function failed(e: unknown): never {
  console.error(`failed: ${e instanceof AccountFailure ? e.error : e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

/** Researcher and project membership commands, for the server operator. */
function researchers(): void {
  const research = config.research;
  if (!research) {
    console.error('set COMBRAY_PUBLIC_URL and COMBRAY_KEYS_URL to use researcher accounts');
    process.exit(2);
  }
  const accounts = new Accounts(research.researchDb);
  const [group, command, a, b] = args;
  try {
    if (group === 'researcher' && command === 'add' && a && !b) {
      accounts.addResearcher(a);
      console.log(`${a} can now sign in at ${research.keysUrl.href}`);
    } else if (group === 'researcher' && command === 'list' && !a) {
      for (const r of accounts.listResearchers()) console.log(`${r.email}\t${r.hasKey ? 'key set up' : 'no key yet'}\t${r.passkeys} passkey(s)`);
    } else if (group === 'researcher' && command === 'remove' && a && !b) {
      accounts.removeResearcher(a);
    } else if (group === 'researcher' && command === 'reset-key' && a && !b) {
      accounts.resetResearcherKey(a);
    } else if (group === 'project' && command === 'add-researcher' && a && b && args.length === 4) {
      if (!validProjectId(a) || !existsSync(join(config.dataDir, 'projects', `${a}.json`))) {
        console.error(`no such project: ${a}`);
        process.exit(2);
      }
      accounts.addMember(a, accounts.addResearcher(b));
      console.log(`${b} is a member of ${a}`);
    } else usage();
  } catch (e) {
    failed(e);
  }
}

/** Print a one-time link that lets a participant choose a new password for their stores in a project. */
function resetLink(project: string, participant: string): void {
  if (!validProjectId(project) || !validParticipantId(participant)) {
    console.error('invalid project or participant id');
    process.exit(2);
  }
  const keys = new KeyService(config.dbPath, loadStoreMasterKey(config.storeMasterKeyFile), config.argon2);
  const token = keys.createResetToken(project, participant);
  const base = (process.env.COMBRAY_PUBLIC_URL ?? '').replace(/\/+$/, '');
  console.log(`${base}/p/${project}/#reset=${token}`);
  console.error(`Valid for ${RESET_TTL_SECS / 3600} hours, once. It works on the device that holds the participant's data.`);
}

if (args[0] === 'reset-link' && args.length === 3) {
  resetLink(args[1]!, args[2]!);
} else if (args[0] === 'researcher' || args[0] === 'project') {
  researchers();
} else if (args.length > 0) {
  usage();
} else {
  const server = createServer(createApp(config));
  server.listen(config.bind.port, config.bind.host, () => {
    log.info({ addr: `${config.bind.host}:${config.bind.port}`, version: VERSION }, 'combray-server listening');
  });
  const shutdown = () => {
    log.info({}, 'shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
