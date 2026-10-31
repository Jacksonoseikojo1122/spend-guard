import type { Usage } from "./decide.js";
import { formatMoney } from "./notify.js";
import type { Policy } from "./policy.js";
import type { PaymentRequestView } from "./service.js";

// The page an approver sees from their SMS or WhatsApp link. Plain HTML, no scripts, readable
// on a cheap phone. Everything shown that came from the agent is escaped, and the agent's note
// is labelled as the agent's own words, because it is exactly where an injected instruction
// would try to talk the approver into something.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `body{font-family:system-ui,sans-serif;max-width:30rem;margin:0 auto;padding:1rem;color:#1a1a1a;background:#fafafa}
h1{font-size:1.2rem}.amount{font-size:2rem;font-weight:700;margin:.5rem 0}dl{display:grid;grid-template-columns:auto 1fr;gap:.4rem .8rem}
dt{color:#666}dd{margin:0;word-break:break-word}.note{background:#fff7e0;border:1px solid #e8d18a;padding:.6rem;border-radius:6px}
.note b{display:block;font-size:.85rem;color:#7a5d00}.why{background:#eef3ff;padding:.6rem;border-radius:6px}
form{display:flex;gap:.8rem;margin-top:1.2rem}button{flex:1;font-size:1.1rem;padding:.9rem;border:0;border-radius:8px;cursor:pointer}
.approve{background:#137333;color:#fff}.reject{background:#b3261e;color:#fff}.done{padding:1rem;background:#eee;border-radius:8px}`;

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;

export function approvalPage(o: { request: PaymentRequestView; agent_name: string; usage: Usage; limits?: Policy["limits"]; usable: boolean; token: string }): string {
  const r = o.request;
  const money = (n: number) => esc(formatMoney(n, r.currency));
  const rows: [string, string][] = [
    ["Agent", esc(o.agent_name)],
    ["To", esc(r.recipient)],
    ["Reference", esc(r.reference)],
    ["Spent today", o.limits ? `${money(o.usage.day)} of ${money(o.limits.per_day_max)}` : money(o.usage.day)],
    ["Expires", r.approval ? esc(new Date(r.approval.expires_at).toUTCString()) : "-"],
  ];
  const note = r.reason ? `<div class="note"><b>The agent's own note (not checked):</b>${esc(r.reason)}</div>` : "";
  const action = o.usable
    ? `<form method="post"><button class="approve" name="action" value="approve">Approve</button><button class="reject" name="action" value="reject">Reject</button></form>`
    : `<p class="done">This request is <b>${esc(r.status)}</b>${r.resolved ? ` (${esc(r.resolved.by)})` : ""}. Nothing more to do.</p>`;
  return page(
    "Approve payment?",
    `<h1>Approve this payment?</h1><div class="amount">${money(r.amount)}</div>` +
      `<p class="why">${esc(r.decision.message)}</p>` +
      `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>${note}${action}`,
  );
}

export function resultPage(request: PaymentRequestView): string {
  const verb = request.status === "approved" ? "approved" : request.status === "rejected" ? "rejected" : request.status;
  return page("Done", `<h1>Payment ${esc(verb)}</h1><p class="done">${esc(formatMoney(request.amount, request.currency))} to ${esc(request.recipient)} is now <b>${esc(verb)}</b>.</p>`);
}

export function messagePage(title: string, message: string): string {
  return page(title, `<h1>${esc(title)}</h1><p class="done">${esc(message)}</p>`);
}
