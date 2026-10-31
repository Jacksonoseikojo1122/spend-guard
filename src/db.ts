import { DatabaseSync } from "node:sqlite";
import pg from "pg";

// A very small database layer so the same SQL runs on SQLite (one box, local use) and on
// Postgres (production). SQL is written with $1, $2 placeholders. Money columns are BIGINT and
// come back as numbers here; Postgres returns them as strings, so they're converted on read.
//
// Every write that can affect a spending decision runs inside `tx`, which takes one lock for
// the whole database. That is deliberately simple: it makes the limit check and the insert
// happen as one step, so two parallel requests can't both fit under a limit that only has room
// for one, and it gives the audit log a single unbroken order. The cost is that decisions are
// made one at a time, which is fine for the volumes an agent fleet produces.

export type Row = Record<string, unknown>;
export type Query = (sql: string, params?: unknown[]) => Promise<Row[]>;

export interface Db {
  query: Query;
  tx<T>(fn: (q: Query) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL, revoked_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS policies (
    agent_id TEXT NOT NULL, version INTEGER NOT NULL, document TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, version))`,
  `CREATE TABLE IF NOT EXISTS payment_requests (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
    amount BIGINT NOT NULL, currency TEXT NOT NULL, recipient TEXT NOT NULL, reference TEXT NOT NULL, reason TEXT,
    status TEXT NOT NULL, decision TEXT NOT NULL, policy_version INTEGER,
    local_day TEXT NOT NULL, local_month TEXT NOT NULL, hold_expires_ms BIGINT,
    resolved_at TEXT, resolved_by TEXT,
    payout_id TEXT, payout_status TEXT, payout_failure TEXT, payout_attempts BIGINT NOT NULL DEFAULT 0, payout_updated_ms BIGINT,
    created_at TEXT NOT NULL, created_ms BIGINT NOT NULL,
    UNIQUE (agent_id, idempotency_key))`,
  `CREATE INDEX IF NOT EXISTS payment_requests_day ON payment_requests (agent_id, local_day)`,
  `CREATE INDEX IF NOT EXISTS payment_requests_month ON payment_requests (agent_id, local_month)`,
  `CREATE INDEX IF NOT EXISTS payment_requests_status ON payment_requests (status, hold_expires_ms)`,
  `CREATE INDEX IF NOT EXISTS payment_requests_payout ON payment_requests (payout_status, payout_updated_ms)`,
  `CREATE INDEX IF NOT EXISTS payment_requests_payout_id ON payment_requests (payout_id)`,
  `CREATE TABLE IF NOT EXISTS recipients (
    owner TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL, network TEXT NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY (owner, id))`,
  `CREATE TABLE IF NOT EXISTS approval_tokens (
    token_hash TEXT PRIMARY KEY, request_id TEXT NOT NULL, approver TEXT NOT NULL,
    expires_ms BIGINT NOT NULL, used_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    seq BIGINT PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, event TEXT NOT NULL, subject TEXT NOT NULL,
    data TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL)`,
];

const BIGINT_COLUMNS = new Set(["amount", "hold_expires_ms", "created_ms", "seq", "total", "n", "version", "policy_version", "expires_ms", "payout_attempts", "payout_updated_ms"]);
function normalise(rows: Row[]): Row[] {
  for (const r of rows) for (const k of Object.keys(r)) if (BIGINT_COLUMNS.has(k) && typeof r[k] === "string") r[k] = Number(r[k]);
  return rows;
}

export function sqliteDb(path = ":memory:"): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  for (const s of SCHEMA) db.exec(s);
  // node:sqlite is synchronous, but callers await between statements, so two async
  // transactions on this one connection could interleave. A promise chain runs them in turn.
  let chain: Promise<unknown> = Promise.resolve();
  const query: Query = async (sql, params = []) => {
    const stmt = db.prepare(sql.replace(/\$(\d+)/g, "?$1"));
    const args = params.map((p) => (p === undefined ? null : p)) as (string | number | null)[];
    return /^\s*(SELECT|WITH)/i.test(sql) || /RETURNING/i.test(sql) ? normalise(stmt.all(...args) as Row[]) : (stmt.run(...args), []);
  };
  return {
    query: (sql, params) => {
      const run = chain.then(() => query(sql, params));
      chain = run.catch(() => undefined);
      return run;
    },
    tx<T>(fn: (q: Query) => Promise<T>) {
      const run = chain.then(async () => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const out = await fn(query);
          db.exec("COMMIT");
          return out;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      });
      chain = run.catch(() => undefined);
      return run;
    },
    async close() {
      await chain;
      db.close();
    },
  };
}

export async function postgresDb(url: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const client = await pool.connect();
  try {
    // Two instances starting together shouldn't race on CREATE TABLE.
    await client.query("SELECT pg_advisory_lock(hashtext('spend-guard:migrate'))");
    for (const s of SCHEMA) await client.query(s);
    await client.query("SELECT pg_advisory_unlock(hashtext('spend-guard:migrate'))");
  } finally {
    client.release();
  }
  return {
    query: async (sql, params = []) => normalise((await pool.query(sql, params)).rows),
    async tx<T>(fn: (q: Query) => Promise<T>) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock(hashtext('spend-guard:decide'))");
        const out = await fn(async (sql, params = []) => normalise((await c.query(sql, params)).rows));
        await c.query("COMMIT");
        return out;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}
