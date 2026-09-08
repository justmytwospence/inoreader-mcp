import * as z from "zod/v4";
import type { FolderWriteReport } from "./verify.js";

/**
 * The shape every bulk write reports, and the invariant that keeps it honest.
 *
 * The bug this guards against: counters derived from the INPUT rather than from
 * observed results. `by_folder` used to be built by iterating the requested
 * assignments, so a call that applied nothing still reported the full count, and
 * `succeeded` counted HTTP 2xx responses rather than applied changes.
 *
 * The `.refine` below is deliberately a runtime check rather than a comment. Every
 * bulk result is parsed through it before serialization, so a future refactor that
 * reintroduces optimistic counting fails loudly in the tool's own output path
 * instead of shipping another confident wrong number.
 */
export const BulkWriteResultSchema = z
  .object({
    intended: z.number().int().nonnegative(),
    verified: z.number().int().nonnegative(),
    unverified: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    not_attempted: z.number().int().nonnegative(),
    verification: z.enum(["read-back", "none"]),
    rounds: z.number().int().nonnegative(),
  })
  .loose()
  .superRefine((r, ctx) => {
    const sum = r.verified + r.unverified + r.failed + r.not_attempted;
    if (sum === r.intended) return;
    ctx.addIssue({
      code: "custom",
      message:
        `bulk write counts do not reconcile: verified(${r.verified}) + ` +
        `unverified(${r.unverified}) + failed(${r.failed}) + ` +
        `not_attempted(${r.not_attempted}) = ${sum}, but intended is ${r.intended}. ` +
        `Counts must be derived from observed results, never from the input.`,
    });
  });

/**
 * Render a verified folder-write report as an MCP tool result.
 *
 * `isError` is set whenever fewer changes were confirmed than requested. That flag
 * is the point: a model reading `{"succeeded":42,"failed":0}` moves on, whereas one
 * handed an error plus the list of what did not land cannot.
 */
export function renderFolderWriteResult(
  report: FolderWriteReport,
  extra: Record<string, unknown> = {}
) {
  const notApplied = report.items.filter((i) => i.status !== "verified");

  const payload = {
    ...extra,
    intended: report.intended,
    verified: report.verified,
    unverified: report.unverified,
    failed: report.failed,
    not_attempted: report.not_attempted,
    by_folder: report.by_folder,
    verification: report.verification,
    rounds: report.rounds,
    ...(report.verify_error
      ? {
          warning:
            `Writes were sent but could NOT be verified (${report.verify_error}). ` +
            `Counts above reflect request outcomes only and may overstate what was ` +
            `applied. Re-check with list_subscriptions.`,
        }
      : {}),
    ...(notApplied.length > 0 ? { not_applied: notApplied } : {}),
  };

  BulkWriteResultSchema.parse(payload);

  return {
    isError: report.verified < report.intended,
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}
