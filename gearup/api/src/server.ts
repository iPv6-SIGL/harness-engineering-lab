// server.ts — GearUp's REST API (/api/v1), its auth routes and its contracts:
// /health, /ready, a uniform error envelope, a rate limit, JSON logs on stdout,
// SIGTERM drain in under 10 s. Bun built-ins (serve, SQL) + the Temporal client.
//
// Decision D2: each request is a Temporal workflow that waits up to 3 days for
// the manager, reminds after 2, orders, and compensates a supplier failure.
// The API records the facts (and checks the budget) in Postgres, then starts or
// signals the workflow; it never waits for the process itself.
import { Client, Connection } from "@temporalio/client";
import { callback, currentUser, HttpError, loginRedirect, logout, type User } from "./auth";
import { loadConfig } from "./config";
import { connect, type Db, migrate, moves, type RequestRow, requests, teamOf } from "./db";
import {
  canAsk,
  canDecide,
  checkApproval,
  checkRejection,
  deadlines,
  type Item,
  next,
  remainingCents,
  reminderDue,
  type Status,
  validateAsk,
  workflowTimers,
} from "./domain";

const cfg = await loadConfig();
const sql = connect(cfg.db.url);
await migrate(sql);

async function temporalClient(): Promise<Client> {
  for (let attempt = 1; ; attempt++) {
    try {
      const connection = await Connection.connect({ address: cfg.temporal.address });
      return new Client({ connection, namespace: cfg.temporal.namespace });
    } catch (e) {
      if (attempt >= 30) throw e;
      await Bun.sleep(1000);
    }
  }
}
const temporal = await temporalClient();
const workflowId = (requestId: number) => `request-${requestId}`;

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (status: number, code: string, message: string, details?: unknown) =>
  json({ error: { code, message, ...(details ? { details } : {}) } }, status);

// A per-client token bucket: 30 requests/s burst, refilled continuously. In
// process on purpose, as in DeskBook: with N replicas the limit is N × 30/s.
const buckets = new Map<string, { tokens: number; at: number }>();
function rateLimited(key: string): boolean {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: 30, at: now };
  b.tokens = Math.min(30, b.tokens + ((now - b.at) / 1000) * 30);
  b.at = now;
  buckets.set(key, b);
  if (b.tokens < 1) return true;
  b.tokens -= 1;
  return false;
}

type Member = User & { teamId: number };

async function requireUser(req: Request, may?: (roles: string[]) => boolean): Promise<Member> {
  const u = await currentUser(sql, req);
  if (!u) throw new HttpError(401, "unauthenticated", "sign in first: GET /auth/login");
  if (may && !may(u.roles))
    throw new HttpError(403, "forbidden", "your role does not allow this action");
  return { ...u, teamId: await teamOf(sql, u.sub, u.name) };
}

async function catalog(db: Db): Promise<Item[]> {
  const rows = await db`SELECT sku, name, price_cents FROM items ORDER BY price_cents`;
  return rows.map((r: { sku: string; name: string; price_cents: number }) => ({
    sku: r.sku,
    name: r.name,
    priceCents: r.price_cents,
  }));
}

async function budget(db: Db, teamId: number) {
  const [t] = await db`SELECT budget_cents FROM teams WHERE id = ${teamId}`;
  const m = await moves(db, { teamId });
  return {
    budgetCents: t.budget_cents as number,
    remainingCents: remainingCents(t.budget_cents, m),
  };
}

const view = (r: RequestRow) => ({
  id: r.id,
  item: { sku: r.item_sku, name: r.item_name },
  priceCents: r.price_cents,
  status: r.status,
  requester: r.name,
  createdAt: r.created_at,
  remindAt: r.remind_at,
  expiresAt: r.expires_at,
  remindedAt: r.reminded_at,
  reminderDue: reminderDue(r.status as Status, Date.now(), new Date(r.remind_at).getTime()),
  decidedBy: r.decided_by,
  workflowId: workflowId(r.id),
});

async function getCatalog(req: Request): Promise<Response> {
  const u = await requireUser(req);
  return json({ items: await catalog(sql), budget: await budget(sql, u.teamId) });
}

async function ask(req: Request): Promise<Response> {
  const u = await requireUser(req, canAsk);
  const body = (await req.json().catch(() => ({}))) as { itemSku?: unknown };
  const open =
    await sql`SELECT item_sku FROM requests WHERE sub = ${u.sub} AND status IN ('waiting','approved')`;
  const checked = validateAsk(
    body,
    await catalog(sql),
    open.map((o: { item_sku: string }) => o.item_sku),
  );
  if ("problem" in checked)
    return fail(checked.problem.status, checked.problem.code, checked.problem.message);
  const now = Date.now();
  const d = deadlines(now);
  let row: RequestRow;
  try {
    [row] = await sql`
      INSERT INTO requests (sub, name, team_id, item_sku, price_cents, status, created_at, remind_at, expires_at)
      VALUES (${u.sub}, ${u.name}, ${u.teamId}, ${checked.item.sku}, ${checked.item.priceCents}, 'waiting',
              ${new Date(now)}, ${new Date(d.remindAt)}, ${new Date(d.expiresAt)})
      RETURNING *`;
  } catch (e) {
    // Two clicks at once: the partial unique index is the last word on "one open request per item".
    if (String(e).includes("one_open_request"))
      return fail(409, "already-open", `you already have an open request for ${checked.item.name}`);
    throw e;
  }
  await temporal.workflow.start("gearRequest", {
    taskQueue: cfg.temporal.taskQueue,
    workflowId: workflowId(row.id),
    args: [{ requestId: row.id, ...workflowTimers() }],
  });
  const [full] = await requests(sql, { id: row.id });
  return json({ request: view(full) }, 201);
}

async function list(req: Request, url: URL): Promise<Response> {
  const team = url.searchParams.get("scope") === "team";
  const u = await requireUser(req, team ? canDecide : undefined);
  const rows = await requests(sql, team ? { teamId: u.teamId } : { sub: u.sub });
  return json({ requests: rows.map(view), budget: await budget(sql, u.teamId) });
}

async function getOne(req: Request, id: number): Promise<Response> {
  const u = await requireUser(req);
  const [r] = await requests(sql, { id });
  if (!r || (r.sub !== u.sub && !(canDecide(u.roles) && r.team_id === u.teamId)))
    return fail(404, "unknown-request", "no such request");
  const supplier =
    await sql`SELECT ok, at FROM supplier_calls WHERE request_id = ${id} ORDER BY id`;
  let workflow: { status: string } = { status: "unknown" };
  try {
    const d = await temporal.workflow.getHandle(workflowId(id)).describe();
    workflow = { status: d.status.name };
  } catch {
    workflow = { status: "not-found" };
  }
  return json({
    request: view(r),
    moves: await moves(sql, { requestId: id }),
    supplierCalls: supplier,
    workflow: { id: workflowId(id), ...workflow },
    budget: await budget(sql, r.team_id),
  });
}

async function decide(req: Request, id: number): Promise<Response> {
  const u = await requireUser(req, canDecide);
  const body = (await req.json().catch(() => ({}))) as { approve?: unknown };
  if (typeof body.approve !== "boolean")
    return fail(422, "invalid-decision", "approve must be true or false");
  const approve = body.approve;
  const outcome = await sql.begin(async (tx) => {
    const [r] =
      await tx`SELECT * FROM requests WHERE id = ${id} AND team_id = ${u.teamId} FOR UPDATE`;
    if (!r)
      return { status: 404, code: "unknown-request", message: "no such request in your team" };
    // The team row is the lock: two approvals of one team never both pass the budget check.
    const [team] = await tx`SELECT budget_cents FROM teams WHERE id = ${u.teamId} FOR UPDATE`;
    const left = remainingCents(team.budget_cents, await moves(tx, { teamId: u.teamId }));
    const problem = approve
      ? checkApproval({
          status: r.status,
          nowMs: Date.now(),
          expiresAtMs: new Date(r.expires_at).getTime(),
          priceCents: r.price_cents,
          remainingCents: left,
        })
      : checkRejection(r.status);
    if (problem) return problem;
    const to = next(r.status, approve ? "approve" : "reject");
    await tx`UPDATE requests SET status = ${to}, decided_by = ${u.name}, decided_at = now(),
             closed_at = ${approve ? null : new Date()} WHERE id = ${id}`;
    if (approve)
      await tx`INSERT INTO budget_moves (request_id, kind, amount_cents) VALUES (${id}, 'charge', ${r.price_cents})`;
    return null;
  });
  if (outcome) return fail(outcome.status, outcome.code, outcome.message);
  // Wakes the waiting workflow now. Were the signal lost, the workflow would still
  // read the decision from Postgres when its timer fires: the row is the fact.
  await temporal.workflow.getHandle(workflowId(id)).signal("decision", { approved: approve });
  const [r] = await requests(sql, { id });
  return json({ request: view(r), budget: await budget(sql, u.teamId) }, approve ? 202 : 200);
}

async function route(req: Request, url: URL): Promise<Response> {
  const p = url.pathname;
  const m = req.method;
  if (p === "/health") return json({ status: "ok" });
  if (p === "/ready") {
    await sql`SELECT 1`;
    await temporal.workflowService.getSystemInfo({});
    return json({ status: "ready" });
  }
  if (p === "/auth/login" && m === "GET") return loginRedirect(sql, cfg);
  if (p === "/auth/callback" && m === "GET") return callback(sql, cfg, url);
  if (p === "/auth/logout" && m === "POST") return logout(sql, req);
  if (p === "/api/v1/me" && m === "GET") return json({ user: await requireUser(req) });
  if (p === "/api/v1/catalog" && m === "GET") return getCatalog(req);
  if (p === "/api/v1/requests" && m === "POST") return ask(req);
  if (p === "/api/v1/requests" && m === "GET") return list(req, url);
  let x = p.match(/^\/api\/v1\/requests\/(\d+)$/);
  if (x && m === "GET") return getOne(req, Number(x[1]));
  x = p.match(/^\/api\/v1\/requests\/(\d+)\/decision$/);
  if (x && m === "POST") return decide(req, Number(x[1]));
  return fail(404, "not-found", `${m} ${p}`);
}

/** The route template of a path (ids replaced), as the measurement contract (p99.ts) groups requests. */
const routeOf = (path: string) => path.replace(/\/\d+(?=\/|$)/g, "/:id");

const server = Bun.serve({
  port: 8080,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const t0 = performance.now();
    let res: Response;
    const client = req.headers.get("cookie")?.slice(-16) ?? srv.requestIP(req)?.address ?? "?";
    if (url.pathname.startsWith("/api/") && rateLimited(client))
      res = fail(429, "rate-limited", "slow down");
    else {
      try {
        res = await route(req, url);
      } catch (e) {
        if (e instanceof HttpError) res = fail(e.status, e.code, e.message, e.details);
        else {
          console.error(JSON.stringify({ level: "error", path: url.pathname, error: String(e) }));
          res = fail(500, "internal", "unexpected error");
        }
      }
    }
    console.log(
      JSON.stringify({
        level: "info",
        method: req.method,
        route: routeOf(url.pathname),
        status: res.status,
        duration_ms: Math.round(performance.now() - t0),
      }),
    );
    return res;
  },
});
console.log(JSON.stringify({ level: "info", msg: `gearup api ready on :${server.port}` }));

// SIGTERM: stop accepting, let in-flight requests finish, close the pools, exit well under 10 s.
process.on("SIGTERM", async () => {
  console.log(JSON.stringify({ level: "info", msg: "SIGTERM: draining" }));
  await server.stop();
  await temporal.connection.close();
  await sql.close({ timeout: 3 });
  process.exit(0);
});
