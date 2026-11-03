// workflows.ts — decision D2: one workflow per gear request. It WAITS (2 days,
// then the reminder, then 1 more day) for the manager's decision, survives any
// restart of the worker while it waits (the history is Temporal's), orders from
// the supplier with retries, and COMPENSATES a supplier failure with a refund.
// Deterministic: no I/O, no clock — every effect is an activity.
import { condition, defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";
import type { Activities } from "./activities";
import { afterExpiry, type Decision, type GearRequestInput } from "./flow";

export const decisionSignal = defineSignal<[Decision]>("decision");

const steps = proxyActivities<Activities>({ startToCloseTimeout: "30 seconds" });
// The supplier is retried three times, one second apart, before the order is given up.
const supplier = proxyActivities<Activities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3, initialInterval: "1 second", backoffCoefficient: 1 },
});

export async function gearRequest(input: GearRequestInput): Promise<string> {
  let approved: boolean | undefined;
  setHandler(decisionSignal, (d) => {
    approved = d.approved;
  });
  const answered = () => approved !== undefined;
  if (!(await condition(answered, input.remindAfterMs))) {
    await steps.remind(input.requestId);
    if (!(await condition(answered, input.expireAfterMs))) {
      const next = afterExpiry(await steps.expire(input.requestId));
      if (next === "stop") return "expired";
      approved = next === "order";
    }
  }
  if (!approved) return "rejected";
  try {
    await supplier.order(input.requestId);
    return "ordered";
  } catch {
    await steps.refund(input.requestId); // compensation: idempotent, retried until it lands
    return "cancelled";
  }
}
