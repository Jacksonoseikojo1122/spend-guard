import { z } from "zod";

// A policy is the whole rulebook for one agent. Policies are stored as versioned JSON and
// never edited in place, so every decision can be explained with the exact version it used.
// Amounts are minor units (pesewas for GHS). Unknown fields are rejected: a typo in a limit
// name must fail loudly, not silently drop the limit.

export const CURRENCIES = ["GHS", "KES", "NGN", "UGX", "XOF"] as const;
export type Currency = (typeof CURRENCIES)[number];

const minor = z.number().int().positive();
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export type Day = (typeof DAYS)[number];

// "Mon-Sat 07:00-19:00" or "Mon-Fri 08:00-17:30". Same-day windows only; no overnight ranges.
const HOURS_RE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)-(Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]|24):([0-5]\d)$/;

export type HoursWindow = { days: Day[]; startMinute: number; endMinute: number };

export function parseHours(spec: string): HoursWindow | undefined {
  const m = HOURS_RE.exec(spec);
  if (!m) return undefined;
  const [, from, to, sh, sm, eh, em] = m as unknown as [string, Day, Day, string, string, string, string];
  const startMinute = Number(sh) * 60 + Number(sm);
  const endMinute = Number(eh) * 60 + Number(em);
  if (endMinute <= startMinute || endMinute > 24 * 60) return undefined;
  const a = DAYS.indexOf(from);
  const b = DAYS.indexOf(to);
  if (b < a) return undefined; // "Sat-Mon" wraps the week; write two policies' worth of clarity instead
  return { days: DAYS.slice(a, b + 1), startMinute, endMinute };
}

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const Outcome = z.enum(["hold", "deny"]);

export const PolicySchema = z
  .object({
    currency: z.enum(CURRENCIES),
    limits: z
      .object({
        per_payment_max: minor,
        per_day_max: minor,
        per_month_max: minor,
        payments_per_hour_max: z.number().int().positive(),
      })
      .strict(),
    recipients: z
      .object({
        mode: z.enum(["allow_list", "any"]),
        list: z.array(z.string().min(1).max(100)).max(500).default([]),
        new_recipient: Outcome.default("hold"),
      })
      .strict(),
    approval: z
      .object({
        hold_above: z.number().int().nonnegative(),
        approvers: z.array(z.string().min(3)).min(1).max(10),
        channel: z.enum(["dashboard", "sms", "whatsapp"]).default("dashboard"),
        expires_after_minutes: z.number().int().min(1).max(24 * 60).default(30),
      })
      .strict()
      .optional(),
    hours: z
      .object({
        timezone: z.string().refine(isTimeZone, "unknown IANA time zone"),
        allow: z.string().refine((s) => parseHours(s) !== undefined, 'expected a window like "Mon-Sat 07:00-19:00"'),
        outside: Outcome.default("hold"),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const l = p.limits;
    if (l.per_payment_max > l.per_day_max) ctx.addIssue({ code: "custom", path: ["limits", "per_payment_max"], message: "can't be above per_day_max" });
    if (l.per_day_max > l.per_month_max) ctx.addIssue({ code: "custom", path: ["limits", "per_day_max"], message: "can't be above per_month_max" });
    // A hold needs someone to approve it. Without approvers, any rule that says "hold" would
    // leave payments waiting forever, so those rules must say "deny" instead.
    const holds = (p.recipients.mode === "allow_list" && p.recipients.new_recipient === "hold") || p.hours?.outside === "hold";
    if (holds && !p.approval) ctx.addIssue({ code: "custom", path: ["approval"], message: "a rule holds payments, so approvers are required" });
  });

export type Policy = z.infer<typeof PolicySchema>;
