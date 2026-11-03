/**
 * `combray-server`: without arguments it runs the server; with arguments, an operator command
 * (src/commands.ts). In development, `pnpm admin` runs only the commands (src/cli.ts).
 */
import { createServer } from 'node:http';

import { createApp } from './app.ts';
import { runCommand } from './commands.ts';
import { configFromEnv, VERSION } from './config.ts';
import { log } from './log.ts';

const args = process.argv.slice(2);

if (args.length > 0) {
  runCommand(args);
} else {
  const config = configFromEnv();
  const server = createServer(createApp(config));
  server.on('error', (e: NodeJS.ErrnoException) => {
    // For example EADDRINUSE: another process has the port.
    log.error({ error_class: e.code ?? 'listen' }, 'could not listen');
    process.exit(1);
  });
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
