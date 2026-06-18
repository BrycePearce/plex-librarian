import { defineConfig } from 'drizzle-kit';

// process.env is shimmed in Deno 2.x via Node compat; also works when
// drizzle-kit runs this config in its own Node context.
declare const process: { env: Record<string, string | undefined> };

const dbPath = process.env['DB_PATH'] ?? './data/librarian.db';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: dbPath,
  },
});
