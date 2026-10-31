import { createHmac, timingSafeEqual } from "node:crypto";

// The connection to MoMo One-API, which routes payouts to licensed providers (Paystack, MTN MoMo)
// and never holds funds itself. Spend Guard only ever asks it for payouts, using the payment
// request id as the Idempotency-Key, so sending the same payout twice returns the first one.

export const NETWORKS = ["mtn", "telecel", "airteltigo", "mpesa"] as const;
export type Network = (typeof NETWORKS)[number];

/** MoMo One-API's statuses. succeeded is final unless the provider later sends it back (reversed). */
export type PayoutStatus = "pending" | "action_required" | "succeeded" | "failed" | "reversed";

export type Payout = { id: string; status: PayoutStatus; failure: { code: string; message: string } | null };

export type PayoutInput = {
  idempotencyKey: string;
  amount: number;
  currency: string;
  phone: string;
  network: Network;
  name: string;
  description: string;
  metadata: Record<string, string>;
};

export interface PayoutClient {
  createPayout(input: PayoutInput): Promise<Payout>;
  getPayout(id: string): Promise<Payout>;
}

/** MoMo One-API answered, but refused the payout (bad input, no provider for that network). */
export class PayoutRefused extends Error {}

export function momoClient(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): PayoutClient {
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
  const read = async (res: Response): Promise<Payout> => {
    const body = (await res.json().catch(() => ({}))) as { id?: string; status?: PayoutStatus; failure?: Payout["failure"]; error?: string };
    // 4xx means MoMo One-API looked at the request and said no; nothing was started.
    if (res.status >= 400 && res.status < 500) throw new PayoutRefused(`MoMo One-API refused the payout (${res.status}): ${body.error ?? "no reason given"}`);
    if (!res.ok || !body.id || !body.status) throw new Error(`MoMo One-API answered ${res.status}`);
    return { id: body.id, status: body.status, failure: body.failure ?? null };
  };
  return {
    async createPayout(p) {
      const res = await fetchImpl(`${base}/v1/payouts`, {
        method: "POST",
        headers: { ...headers, "idempotency-key": p.idempotencyKey },
        body: JSON.stringify({
          amount: p.amount, currency: p.currency, phone: p.phone, network: p.network,
          customer: { name: p.name }, description: p.description.slice(0, 100), metadata: p.metadata,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return read(res);
    },
    async getPayout(id) {
      return read(await fetchImpl(`${base}/v1/payments/${encodeURIComponent(id)}`, { headers, signal: AbortSignal.timeout(timeoutMs) }));
    },
  };
}

/** MoMo One-API signs webhooks as `X-Signature: sha256=<hex HMAC-SHA256 of the raw body>`. */
export function validMomoSignature(rawBody: string, header: string | undefined, secret: string): boolean {
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const got = Buffer.from(header ?? "");
  return got.length === want.length && timingSafeEqual(got, want);
}

const RANK: Record<PayoutStatus, number> = { pending: 0, action_required: 0, succeeded: 1, failed: 1, reversed: 2 };

/**
 * Only move forward: a late "pending" can't undo "succeeded", and only a succeeded payout can be
 * reversed. MoMo One-API enforces the same rules; this keeps our copy from going backwards if
 * answers arrive out of order.
 */
export function canMoveTo(from: PayoutStatus | "queued", to: PayoutStatus): boolean {
  if (from === "queued") return true;
  if (to === "reversed") return from === "succeeded";
  return RANK[to] > RANK[from] || (RANK[to] === 0 && RANK[from] === 0 && to !== from);
}
