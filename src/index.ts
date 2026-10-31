import { serve } from "@hono/node-server";
import { postgresDb, sqliteDb } from "./db.js";
import { createApp } from "./server.js";
import { Guard } from "./service.js";

const env = process.env;
const ownerKeys = (env.OWNER_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
if (!ownerKeys.length) {
  console.error("OWNER_KEYS must be set (comma-separated). Owner keys create agents and set their policies.");
  process.exit(1);
}
if (ownerKeys.some((k) => k.length < 24)) {
  console.error("Each owner key must be at least 24 characters.");
  process.exit(1);
}

const db = env.DATABASE_URL ? await postgresDb(env.DATABASE_URL) : sqliteDb(env.SQLITE_PATH ?? "spend-guard.db");
const app = createApp({ guard: new Guard(db), ownerKeys });
const port = Number(env.PORT ?? 8790);
serve({ fetch: app.fetch, port });
console.log(`Spend Guard listening on http://localhost:${port} (${env.DATABASE_URL ? "Postgres" : "SQLite"})`);
