import { defineConfig } from 'drizzle-kit';

/** Migrations for the donation key database. Generate with `pnpm --filter @combray/server db:generate`. */
export default defineConfig({ dialect: 'sqlite', schema: './src/db/keys-schema.ts', out: './drizzle/keys' });
