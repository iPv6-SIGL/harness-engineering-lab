// e2e/scenarios.test.ts — one test per spec scenario, named "<R-id> <scenario-id>"
// exactly as in openspec/changes/add-gearup/specs/gearup/spec.md: the harness
// runs them by name to flip the ledger (`harness verify-task`). Against the
// deployed stack — API, Temporal worker, the app's namespace — as the seeded
// personas. No mocks.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { API, APP, BASE, call, history, login, restart, type Session, waitStatus } from "./lib";

let emp: Session;
let mgr: Session;
const DAY = 86_400_000;

beforeAll(async () => {
  emp = await login("employee");
  mgr = await login("manager");
});

// Reruns start clean: whatever a scenario left waiting is rejected (the workflows end).
afterAll(async () => {
  const mine = await call(emp, "GET", "/api/v1/requests");
  for (const r of mine.body?.requests ?? []) {
    if (r.status === "waiting")
      await call(mgr, "POST", `/api/v1/requests/${r.id}/decision`, { approve: false });
  }
});

const ask = async (itemSku: string, s = emp) => call(s, "POST", "/api/v1/requests", { itemSku });
const decide = (id: number, approve: boolean, s = mgr) =>
  call(s, "POST", `/api/v1/requests/${id}/decision`, { approve });
const remaining = async () =>
  (await call(mgr, "GET", "/api/v1/catalog")).body.budget.remainingCents as number;

describe("contracts", () => {
  test("C1 health", async () => {
    expect((await fetch(`${API}/health`)).status).toBe(200);
  });
  test("C1 ready", async () => {
    const r = await fetch(`${API}/ready`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "ready" });
  });
  test("C1 frontend", async () => {
    const r = await fetch(`${BASE}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(await r.text()).toContain("GearUp");
  });
  test("C1 oidc", async () => {
    const r = await fetch(`${BASE}/auth/login`, { redirect: "manual" });
    expect(r.status).toBe(302);
    const to = new URL(r.headers.get("location") ?? "");
    expect(to.origin).toBe("http://localhost:9300");
    expect(to.searchParams.get("redirect_uri")).toBe(`${BASE}/auth/callback`);
  });
  test("C1 stateless", async () => {
    // A brand-new API process (what a second replica is) must serve an existing session.
    const s = await login("employee");
    expect((await call(s, "GET", "/api/v1/me")).status).toBe(200);
    expect(Bun.spawnSync(["podman", "restart", "-t", "10", `${APP}-api`]).exitCode).toBe(0);
    let me = await call(s, "GET", "/api/v1/me");
    for (let i = 0; i < 40 && me.status >= 500; i++) {
      await Bun.sleep(500);
      me = await call(s, "GET", "/api/v1/me");
    }
    expect(me.status).toBe(200);
    expect(me.body.user.name).toBe(`${APP}-test-employee`);
  });
});

describe("R1 · the manager has 3 days, a reminder after 2", () => {
  test("R1 ask-waits", async () => {
    const r = await ask("LAPTOP-14");
    expect(r.status).toBe(201);
    const q = r.body.request;
    expect(q.status).toBe("waiting");
    const created = Date.parse(q.createdAt);
    expect(Date.parse(q.remindAt) - created).toBe(2 * DAY);
    expect(Date.parse(q.expiresAt) - created).toBe(3 * DAY);
    // The wait is a durable timer in Temporal, not a status column polled by a cron:
    // the workflow is running and its history holds the 2-day timer.
    let h = "";
    for (let i = 0; i < 30 && !h.includes("172800s"); i++) {
      await Bun.sleep(300);
      h = history(q.workflowId);
    }
    expect(h).toContain("EVENT_TYPE_TIMER_STARTED");
    expect(h).toContain("172800s");
    const one = await call(emp, "GET", `/api/v1/requests/${q.id}`);
    expect(one.body.workflow.status).toBe("RUNNING");
    expect(one.body.moves).toEqual([]); // nothing charged while it waits
  });

  test("R1 survives-restart", async () => {
    const r = await ask("DOCK");
    expect(r.status).toBe(201);
    const id = r.body.request.id;
    await restart(`${APP}-worker`, `http://localhost:8038/ready`);
    const d = await decide(id, true);
    expect(d.status).toBe(202);
    const done = await waitStatus(emp, id, (s) => s === "ordered", 25_000);
    expect(done.body.request.status).toBe("ordered");
    expect(done.body.workflow.status).toBe("COMPLETED");
  }, 60_000);

  test("R1 one-open-per-item", async () => {
    const first = await ask("SCREEN-27");
    expect(first.status).toBe(201);
    const second = await ask("SCREEN-27");
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("already-open");
  });
});

describe("R2 · the manager decides, within the team budget", () => {
  test("R2 approve-orders", async () => {
    const before = await remaining();
    const r = await ask("HEADSET");
    expect(r.status).toBe(201);
    const d = await decide(r.body.request.id, true);
    expect(d.status).toBe(202);
    expect(d.body.budget.remainingCents).toBe(before - 12_000);
    const done = await waitStatus(emp, r.body.request.id, (s) => s === "ordered");
    expect(done.body.request.status).toBe("ordered");
    expect(
      done.body.moves.map((m: { kind: string; amountCents: number }) => [m.kind, m.amountCents]),
    ).toEqual([["charge", 12_000]]);
    expect(await remaining()).toBe(before - 12_000);
  }, 30_000);

  test("R2 reject-closes", async () => {
    const before = await remaining();
    const r = await ask("LAPTOP-16");
    const d = await decide(r.body.request.id, false);
    expect(d.status).toBe(200);
    expect(d.body.request.status).toBe("rejected");
    const done = await waitStatus(emp, r.body.request.id, () => true);
    expect(done.body.moves).toEqual([]);
    let wf = done.body.workflow.status;
    for (let i = 0; i < 30 && wf !== "COMPLETED"; i++) {
      await Bun.sleep(300);
      wf = (await call(emp, "GET", `/api/v1/requests/${r.body.request.id}`)).body.workflow.status;
    }
    expect(wf).toBe("COMPLETED"); // the workflow ended without ordering
    expect(await remaining()).toBe(before);
  }, 30_000);

  test("R2 over-budget", async () => {
    const r = await ask("WORKSTATION");
    expect(r.status).toBe(201);
    const d = await decide(r.body.request.id, true);
    expect(d.status).toBe(409);
    expect(d.body.error.code).toBe("over-budget");
    const still = await call(emp, "GET", `/api/v1/requests/${r.body.request.id}`);
    expect(still.body.request.status).toBe("waiting");
    expect(still.body.moves).toEqual([]);
  });

  test("R2 employee-cannot-approve", async () => {
    const r = await ask("LAPTOP-14", mgr); // a manager also asks like an employee
    expect(r.status).toBe(201);
    const d = await decide(r.body.request.id, true, emp);
    expect(d.status).toBe(403);
    expect(d.body.error.code).toBe("forbidden");
    await decide(r.body.request.id, false); // clean up the manager's own request
  });
});

describe("R3 · a supplier failure is compensated", () => {
  test("R3 supplier-fails", async () => {
    const before = await remaining();
    const r = await ask("LAPTOP-GAMER"); // the supplier has none in stock
    const d = await decide(r.body.request.id, true);
    expect(d.status).toBe(202);
    expect(d.body.budget.remainingCents).toBe(before - 260_000); // charged at approval
    const done = await waitStatus(emp, r.body.request.id, (s) => s === "cancelled", 25_000);
    expect(done.body.request.status).toBe("cancelled");
    expect(await remaining()).toBe(before); // refunded
  }, 30_000);

  test("R3 refund-once", async () => {
    const r = await ask("LAPTOP-GAMER");
    await decide(r.body.request.id, true);
    const done = await waitStatus(emp, r.body.request.id, (s) => s === "cancelled", 25_000);
    // The supplier was retried (3 attempts, all failed), the compensation ran once.
    const calls = done.body.supplierCalls as { ok: boolean }[];
    expect(calls.length).toBe(3);
    expect(calls.every((c) => !c.ok)).toBe(true);
    const kinds = done.body.moves.map((m: { kind: string; amountCents: number }) => [
      m.kind,
      m.amountCents,
    ]);
    expect(kinds).toEqual([
      ["charge", 260_000],
      ["refund", 260_000],
    ]);
    expect(history(done.body.workflow.id)).toContain("RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED");
  }, 30_000);
});

describe("R4 · company sign-in, roles enforced server-side", () => {
  test("R4 sso-login", async () => {
    const r = await call(emp, "GET", "/api/v1/me");
    expect(r.status).toBe(200);
    expect(r.body.user.roles).toEqual(["employee"]);
    expect((await call(mgr, "GET", "/api/v1/me")).body.user.roles).toEqual(["manager"]);
  });
  test("R4 anonymous-refused", async () => {
    const r = await call(null, "POST", "/api/v1/requests", { itemSku: "DOCK" });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("unauthenticated");
  });
});
