import { createHash } from "node:crypto";
import type { Query } from "./db.js";

// An append-only log where each entry carries the hash of the one before it. If anyone edits
// or deletes a past entry directly in the database, every hash after it stops matching, and
// `verifyAudit` reports the first entry that no longer fits. It doesn't stop a database admin
// from rewriting the whole chain; for that, publish the latest hash somewhere else from time
// to time (the /v1/audit/verify response includes it).

export type AuditEntry = { actor: string; event: string; subject: string; data: Record<string, unknown> };

const GENESIS = "0".repeat(64);

/** Stable JSON: object keys sorted, so the same data always hashes the same way. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

const hashOf = (prev: string, seq: number, at: string, e: AuditEntry) =>
  createHash("sha256").update(canonical({ prev, seq, at, actor: e.actor, event: e.event, subject: e.subject, data: e.data })).digest("hex");

/** Call only inside Db.tx, which holds the lock that keeps the chain in one order. */
export async function appendAudit(q: Query, at: string, e: AuditEntry): Promise<void> {
  const [last] = await q("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1");
  const seq = last ? Number(last.seq) + 1 : 1;
  const prev = last ? String(last.hash) : GENESIS;
  await q("INSERT INTO audit_log (seq, at, actor, event, subject, data, prev_hash, hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [
    seq, at, e.actor, e.event, e.subject, canonical(e.data), prev, hashOf(prev, seq, at, e),
  ]);
}

export type AuditCheck = { ok: true; entries: number; head: string } | { ok: false; entries: number; broken_at: number };

export async function verifyAudit(q: Query): Promise<AuditCheck> {
  const rows = await q("SELECT seq, at, actor, event, subject, data, prev_hash, hash FROM audit_log ORDER BY seq");
  let prev = GENESIS;
  let expectSeq = 1;
  for (const r of rows) {
    const seq = Number(r.seq);
    const entry: AuditEntry = { actor: String(r.actor), event: String(r.event), subject: String(r.subject), data: JSON.parse(String(r.data)) };
    if (seq !== expectSeq || r.prev_hash !== prev || r.hash !== hashOf(prev, seq, String(r.at), entry)) return { ok: false, entries: rows.length, broken_at: expectSeq };
    prev = String(r.hash);
    expectSeq++;
  }
  return { ok: true, entries: rows.length, head: prev };
}
