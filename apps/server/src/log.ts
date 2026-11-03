/**
 * JSON logs to stdout. Privacy rule: method, route template, status, duration, counts and error
 * classes only. Never URLs, query strings, headers, bodies, addresses or any participant data.
 */
type Fields = Record<string, string | number | boolean | undefined>;

function write(level: string, fields: Fields, message: string): void {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...fields })}\n`);
}

export const log = {
  info: (fields: Fields, message: string) => write('INFO', fields, message),
  warn: (fields: Fields, message: string) => write('WARN', fields, message),
  error: (fields: Fields, message: string) => write('ERROR', fields, message),
};
