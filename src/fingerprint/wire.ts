// The pinned POST /fingerprint contract. Batch-capable so a 500-scan batch is a handful of round trips
// rather than 500. One response entry per input item, SAME ORDER, so callers zip by index.
//
// `model` is deliberately ABSENT from both directions. The backend keys on its own
// config.investigation.model — the value it already sends in the /investigate body — because it owns
// the model the run actually uses. Reporting one here would let the two drift and key a report on a
// model the run did not use. Do not add one.
import { z } from "zod";

/** Per-request item cap. A larger batch is a 400; callers chunk. */
export const MAX_FINGERPRINT_ITEMS = 100;

export const FingerprintItemSchema = z
  .object({
    address: z.string().min(1),
    zip: z.string().nullish().default(null),
  })
  .strict();
export type FingerprintItem = z.infer<typeof FingerprintItemSchema>;

export const FingerprintRequestSchema = z
  .object({
    items: z.array(FingerprintItemSchema).min(1).max(MAX_FINGERPRINT_ITEMS),
  })
  .strict();
export type FingerprintRequest = z.infer<typeof FingerprintRequestSchema>;

/** One entry per input item, same index. `data: null` is a per-item degradation, never an error. */
export interface FingerprintResponseItem {
  data: string | null;
}

export interface FingerprintResponse {
  engine: string;
  items: FingerprintResponseItem[];
}

export type FingerprintParseResult =
  | { ok: true; request: FingerprintRequest }
  | { ok: false; issues: string[] };

/** Same shape as parse_investigation_request: strict schema, zod paths on the 400. */
export function parse_fingerprint_request(raw: unknown): FingerprintParseResult {
  const result = FingerprintRequestSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, request: result.data };
  }
  const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  return { ok: false, issues };
}
