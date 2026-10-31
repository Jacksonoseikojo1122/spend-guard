import { serve } from "@hono/node-server";
import { postgresDb, sqliteDb } from "./db.js";
import { momoClient } from "./momo.js";
import { consoleNotifier, webhookNotifier, type Notifier } from "./notify.js";
import { createApp } from "./server.js";
import { Guard } from "./service.js";

const env = process.env;
const fail = (msg: string) => {
  console.error(msg);
  process.exit(1);
};

const ownerKeys = (env.OWNER_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
if (!ownerKeys.length) fail("OWNER_KEYS must be set (comma-separated). Owner keys create agents and set their policies.");
if (ownerKeys.some((k) => k.length < 24)) fail("Each owner key must be at least 24 characters.");

// Approval notices: a signed webhook if configured (connect it to your SMS or WhatsApp sender),
// otherwise printed to the console, which is enough to click through locally.
let notifier: Notifier = consoleNotifier;
if (env.APPROVAL_WEBHOOK_URL) {
  if (!env.APPROVAL_WEBHOOK_SECRET) fail("APPROVAL_WEBHOOK_SECRET must be set with APPROVAL_WEBHOOK_URL.");
  notifier = webhookNotifier(env.APPROVAL_WEBHOOK_URL, env.APPROVAL_WEBHOOK_SECRET!);
}

// Payouts through MoMo One-API. Without MOMO_URL, decisions are recorded but no money moves.
let payouts: { client: ReturnType<typeof momoClient>; webhookSecret?: string } | undefined;
if (env.MOMO_URL) {
  if (!env.MOMO_API_KEY) fail("MOMO_API_KEY must be set with MOMO_URL.");
  payouts = { client: momoClient(env.MOMO_URL, env.MOMO_API_KEY!), webhookSecret: env.MOMO_WEBHOOK_SECRET };
  if (!env.MOMO_WEBHOOK_SECRET) console.warn("MOMO_WEBHOOK_SECRET isn't set: payout results will only arrive by polling, about once a minute.");
} else {
  console.warn("MOMO_URL isn't set: allowed and approved requests are recorded, but no payouts are sent.");
}

const port = Number(env.PORT ?? 8790);
const db = env.DATABASE_URL ? await postgresDb(env.DATABASE_URL) : sqliteDb(env.SQLITE_PATH ?? "spend-guard.db");
const guard = new Guard(db, { notifier, publicUrl: env.PUBLIC_URL ?? `http://localhost:${port}`, payouts });
serve({ fetch: createApp({ guard, ownerKeys }).fetch, port });
console.log(`Spend Guard listening on http://localhost:${port} (${env.DATABASE_URL ? "Postgres" : "SQLite"})`);

// Holds already stop counting and can't be approved once their time is up; this just records
// the expiry in the audit log promptly.
// It also resends payouts that never got through and re-checks unfinished ones, in case a
// webhook was missed.
setInterval(() => {
  guard.expireHolds().then(
    (n) => n && console.log(`expired ${n} unanswered hold(s)`),
    (e) => console.error("expiring holds failed:", e),
  );
  guard.syncPayouts().catch((e) => console.error("syncing payouts failed:", e));
}, 60_000).unref();
