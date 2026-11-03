/** The operator's commands only (`pnpm admin`): never starts the server; lists the commands without any. */
import { runCommand, usage } from './commands.ts';

const args = process.argv.slice(2);
if (args.length === 0) usage(false);
else runCommand(args);
