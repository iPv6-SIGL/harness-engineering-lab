// domain.ts — GearUp's business rules, pure: no I/O, no clock, no framework.
// One module on purpose (doctrine D-PURE): it is what the harness mutates to
// prove the tests can fail. The API decides here what may happen to a request;
// the Temporal workflow (decision D2) carries the waits and the compensation.

export const DAY_MS = 86_400_000;
/** The manager has 3 days to answer; a reminder shows after 2 (brief, R1). */
export const APPROVAL_DAYS = 3;
export const REMINDER_DAYS = 2;

export type Status = "waiting" | "approved" | "ordered" | "rejected" | "expired" | "cancelled";
export type Event = "approve" | "reject" | "expire" | "order" | "supplier-fail";

// The only moves a request can make. Everything else is refused, whoever asks.
const NEXT: Record<Status, Partial<Record<Event, Status>>> = {
  waiting: { approve: "approved", reject: "rejected", expire: "expired" },
  approved: { order: "ordered", "supplier-fail": "cancelled" },
  ordered: {},
  rejected: {},
  expired: {},
  cancelled: {},
};

export function next(status: Status, event: Event): Status | null {
  return NEXT[status][event] ?? null;
}

/** Open = the item may still be ordered for that person: a second request for it is refused. */
export const isOpen = (s: Status) => s === "waiting" || s === "approved";

export function deadlines(createdAtMs: number): { remindAt: number; expiresAt: number } {
  return {
    remindAt: createdAtMs + REMINDER_DAYS * DAY_MS,
    expiresAt: createdAtMs + APPROVAL_DAYS * DAY_MS,
  };
}

/** The two durable timers of the workflow: until the reminder, then from the reminder to the expiry. */
export function workflowTimers(): { remindAfterMs: number; expireAfterMs: number } {
  return {
    remindAfterMs: REMINDER_DAYS * DAY_MS,
    expireAfterMs: (APPROVAL_DAYS - REMINDER_DAYS) * DAY_MS,
  };
}

/** The reminder shows in the manager's list once it is due, while the request still waits. */
export function reminderDue(status: Status, nowMs: number, remindAtMs: number): boolean {
  return status === "waiting" && nowMs >= remindAtMs;
}

export type Item = { sku: string; name: string; priceCents: number };
export type Problem = { status: number; code: string; message: string };

export function validateAsk(
  body: { itemSku?: unknown },
  catalog: Item[],
  openSkus: string[],
): { item: Item } | { problem: Problem } {
  const item = catalog.find((i) => i.sku === body.itemSku);
  if (!item)
    return {
      problem: { status: 422, code: "unknown-item", message: "pick an item of the catalog" },
    };
  if (openSkus.includes(item.sku))
    return {
      problem: {
        status: 409,
        code: "already-open",
        message: `you already have an open request for ${item.name}`,
      },
    };
  return { item };
}

export type Move = { kind: "charge" | "refund"; amountCents: number };

export function remainingCents(budgetCents: number, moves: Move[]): number {
  let left = budgetCents;
  for (const m of moves) left += m.kind === "refund" ? m.amountCents : -m.amountCents;
  return left;
}

/** Whether the manager may approve now: waiting, not past its expiry, and within the team budget. */
export function checkApproval(r: {
  status: Status;
  nowMs: number;
  expiresAtMs: number;
  priceCents: number;
  remainingCents: number;
}): Problem | null {
  if (r.status !== "waiting")
    return { status: 409, code: "not-waiting", message: `the request is already ${r.status}` };
  if (r.nowMs >= r.expiresAtMs)
    return { status: 409, code: "expired", message: "the 3 days to answer are over" };
  if (r.priceCents > r.remainingCents)
    return {
      status: 409,
      code: "over-budget",
      message: `the item costs ${euros(r.priceCents)}, the team has ${euros(r.remainingCents)} left`,
    };
  return null;
}

export function checkRejection(status: Status): Problem | null {
  return status === "waiting"
    ? null
    : { status: 409, code: "not-waiting", message: `the request is already ${status}` };
}

export function euros(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")} EUR`;
}

/** Who may do what. A manager also asks like an employee (brief, personas). */
export const canAsk = (roles: string[]) => roles.includes("employee") || roles.includes("manager");
export const canDecide = (roles: string[]) => roles.includes("manager");

/** The supplier is simulated by a stock list (out of scope: a real supplier API). */
export const supplierCanDeliver = (stock: number) => stock > 0;

export function rolesFromGroups(groups: string[], app: string): string[] {
  const prefix = `built-in/${app}-`;
  return groups.filter((g) => g.startsWith(prefix)).map((g) => g.slice(prefix.length));
}

/** The seeded catalog: about 20 items in the brief; the ones the scenarios need, priced. */
export const CATALOG: (Item & { stock: number })[] = [
  { sku: "LAPTOP-14", name: "Laptop 14 inch", priceCents: 145_000, stock: 50 },
  { sku: "LAPTOP-16", name: "Laptop 16 inch", priceCents: 210_000, stock: 40 },
  {
    sku: "LAPTOP-GAMER",
    name: "Gaming laptop (supplier out of stock)",
    priceCents: 260_000,
    stock: 0,
  },
  { sku: "SCREEN-27", name: "Screen 27 inch", priceCents: 32_000, stock: 200 },
  { sku: "DOCK", name: "USB-C dock", priceCents: 18_000, stock: 999 },
  { sku: "HEADSET", name: "Headset", priceCents: 12_000, stock: 999 },
  { sku: "WORKSTATION", name: "GPU workstation", priceCents: 1_690_000, stock: 5 },
];
/** One team budget a year, about 15,000 EUR (brief, data). */
export const TEAM_BUDGET_CENTS = 1_500_000;
