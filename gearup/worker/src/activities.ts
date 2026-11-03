// activities.ts — every effect of the workflow, each one idempotent: a retried
// or replayed activity changes nothing the second time. The rows' constraints
// (one charge and one refund per request) back that up.
import { ApplicationFailure } from "@temporalio/common";
import type { SQL } from "bun";

export function activities(sql: SQL) {
  return {
    /** Day 2: the reminder shows in the manager's list (no e-mail: out of scope). */
    async remind(requestId: number): Promise<void> {
      await sql`UPDATE requests SET reminded_at = coalesce(reminded_at, now())
                WHERE id = ${requestId} AND status = 'waiting'`;
    },

    /** Day 3: expires a request nobody answered; returns the status either way. */
    async expire(requestId: number): Promise<string> {
      await sql`UPDATE requests SET status = 'expired', closed_at = now()
                WHERE id = ${requestId} AND status = 'waiting'`;
      const [r] = await sql`SELECT status FROM requests WHERE id = ${requestId}`;
      return r.status;
    },

    /** The simulated supplier: delivers while it has stock, fails otherwise (retryable). */
    async order(requestId: number): Promise<void> {
      const outcome = await sql.begin(async (tx) => {
        const [r] =
          await tx`SELECT status, item_sku FROM requests WHERE id = ${requestId} FOR UPDATE`;
        if (r.status !== "approved") return r.status; // already ordered: a retry after success
        const [taken] = await tx`UPDATE items SET supplier_stock = supplier_stock - 1
                                 WHERE sku = ${r.item_sku} AND supplier_stock > 0 RETURNING sku`;
        if (!taken) return "out-of-stock";
        await tx`INSERT INTO supplier_calls (request_id, ok) VALUES (${requestId}, true)`;
        await tx`UPDATE requests SET status = 'ordered', closed_at = now() WHERE id = ${requestId}`;
        return "ordered";
      });
      if (outcome === "out-of-stock") {
        await sql`INSERT INTO supplier_calls (request_id, ok) VALUES (${requestId}, false)`;
        throw ApplicationFailure.retryable(
          "the supplier cannot deliver this item",
          "SupplierFailure",
        );
      }
    },

    /** The compensation: the charge is refunded once, the request ends as cancelled. */
    async refund(requestId: number): Promise<void> {
      await sql.begin(async (tx) => {
        await tx`INSERT INTO budget_moves (request_id, kind, amount_cents)
                 SELECT request_id, 'refund', amount_cents FROM budget_moves
                 WHERE request_id = ${requestId} AND kind = 'charge'
                 ON CONFLICT (request_id, kind) DO NOTHING`;
        await tx`UPDATE requests SET status = 'cancelled', closed_at = now()
                 WHERE id = ${requestId} AND status = 'approved'`;
      });
    },
  };
}

export type Activities = ReturnType<typeof activities>;
