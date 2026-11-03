import { defineConfig } from 'drizzle-kit';

/** Migrations for the main database. Generate with `pnpm --filter @combray/server db:generate`. */
export default defineConfig({ dialect: 'sqlite', schema: './src/db/schema.ts', out: './drizzle/main' });
