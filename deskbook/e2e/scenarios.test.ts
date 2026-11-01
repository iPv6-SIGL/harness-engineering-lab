// e2e/scenarios.test.ts — one test per spec scenario, named "<R-id> <scenario-id>"
// exactly as in openspec/changes/add-deskbook/specs/deskbook/spec.md: the harness
// runs them by name to flip the ledger (`harness verify-task`). Against the
// deployed stack, as the seeded personas — no mocks.
import { beforeAll, describe, expect, test } from "bun:test";
import { API, APP, BASE, call, deskByLabel, freshMonday, login, plus, type Session } from "./lib";

let emp: Session;
let mgr: Session;
const day = freshMonday();

beforeAll(async () => {
  emp = await login("employee");
  mgr = await login("office-manager");
});

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
    expect(await r.text()).toContain("DeskBook");
  });
  test("C1 oidc", async () => {
    const r = await fetch(`${BASE}/auth/login`, { redirect: "manual" });
    expect(r.status).toBe(302);
    const to = new URL(r.headers.get("location")!);
    expect(to.origin).toBe("http://localhost:9300");
    expect(to.searchParams.get("redirect_uri")).toBe(`${BASE}/auth/callback`);
  });
  test("C1 stateless", async () => {
    // A brand-new API process (what a second replica is) must serve an existing session.
    const s = await login("employee");
    expect((await call(s, "GET", "/api/v1/me")).status).toBe(200);
    expect(Bun.spawnSync(["podman", "restart", "-t", "10", `${APP}-api`]).exitCode).toBe(0);
    // Wait through the user's path (nginx → API): the new process has a new IP,
    // which nginx re-resolves (≈ 1 s of 502 while the network DNS catches up).
    let me = await call(s, "GET", "/api/v1/me");
    for (let i = 0; i < 40 && me.status >= 500; i++) {
      await Bun.sleep(500);
      me = await call(s, "GET", "/api/v1/me");
    }
    expect(me.status).toBe(200);
    expect(me.body.user.name).toBe(`${APP}-test-employee`);
  });
});

describe("R1 · one free desk per half-day", () => {
  test("R1 desk-taken", async () => {
    const a = await deskByLabel(mgr, "F1-D13", day);
    expect(
      (await call(mgr, "POST", "/api/v1/bookings", { resourceId: a.id, day, half: "am" })).status,
    ).toBe(201);
    const r = await call(emp, "POST", "/api/v1/bookings", { resourceId: a.id, day, half: "am" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("desk-taken");
    const s = r.body.error.details.suggestions;
    expect(s.length).toBe(2);
    for (const x of s) {
      expect(x.floor).toBe(1);
      expect((await deskByLabel(emp, x.label, day)).taken).toBe(false);
    }
    // F1-D13 sits at (100,100): its neighbours one step away are D02, D12, D14, D24 → the two first by label
    expect(s.map((x: any) => x.label)).toEqual(["F1-D02", "F1-D12"]);
  });

  test("R1 one-per-half-day", async () => {
    const a = await deskByLabel(emp, "F2-D30", day);
    const b = await deskByLabel(emp, "F2-D31", day);
    expect(
      (await call(emp, "POST", "/api/v1/bookings", { resourceId: a.id, day, half: "pm" })).status,
    ).toBe(201);
    const r = await call(emp, "POST", "/api/v1/bookings", { resourceId: b.id, day, half: "pm" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("already-booked");
  });

  test("R1 no-double-booking", async () => {
    const d = plus(day, 1);
    const desk = await deskByLabel(emp, "F3-D40", d);
    const [x, y] = await Promise.all([
      call(emp, "POST", "/api/v1/bookings", { resourceId: desk.id, day: d, half: "am" }),
      call(mgr, "POST", "/api/v1/bookings", { resourceId: desk.id, day: d, half: "am" }),
    ]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
  });
});

describe("R2 · sign in once, act by role", () => {
  test("R2 sso-login", async () => {
    const e = await call(emp, "GET", "/api/v1/me");
    expect(e.status).toBe(200);
    expect(e.body.user.name).toBe(`${APP}-test-employee`);
    expect(e.body.user.roles).toEqual(["employee"]);
    const m = await call(mgr, "GET", "/api/v1/me");
    expect(m.body.user.roles).toEqual(["office-manager"]);
  });
  test("R2 anonymous-refused", async () => {
    const r = await call(null, "GET", "/api/v1/me");
    expect(r.status).toBe(401);
    expect(r.body).toEqual({
      error: { code: "unauthenticated", message: "sign in first: GET /auth/login" },
    });
  });
});

describe("R3 · rooms opened and closed by the office manager", () => {
  test("R3 manager-closes-room", async () => {
    const d = plus(day, 2);
    const room = await deskByLabel(mgr, "F2-R1", d);
    expect((await call(mgr, "PATCH", `/api/v1/resources/${room.id}`, { open: false })).status).toBe(
      200,
    );
    try {
      const r = await call(emp, "POST", "/api/v1/bookings", {
        resourceId: room.id,
        day: d,
        half: "am",
      });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("resource-closed");
    } finally {
      await call(mgr, "PATCH", `/api/v1/resources/${room.id}`, { open: true });
    }
  });
  test("R3 employee-cannot-close", async () => {
    const room = await deskByLabel(emp, "F2-R2", day);
    const r = await call(emp, "PATCH", `/api/v1/resources/${room.id}`, { open: false });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("forbidden");
  });
});

describe("R4 · private floor plans", () => {
  const png = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...crypto.getRandomValues(new Uint8Array(64)),
  ]);
  test("R4 upload-plan", async () => {
    const up = await call(mgr, "PUT", "/api/v1/floors/2/plan", png, {
      "Content-Type": "image/png",
    });
    expect(up.status).toBe(201);
    const res = await fetch(`${BASE}/api/v1/floors/2/plan`, { headers: { Cookie: emp.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
  });
  test("R4 plan-private", async () => {
    expect(
      (await call(emp, "PUT", "/api/v1/floors/2/plan", png, { "Content-Type": "image/png" }))
        .status,
    ).toBe(403);
    expect((await call(null, "GET", "/api/v1/floors/2/plan")).status).toBe(401);
    expect((await fetch(`http://localhost:9000/${APP}/floors/2`)).status).toBe(403);
    expect((await fetch(`http://localhost:9000/${APP}/`)).status).toBe(403);
  });
});

describe("R5 · weekly until an end date, read at query time", () => {
  test("R5 weekly-until", async () => {
    const desk = await deskByLabel(emp, "F3-D05", day);
    const until = plus(day, 21);
    const r = await call(emp, "POST", "/api/v1/bookings", {
      resourceId: desk.id,
      day,
      half: "am",
      repeatUntil: until,
    });
    expect(r.status).toBe(201);
    for (const w of [0, 7, 14, 21])
      expect((await deskByLabel(emp, "F3-D05", plus(day, w))).mine).toBe(true);
    expect((await deskByLabel(emp, "F3-D05", plus(day, 28))).taken).toBe(false);
    expect((await deskByLabel(emp, "F3-D05", plus(day, 1))).taken).toBe(false);
    const tooLong = await call(emp, "POST", "/api/v1/bookings", {
      resourceId: desk.id,
      day: plus(day, 400),
      half: "pm",
      repeatUntil: plus(day, 400 + 27 * 7),
    });
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.error.code).toBe("repeat-too-long");
  });
  test("R5 weekly-conflict", async () => {
    const start = plus(day, 3); // a Thursday: the employee holds nothing then
    const desk = await deskByLabel(mgr, "F3-D06", start);
    expect(
      (
        await call(emp, "POST", "/api/v1/bookings", {
          resourceId: desk.id,
          day: start,
          half: "pm",
          repeatUntil: plus(start, 28),
        })
      ).status,
    ).toBe(201);
    const r = await call(mgr, "POST", "/api/v1/bookings", {
      resourceId: desk.id,
      day: plus(start, 14),
      half: "pm",
    });
    expect(r.status).toBe(409);
    expect(r.body.error.details.day).toBe(plus(start, 14));
    expect(
      (
        await call(mgr, "POST", "/api/v1/bookings", {
          resourceId: desk.id,
          day: plus(start, 35),
          half: "pm",
        })
      ).status,
    ).toBe(201);
  });
});
