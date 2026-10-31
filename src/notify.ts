import { createHmac } from "node:crypto";

// How approvers hear about a held payment. Notifications are sent after the decision is saved,
// never inside the lock, and a failed send never undoes a hold: the owner can still approve
// through the API. Built in: print to the console, or POST a signed JSON webhook that you
// connect to any SMS or WhatsApp sender.

export type ApprovalNotice = {
  approver: string;
  channel: "dashboard" | "sms" | "whatsapp";
  /** Short plain text, fits in one or two SMS messages. */
  message: string;
  url: string;
  request: { id: string; agent_name: string; amount: number; currency: string; recipient: string; reference: string; expires_at: string };
};

export interface Notifier {
  send(notice: ApprovalNotice): Promise<void>;
}

export const consoleNotifier: Notifier = {
  async send(n) {
    console.log(`[approval] to ${n.approver} via ${n.channel}: ${n.message}`);
  },
};

/** Signs the body as `X-SpendGuard-Signature: sha256=<hex HMAC>`, the format Webhook Relay checks. */
export function webhookNotifier(url: string, secret: string, timeoutMs = 5000): Notifier {
  return {
    async send(n) {
      const body = JSON.stringify({ type: "approval.requested", ...n });
      const signature = createHmac("sha256", secret).update(body).digest("hex");
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-spendguard-signature": `sha256=${signature}` },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`approval webhook answered ${res.status}`);
    },
  };
}

export function formatMoney(minor: number, currency: string): string {
  return `${currency} ${(minor / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
