// flow.ts — the workflow's one decision that is not a wait: what the status read
// from Postgres means when the 3 days are over. Pure, so the workflow stays
// deterministic and the rule is tested on its own.

/**
 * After the expiry timer fired, the `expire` activity returns the request's status:
 * `expired` (nobody answered: stop), or a decision whose signal never arrived.
 */
export function afterExpiry(status: string): "stop" | "order" | "closed" {
  if (status === "approved") return "order";
  if (status === "expired") return "stop";
  return "closed"; // rejected, or already past ordering
}

export type GearRequestInput = { requestId: number; remindAfterMs: number; expireAfterMs: number };
export type Decision = { approved: boolean };
