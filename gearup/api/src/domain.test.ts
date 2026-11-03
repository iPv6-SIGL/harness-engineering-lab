import { describe, expect, test } from "bun:test";
import {
  APPROVAL_DAYS,
  CATALOG,
  canAsk,
  canDecide,
  checkApproval,
  checkRejection,
  DAY_MS,
  deadlines,
  euros,
  isOpen,
  next,
  REMINDER_DAYS,
  remainingCents,
  reminderDue,
  rolesFromGroups,
  type Status,
  supplierCanDeliver,
  TEAM_BUDGET_CENTS,
  validateAsk,
  workflowTimers,
} from "./domain";

const T0 = Date.UTC(2031, 0, 6, 9, 0, 0);

describe("the request's life", () => {
  test("waiting: approved, rejected or expired — nothing else", () => {
    expect(next("waiting", "approve")).toBe("approved");
    expect(next("waiting", "reject")).toBe("rejected");
    expect(next("waiting", "expire")).toBe("expired");
    expect(next("waiting", "order")).toBeNull();
    expect(next("waiting", "supplier-fail")).toBeNull();
  });
  test("approved: ordered, or cancelled when the supplier fails", () => {
    expect(next("approved", "order")).toBe("ordered");
    expect(next("approved", "supplier-fail")).toBe("cancelled");
    expect(next("approved", "expire")).toBeNull();
    expect(next("approved", "reject")).toBeNull();
  });
  test("no order after an expiry or a rejection; the ends are final", () => {
    for (const s of ["ordered", "rejected", "expired", "cancelled"] as Status[]) {
      for (const e of ["approve", "reject", "expire", "order", "supplier-fail"] as const) {
        expect(next(s, e)).toBeNull();
      }
    }
  });
  test("open while waiting or approved", () => {
    expect(isOpen("waiting")).toBe(true);
    expect(isOpen("approved")).toBe(true);
    for (const s of ["ordered", "rejected", "expired", "cancelled"] as Status[])
      expect(isOpen(s)).toBe(false);
  });
});

describe("3 days to answer, a reminder after 2", () => {
  test("the policy", () => {
    expect(DAY_MS).toBe(86_400_000);
    expect(APPROVAL_DAYS).toBe(3);
    expect(REMINDER_DAYS).toBe(2);
  });
  test("deadlines from the moment of the request", () => {
    expect(deadlines(T0)).toEqual({ remindAt: T0 + 2 * DAY_MS, expiresAt: T0 + 3 * DAY_MS });
  });
  test("the workflow waits 2 days, reminds, then waits 1 more day", () => {
    expect(workflowTimers()).toEqual({ remindAfterMs: 172_800_000, expireAfterMs: 86_400_000 });
  });
  test("the reminder shows once due, only while the request waits", () => {
    const at = T0 + 2 * DAY_MS;
    expect(reminderDue("waiting", at - 1, at)).toBe(false);
    expect(reminderDue("waiting", at, at)).toBe(true);
    expect(reminderDue("approved", at + 1, at)).toBe(false);
  });
});

describe("asking", () => {
  const catalog = CATALOG;
  test("an item of the catalog", () => {
    expect(CATALOG[4].sku).toBe("DOCK");
    expect(validateAsk({ itemSku: "DOCK" }, catalog, [])).toEqual({ item: CATALOG[4] });
  });
  test("an unknown item is refused with 422", () => {
    expect(validateAsk({ itemSku: "PONY" }, catalog, [])).toEqual({
      problem: { status: 422, code: "unknown-item", message: "pick an item of the catalog" },
    });
    expect(validateAsk({}, catalog, [])).toMatchObject({ problem: { status: 422 } });
  });
  test("a second open request for the same item is refused with 409", () => {
    expect(validateAsk({ itemSku: "DOCK" }, catalog, ["SCREEN-27", "DOCK"])).toEqual({
      problem: {
        status: 409,
        code: "already-open",
        message: "you already have an open request for USB-C dock",
      },
    });
    expect(validateAsk({ itemSku: "DOCK" }, catalog, ["SCREEN-27"])).toHaveProperty("item");
  });
});

describe("the team budget", () => {
  test("15,000 EUR a team", () => {
    expect(TEAM_BUDGET_CENTS).toBe(1_500_000);
  });
  test("charges take, refunds give back", () => {
    expect(remainingCents(10_000, [])).toBe(10_000);
    expect(
      remainingCents(10_000, [
        { kind: "charge", amountCents: 3_000 },
        { kind: "charge", amountCents: 2_000 },
        { kind: "refund", amountCents: 3_000 },
      ]),
    ).toBe(8_000);
  });
});

describe("approving", () => {
  const ok = {
    status: "waiting" as Status,
    nowMs: T0,
    expiresAtMs: T0 + 1,
    priceCents: 500,
    remainingCents: 500,
  };
  test("waiting, in time, within the budget (price equal to what is left)", () => {
    expect(checkApproval(ok)).toBeNull();
  });
  test("above the remaining budget: 409 over-budget, with both amounts", () => {
    expect(checkApproval({ ...ok, priceCents: 501 })).toEqual({
      status: 409,
      code: "over-budget",
      message: "the item costs 5.01 EUR, the team has 5.00 EUR left",
    });
  });
  test("at or past the expiry: 409 expired", () => {
    expect(checkApproval({ ...ok, nowMs: T0 + 1 })).toMatchObject({ status: 409, code: "expired" });
    expect(checkApproval({ ...ok, nowMs: T0 })).toBeNull();
  });
  test("not waiting any more: 409 not-waiting, whatever the budget", () => {
    expect(checkApproval({ ...ok, status: "rejected", priceCents: 1 })).toEqual({
      status: 409,
      code: "not-waiting",
      message: "the request is already rejected",
    });
  });
  test("rejecting: only a waiting request", () => {
    expect(checkRejection("waiting")).toBeNull();
    expect(checkRejection("ordered")).toEqual({
      status: 409,
      code: "not-waiting",
      message: "the request is already ordered",
    });
  });
});

describe("money, roles, supplier, catalog", () => {
  test("euros from cents", () => {
    expect(euros(145_000)).toBe("1450.00 EUR");
    expect(euros(5)).toBe("0.05 EUR");
    expect(euros(-1_234)).toBe("-12.34 EUR");
    expect(euros(0)).toBe("0.00 EUR");
  });
  test("employees and managers ask, only managers decide", () => {
    expect(canAsk(["employee"])).toBe(true);
    expect(canAsk(["manager"])).toBe(true);
    expect(canAsk(["visitor"])).toBe(false);
    expect(canDecide(["manager"])).toBe(true);
    expect(canDecide(["employee"])).toBe(false);
  });
  test("the simulated supplier delivers while it has stock", () => {
    expect(supplierCanDeliver(1)).toBe(true);
    expect(supplierCanDeliver(0)).toBe(false);
  });
  test("roles are the app's groups, stripped of their prefix", () => {
    expect(
      rolesFromGroups(
        ["built-in/gearup-manager", "built-in/other-employee", "built-in/gearup-employee"],
        "gearup",
      ),
    ).toEqual(["manager", "employee"]);
  });
  test("the seeded catalog", () => {
    expect(CATALOG.map((i) => [i.sku, i.priceCents, i.stock])).toEqual([
      ["LAPTOP-14", 145_000, 50],
      ["LAPTOP-16", 210_000, 40],
      ["LAPTOP-GAMER", 260_000, 0],
      ["SCREEN-27", 32_000, 200],
      ["DOCK", 18_000, 999],
      ["HEADSET", 12_000, 999],
      ["WORKSTATION", 1_690_000, 5],
    ]);
    // The workstation is above a whole year's budget: the over-budget scenario never depends on the run.
    expect(CATALOG.find((i) => i.sku === "WORKSTATION")!.priceCents).toBeGreaterThan(
      TEAM_BUDGET_CENTS,
    );
  });
});
