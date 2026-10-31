import { parseHours, type Day, type Policy } from "./policy.js";
import type { PaymentRequest } from "./request.js";

// The decision engine. It is a pure function: everything it needs is passed in, so the same
// input always gives the same decision, and tests don't need a database or a clock.
// The checks run in a fixed, documented order and the first one that fails decides. Each
// decision names the rule that made it, with the numbers, so a person can see exactly why.

export type Usage = {
  /** Allowed plus unexpired held amounts today, in the policy's time zone (minor units). */
  day: number;
  /** Allowed plus held amounts this calendar month, in the policy's time zone. */
  month: number;
  /** Allowed plus held payment requests in the last 60 minutes. */
  lastHourCount: number;
};

export type DecisionInput = {
  policy: Policy | undefined;
  request: PaymentRequest;
  usage: Usage;
  now: Date;
};

export type Rule =
  | "no_policy"
  | "currency"
  | "per_payment_max"
  | "per_day_max"
  | "per_month_max"
  | "payments_per_hour_max"
  | "new_recipient"
  | "outside_hours"
  | "hold_above"
  | "within_policy";

export type Decision = {
  result: "allow" | "hold" | "deny";
  rule: Rule;
  /** Human-readable reason, safe to show to the agent and to the approver. */
  message: string;
  detail?: Record<string, string | number>;
};

const deny = (rule: Rule, message: string, detail?: Decision["detail"]): Decision => ({ result: "deny", rule, message, detail });

export function decide({ policy, request, usage, now }: DecisionInput): Decision {
  // 1. Deny by default: an agent with no policy can't spend anything.
  if (!policy) return deny("no_policy", "This agent has no spending policy.");

  // 2. Currency. Limits are written in one currency; comparing across currencies is meaningless.
  if (request.currency !== policy.currency)
    return deny("currency", `This agent can only pay in ${policy.currency}.`, { requested: request.currency, allowed: policy.currency });

  const { limits } = policy;
  const amount = request.amount;

  // 3. Single payment size.
  if (amount > limits.per_payment_max)
    return deny("per_payment_max", "This payment is above the agent's limit for a single payment.", { amount, limit: limits.per_payment_max });

  // 4 and 5. Rolling totals. Held payments count too, otherwise an agent could pile up holds
  // that are each fine on their own and blow the limit once they're all approved.
  if (usage.day + amount > limits.per_day_max)
    return deny("per_day_max", "This payment would take the agent over its daily limit.", { amount, used: usage.day, limit: limits.per_day_max });
  if (usage.month + amount > limits.per_month_max)
    return deny("per_month_max", "This payment would take the agent over its monthly limit.", { amount, used: usage.month, limit: limits.per_month_max });

  // 6. Rate. Stops a runaway loop even when each payment is small.
  if (usage.lastHourCount + 1 > limits.payments_per_hour_max)
    return deny("payments_per_hour_max", "The agent has made too many payment requests in the last hour.", { count: usage.lastHourCount, limit: limits.payments_per_hour_max });

  // From here on a rule can hold instead of deny. All of them are checked, and the first hold
  // is reported, but a deny from a later rule still wins over an earlier hold.
  const holds: Decision[] = [];
  const outcome = (o: "hold" | "deny", rule: Rule, message: string, detail?: Decision["detail"]): Decision | undefined => {
    const d: Decision = { result: o, rule, message, detail };
    if (o === "deny") return d;
    holds.push(d);
    return undefined;
  };

  // 7. Recipient.
  const { recipients } = policy;
  if (recipients.mode === "allow_list" && !recipients.list.includes(request.recipient)) {
    const d = outcome(recipients.new_recipient, "new_recipient", "This recipient isn't on the agent's approved list.", { recipient: request.recipient });
    if (d) return d;
  }

  // 8. Time window.
  if (policy.hours) {
    const window = parseHours(policy.hours.allow)!; // validated when the policy was saved
    const local = localTime(now, policy.timezone);
    const inside = window.days.includes(local.day) && local.minute >= window.startMinute && local.minute < window.endMinute;
    if (!inside) {
      const d = outcome(policy.hours.outside, "outside_hours", `Payments are only automatic during ${policy.hours.allow} (${policy.timezone}).`, {
        local_time: `${local.day} ${hhmm(local.minute)}`,
      });
      if (d) return d;
    }
  }

  // 9. Size that needs a person.
  if (policy.approval && amount > policy.approval.hold_above)
    holds.push({ result: "hold", rule: "hold_above", message: "Payments of this size need a person to approve them.", detail: { amount, threshold: policy.approval.hold_above } });

  if (holds.length) return holds[0]!;

  // 10. Everything passed.
  return { result: "allow", rule: "within_policy", message: "Within the agent's policy." };
}

const WEEKDAY: Record<string, Day> = { Mon: "Mon", Tue: "Tue", Wed: "Wed", Thu: "Thu", Fri: "Fri", Sat: "Sat", Sun: "Sun" };

export function localTime(now: Date, timeZone: string): { day: Day; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: WEEKDAY[get("weekday")]!, minute: Number(get("hour")) * 60 + Number(get("minute")) };
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
