import { z } from "zod";
import {
  SHARE_REPORT_DETAIL_MAX,
  SHARE_REPORT_REASONS,
  SHARE_TOKEN_PATTERN,
  type ShareReportReason,
} from "@/lib/share-policy";

/** Request bodies for the share report and takedown routes. Server-side; the rules are in share-policy.ts. */

const REASON_IDS = SHARE_REPORT_REASONS.map((r) => r.id) as [ShareReportReason, ...ShareReportReason[]];

/** What the Report form sends. The contact address is optional. */
export const shareReportSchema = z.object({
  token: z.string().regex(SHARE_TOKEN_PATTERN),
  reason: z.enum(REASON_IDS),
  detail: z.string().trim().max(SHARE_REPORT_DETAIL_MAX).default(""),
  contact: z
    .string()
    .trim()
    .max(320)
    .optional()
    .transform((v) => (v ? v : undefined))
    .pipe(z.string().email().optional()),
});

export type ShareReportInput = z.infer<typeof shareReportSchema>;

/** A takedown the admin cannot justify in a sentence is not one to make. */
export const shareTakedownSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  banOwner: z.boolean().optional().default(false),
});
