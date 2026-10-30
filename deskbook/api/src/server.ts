// server.ts — DeskBook's REST API (/api/v1), its auth routes and its contracts:
// /health, /ready, a uniform error envelope, a rate limit, JSON logs on stdout,
// SIGTERM drain in under 10 s. Bun built-ins only (serve, SQL, S3): no framework.
import { S3Client } from "bun";
import { callback, currentUser, HttpError, loginRedirect, logout, type User } from "./auth";
import { loadConfig } from "./config";
import { bookingsFrom, connect, migrate, resources } from "./db";
import {
  type Booking,
  deskHolderConflict,
  type Half,
  nearestFree,
  occursOn,
  resourceConflict,
  validateRequest,
} from "./domain";

const cfg = await loadConfig();
const sql = connect(cfg.db.url);
await migrate(sql);
const s3 = new S3Client({
  endpoint: cfg.s3.endpoint,
  bucket: cfg.s3.bucket,
  accessKeyId: cfg.s3.accessKeyId,
  secretAccessKey: cfg.s3.secretAccessKey,
  region: cfg.s3.region,
});

const PLAN_TYPES = new Set(["image/png", "image/svg+xml"]);
const MAX_PLAN_BYTES = 2 * 1024 * 1024;
const today = () => new Date().toISOString().slice(0, 10);
const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (status: number, code: string, message: string, details?: unknown) =>
  json({ error: { code, message, ...(details ? { details } : {}) } }, status);

// A per-client token bucket: 30 requests/s burst, refilled continuously.
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

async function requireUser(req: Request, role?: string): Promise<User> {
  const u = await currentUser(sql, req);
  if (!u) throw new HttpError(401, "unauthenticated", "sign in first: GET /auth/login");
  if (role && !u.roles.includes(role))
    throw new HttpError(403, "forbidden", `this action needs the ${role} role`);
  return u;
}

async function book(req: Request): Promise<Response> {
  const u = await requireUser(req);
  const body = (await req.json().catch(() => ({}))) as {
    resourceId?: number;
    day?: string;
    half?: Half;
    repeatUntil?: string | null;
  };
  const invalid = validateRequest(body, today());
  if (invalid) return fail(422, invalid.code, invalid.message);
  const candidate: Booking = {
    resourceId: Number(body.resourceId),
    userSub: u.sub,
    day: body.day as string,
    half: body.half as Half,
    repeatUntil: body.repeatUntil ?? null,
  };
  return await sql.begin(async (tx) => {
    // Serialise per desk, then per person: the invariants hold under concurrency.
    await tx`SELECT pg_advisory_xact_lock(1, ${candidate.resourceId})`;
    await tx`SELECT pg_advisory_xact_lock(2, hashtext(${u.sub}))`;
    const [res] = await tx`SELECT * FROM resources WHERE id = ${candidate.resourceId}`;
    if (!res) return fail(404, "unknown-resource", "no such desk or room");
    if (!res.open)
      return fail(409, "resource-closed", `${res.label} is closed by the office manager`);
    const onResource = await bookingsFrom(tx, candidate.day, {
      resourceId: candidate.resourceId,
      half: candidate.half,
    });
    const taken = resourceConflict(candidate, onResource);
    if (taken) {
      const all = await resources(tx, res.floor);
      const busy = await bookingsFrom(tx, taken, { half: candidate.half });
      const takenIds = new Set(busy.filter((b) => occursOn(b, taken)).map((b) => b.resourceId));
      const suggestions = nearestFree(res, all, takenIds).map((r) => ({
        id: r.id,
        label: r.label,
        floor: r.floor,
      }));
      return fail(409, "desk-taken", `${res.label} is taken on ${taken} (${candidate.half})`, {
        day: taken,
        suggestions,
      });
    }
    if (res.kind === "desk") {
      const held = await bookingsFrom(tx, candidate.day, {
        userSub: u.sub,
        desksOnly: true,
        half: candidate.half,
      });
      const clash = deskHolderConflict(candidate, held);
      if (clash)
        return fail(
          409,
          "already-booked",
          `you already hold a desk on ${clash} (${candidate.half})`,
          { day: clash },
        );
    }
    const [row] =
      await tx`INSERT INTO bookings (resource_id, user_sub, user_name, day, half, repeat_until)
      VALUES (${candidate.resourceId}, ${u.sub}, ${u.name}, ${candidate.day}::date, ${candidate.half}, ${candidate.repeatUntil}::date)
      RETURNING id`;
    return json({ booking: { id: row.id, ...candidate, label: res.label } }, 201);
  });
}

async function listResources(req: Request, url: URL): Promise<Response> {
  const u = await requireUser(req);
  const floor = Number(url.searchParams.get("floor") ?? 1);
  const day = url.searchParams.get("day") ?? today();
  const half = (url.searchParams.get("half") ?? "am") as Half;
  const all = await resources(sql, floor);
  const occupying = (await bookingsFrom(sql, day, { half })).filter((b) => occursOn(b, day));
  const by = new Map(occupying.map((b) => [b.resourceId, b]));
  return json({
    floor,
    day,
    half,
    resources: all.map((r) => ({
      ...r,
      taken: by.has(r.id),
      mine: by.get(r.id)?.userSub === u.sub,
    })),
  });
}

async function setOpen(req: Request, id: number): Promise<Response> {
  await requireUser(req, "office-manager");
  const body = (await req.json().catch(() => ({}))) as { open?: boolean };
  if (typeof body.open !== "boolean")
    return fail(422, "invalid-open", "open must be true or false");
  const [r] =
    await sql`UPDATE resources SET open = ${body.open} WHERE id = ${id} AND kind = 'room' RETURNING id, label, open`;
  return r ? json({ resource: r }) : fail(404, "unknown-room", "no such room");
}

async function putPlan(req: Request, floor: number): Promise<Response> {
  await requireUser(req, "office-manager");
  const type = req.headers.get("content-type") ?? "";
  if (!PLAN_TYPES.has(type))
    return fail(415, "unsupported-type", "a floor plan is image/png or image/svg+xml");
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_PLAN_BYTES)
    return fail(413, "bad-size", "a floor plan is 1 byte to 2 MB");
  await s3.write(`floors/${floor}`, bytes, { type });
  return json({ floor, bytes: bytes.length, type }, 201);
}

async function getPlan(req: Request, floor: number): Promise<Response> {
  await requireUser(req);
  const f = s3.file(`floors/${floor}`);
  if (!(await f.exists())) return fail(404, "no-plan", `no floor plan for floor ${floor}`);
  return new Response(f.stream(), {
    headers: {
      "Content-Type": f.type || "application/octet-stream",
      "Cache-Control": "private, no-cache",
    },
  });
}

async function route(req: Request, url: URL): Promise<Response> {
  const p = url.pathname;
  const m = req.method;
  if (p === "/health") return json({ status: "ok" });
  if (p === "/ready") {
    await sql`SELECT 1`;
    await s3.exists("ready-probe");
    return json({ status: "ready" });
  }
  if (p === "/auth/login" && m === "GET") return loginRedirect(sql, cfg);
  if (p === "/auth/callback" && m === "GET") return callback(sql, cfg, url);
  if (p === "/auth/logout" && m === "POST") return logout(sql, req);
  if (p === "/api/v1/me" && m === "GET") return json({ user: await requireUser(req) });
  if (p === "/api/v1/resources" && m === "GET") return listResources(req, url);
  if (p === "/api/v1/bookings" && m === "POST") return book(req);
  let x = p.match(/^\/api\/v1\/resources\/(\d+)$/);
  if (x && m === "PATCH") return setOpen(req, Number(x[1]));
  x = p.match(/^\/api\/v1\/floors\/([1-9]\d?)\/plan$/);
  if (x && m === "PUT") return putPlan(req, Number(x[1]));
  if (x && m === "GET") return getPlan(req, Number(x[1]));
  return fail(404, "not-found", `${m} ${p}`);
}

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
        path: url.pathname,
        status: res.status,
        ms: Math.round(performance.now() - t0),
      }),
    );
    return res;
  },
});
console.log(JSON.stringify({ level: "info", msg: `deskbook api ready on :${server.port}` }));

// SIGTERM: stop accepting, let in-flight requests finish, close the pool, exit well under 10 s.
process.on("SIGTERM", async () => {
  console.log(JSON.stringify({ level: "info", msg: "SIGTERM: draining" }));
  await server.stop();
  await sql.close({ timeout: 3 });
  process.exit(0);
});
