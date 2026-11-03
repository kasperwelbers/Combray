/** The server operator's commands: researcher accounts, project members, reset links. */
import { readFileSync } from 'node:fs';

import { Accounts, AccountFailure } from './accounts.ts';
import { configFromEnv } from './config.ts';
import { openMainDb } from './db.ts';
import { KeyService, loadStoreMasterKey, RESET_TTL_SECS } from './keys.ts';
import { ProjectFailure, Projects, validParticipantId, validProjectId } from './projects.ts';

/** How these commands are called: `combray-server`, or `pnpm admin` in development. */
const NAME = process.env.COMBRAY_CLI_NAME || 'combray-server';

const USAGE = `Commands for the server operator:

  ${NAME} researcher add <email>
      create a researcher account (they sign in with a code by email)
  ${NAME} researcher list
      list researcher accounts
  ${NAME} researcher remove <email>
      delete an account, its passkeys and memberships
  ${NAME} researcher reset-key <email>
      forget a researcher's key after they lost both passkey and recovery code
  ${NAME} project create <project> <name>
      create a project (researchers can also create projects in the studio)
  ${NAME} project import <file.json> [...]
      create or replace projects from config files, and publish them
      (for example deploy/examples/projects/*.json)
  ${NAME} project add-researcher <project> <email>
      make a researcher a member of a project, creating the account if needed
      (the first member creates the project key on the key page)
  ${NAME} reset-link <project> <participant-id>
      a one-time password reset link for a participant

For example: ${NAME} project add-researcher example you@example.org`;

const config = configFromEnv();
let args: string[] = [];

/** Print the commands; as an error (exit code 2) when a command was wrong. */
export function usage(asError = true): never {
  if (asError) console.error(USAGE);
  else console.log(USAGE);
  process.exit(asError ? 2 : 0);
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
  const accounts = new Accounts(openMainDb(config.dbPath));
  const [group, command, a, b] = args;
  try {
    if (group === 'researcher' && command === 'add' && a && !b) {
      accounts.addResearcher(a);
      console.log(`${a} can now sign in at ${research.keysUrl.href}`);
      console.log(`Add them to a project to see it: ${NAME} project add-researcher <project> ${a}`);
    } else if (group === 'researcher' && command === 'list' && !a) {
      for (const r of accounts.listResearchers()) console.log(`${r.email}\t${r.hasKey ? 'key set up' : 'no key yet'}\t${r.passkeys} passkey(s)`);
    } else if (group === 'researcher' && command === 'remove' && a && !b) {
      accounts.removeResearcher(a);
    } else if (group === 'researcher' && command === 'reset-key' && a && !b) {
      accounts.resetResearcherKey(a);
    } else if (group === 'project' && command === 'add-researcher' && a && b && args.length === 4) {
      if (!new Projects(openMainDb(config.dbPath)).exists(a)) {
        console.error(`no such project: ${a}`);
        process.exit(2);
      }
      const id = accounts.addResearcher(b);
      if (accounts.membership(a, id) !== undefined) console.log(`${b} is already a member of ${a}`);
      else {
        accounts.addMember(a, id);
        console.log(`${b} is now a member of ${a}`);
      }
    } else usage();
  } catch (e) {
    failed(e);
  }
}

/** Project commands that need no researcher settings: creating and importing projects. */
function projectCommands(): void {
  const projects = new Projects(openMainDb(config.dbPath));
  const [, command, ...rest] = args;
  try {
    if (command === 'create' && rest.length >= 2) {
      const [id, ...name] = rest;
      projects.create(id!, name.join(' '));
      console.log(`created project ${id}; add researchers with: ${NAME} project add-researcher ${id} <email>`);
    } else if (command === 'import' && rest.length >= 1) {
      for (const file of rest) {
        let config: unknown;
        try {
          config = JSON.parse(readFileSync(file, 'utf8'));
        } catch {
          console.error(`not a JSON file: ${file}`);
          process.exit(2);
        }
        console.log(`imported and published ${projects.importConfig(config)} (from ${file})`);
      }
    } else usage();
  } catch (e) {
    if (e instanceof ProjectFailure) {
      console.error(e.error === 'conflict' ? 'failed: a project with this id exists' : 'failed: invalid project (id, name, participants or uploads)');
      process.exit(1);
    }
    failed(e);
  }
}

/** Print a one-time link that lets a participant choose a new password for their stores in a project. */
function resetLink(project: string, participant: string): void {
  if (!validProjectId(project) || !validParticipantId(participant)) {
    console.error('invalid project or participant id');
    process.exit(2);
  }
  const keys = new KeyService(openMainDb(config.dbPath), loadStoreMasterKey(config.storeMasterKeyFile), config.argon2);
  const token = keys.createResetToken(project, participant);
  const base = (process.env.COMBRAY_PUBLIC_URL ?? '').replace(/\/+$/, '');
  console.log(`${base}/p/${project}/#reset=${token}`);
  console.error(`Valid for ${RESET_TTL_SECS / 3600} hours, once. It works on the device that holds the participant's data.`);
}

/** Run one command (`process.argv` after the script); prints the usage for unknown ones. */
export function runCommand(argv: string[]): void {
  args = argv;
  if (args[0] === 'reset-link' && args.length === 3) resetLink(args[1]!, args[2]!);
  else if (args[0] === 'project' && (args[1] === 'create' || args[1] === 'import')) projectCommands();
  else if (args[0] === 'researcher' || args[0] === 'project') researchers();
  else usage();
}
