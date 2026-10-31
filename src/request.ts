import { z } from "zod";
import { CURRENCIES } from "./policy.js";

// What an agent sends when it wants to pay. Every field that a decision depends on is typed.
// `reason` is free text from the model: it is stored and shown to the approver, and nothing
// in the decision engine reads it. That is the main defence against prompt injection here.

export const PaymentRequestSchema = z
  .object({
    amount: z.number().int().positive(),
    currency: z.enum(CURRENCIES),
    recipient: z.string().min(1).max(100),
    reference: z.string().min(1).max(140),
    reason: z.string().max(1000).optional(),
  })
  .strict();

export type PaymentRequest = z.infer<typeof PaymentRequestSchema>;
