// server.ts — PhotoShelf's REST API (/api/v1), its auth routes and its contracts:
// /health, /ready, a uniform error envelope, a rate limit, JSON logs on stdout,
// SIGTERM drain in under 10 s. Bun built-ins only (serve, SQL, S3, Redis): no framework.
//
// Decision D4: the upload stores the originals and answers 202 — the resizing
// is a message on the `photoshelf:resize` stream, drained by the worker.
// Decision D3: the shop reads the sizes straight from the public bucket.
import { RedisClient, S3Client } from "bun";
import { callback, currentUser, HttpError, loginRedirect, logout, type User } from "./auth";
import { loadConfig } from "./config";
import { connect, migrate, type PhotoRow, photos } from "./db";
import {
  batchProgress,
  canTakeOff,
  canUpload,
  isListed,
  isSku,
  originalKey,
  publicUrl,
  renditionKey,
  type Upload,
  validateBatch,
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
const redis = new RedisClient(cfg.redisUrl);
/** Every key of the app is under `photoshelf:` — the platform's attribution contract. */
const STREAM = `${cfg.app}:resize`;

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

async function requireUser(req: Request, may?: (roles: string[]) => boolean): Promise<User> {
  const u = await currentUser(sql, req);
  if (!u) throw new HttpError(401, "unauthenticated", "sign in first: GET /auth/login");
  if (may && !may(u.roles))
    throw new HttpError(403, "forbidden", "your role does not allow this action");
  return u;
}

/** Runs `f` over `items`, at most `n` at a time: 200 originals go to the bucket in parallel, not all at once. */
async function inParallel<T>(items: T[], n: number, f: (x: T) => Promise<unknown>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      for (let x = queue.shift(); x !== undefined; x = queue.shift()) await f(x);
    }),
  );
}

const enqueue = (photoId: number) => redis.send("XADD", [STREAM, "*", "photo", String(photoId)]);

async function upload(req: Request): Promise<Response> {
  const u = await requireUser(req, canUpload);
  const form = await req.formData().catch(() => null);
  if (!form) return fail(422, "not-multipart", "send multipart/form-data: sku + photos");
  const files: Upload[] = [];
  for (const v of form.getAll("photos")) {
    if (typeof v === "string") continue;
    files.push({ name: v.name || "photo", bytes: new Uint8Array(await v.arrayBuffer()) });
  }
  const checked = validateBatch(form.get("sku"), files);
  if (!checked.ok) return fail(422, checked.error.code, checked.error.message, checked.error);
  const sku = String(form.get("sku"));
  const { batchId, ids } = await sql.begin(async (tx) => {
    const [b] =
      await tx`INSERT INTO batches (sku, created_by) VALUES (${sku}, ${u.sub}) RETURNING id`;
    const ids: number[] = [];
    for (const p of checked.photos) {
      const [row] = await tx`
        INSERT INTO photos (batch_id, sku, name, format, width, height, widths)
        VALUES (${b.id}, ${sku}, ${p.name}, ${p.info.format}, ${p.info.width}, ${p.info.height},
                string_to_array(${p.widths.join(",")}, ',')::int[])
        RETURNING id`;
      ids.push(row.id);
    }
    return { batchId: b.id as number, ids };
  });
  const jobs = checked.photos.map((p, i) => ({ p, id: ids[i], bytes: files[i].bytes }));
  await inParallel(jobs, 16, (j) =>
    s3.write(originalKey(j.id, j.p.info.format), j.bytes, {
      type: j.p.info.format === "jpeg" ? "image/jpeg" : "image/png",
    }),
  );
  // Queued only once every original is in the bucket: a worker never reads a missing file.
  await inParallel(ids, 16, enqueue);
  return json(
    {
      batch: { id: batchId, sku, total: ids.length },
      photos: checked.photos.map((p, i) => ({ id: ids[i], name: p.name, widths: p.widths })),
    },
    202,
  );
}

const view = (p: PhotoRow) => ({
  id: p.id,
  sku: p.sku,
  name: p.name,
  format: p.format,
  width: p.width,
  height: p.height,
  widths: p.widths,
  made: p.made,
  onShop: p.on_shop,
  listed: isListed({ onShop: p.on_shop, widths: p.widths, made: p.made }),
  sizes: p.made.map((w) => ({
    width: w,
    url: publicUrl(cfg.s3.publicBase, cfg.s3.bucket, p.id, w),
  })),
});

async function getBatch(req: Request, id: number): Promise<Response> {
  await requireUser(req);
  const rows = await photos(sql, { batchId: id });
  if (rows.length === 0) return fail(404, "unknown-batch", "no such batch");
  const progress = batchProgress(
    rows.map((p) => ({ onShop: p.on_shop, widths: p.widths, made: p.made })),
  );
  return json({ batch: { id, sku: rows[0].sku, ...progress }, photos: rows.map(view) });
}

async function listPhotos(req: Request, url: URL): Promise<Response> {
  await requireUser(req);
  const sku = url.searchParams.get("sku");
  if (!isSku(sku)) return fail(422, "invalid-sku", "sku is 3 to 32 letters, digits or dashes");
  return json({ sku, photos: (await photos(sql, { sku })).map(view) });
}

/** The shop's read: anonymous, only what is listed, only public URLs. */
async function shopListing(sku: string): Promise<Response> {
  if (!isSku(sku)) return fail(422, "invalid-sku", "sku is 3 to 32 letters, digits or dashes");
  const listed = (await photos(sql, { sku })).filter((p) =>
    isListed({ onShop: p.on_shop, widths: p.widths, made: p.made }),
  );
  return json({
    sku,
    photos: listed.map((p) => ({
      id: p.id,
      width: p.width,
      height: p.height,
      sizes: view(p).sizes,
    })),
  });
}

async function setOnShop(req: Request, id: number): Promise<Response> {
  await requireUser(req, canTakeOff);
  const body = (await req.json().catch(() => ({}))) as { onShop?: boolean };
  if (typeof body.onShop !== "boolean")
    return fail(422, "invalid-on-shop", "onShop must be true or false");
  const [before] = await photos(sql, { id });
  if (!before) return fail(404, "unknown-photo", "no such photo");
  await sql`UPDATE photos SET on_shop = ${body.onShop} WHERE id = ${id}`;
  if (!body.onShop) {
    // Off the shop: the public URLs must stop answering, so the objects go.
    await sql`DELETE FROM renditions WHERE photo_id = ${id}`;
    await Promise.all(before.widths.map((w) => s3.delete(renditionKey(id, w))));
  } else if (!before.on_shop) {
    await enqueue(id); // back on: its sizes are made again, by the worker
  }
  const [after] = await photos(sql, { id });
  return json({ photo: view(after) }, body.onShop && !before.on_shop ? 202 : 200);
}

async function route(req: Request, url: URL): Promise<Response> {
  const p = url.pathname;
  const m = req.method;
  if (p === "/health") return json({ status: "ok" });
  if (p === "/ready") {
    await sql`SELECT 1`;
    await s3.exists("ready-probe");
    await redis.send("PING", []);
    return json({ status: "ready" });
  }
  if (p === "/auth/login" && m === "GET") return loginRedirect(sql, cfg);
  if (p === "/auth/callback" && m === "GET") return callback(sql, cfg, url);
  if (p === "/auth/logout" && m === "POST") return logout(sql, req);
  if (p === "/api/v1/me" && m === "GET") return json({ user: await requireUser(req) });
  if (p === "/api/v1/batches" && m === "POST") return upload(req);
  if (p === "/api/v1/photos" && m === "GET") return listPhotos(req, url);
  let x = p.match(/^\/api\/v1\/batches\/(\d+)$/);
  if (x && m === "GET") return getBatch(req, Number(x[1]));
  x = p.match(/^\/api\/v1\/photos\/(\d+)$/);
  if (x && m === "PATCH") return setOnShop(req, Number(x[1]));
  x = p.match(/^\/api\/v1\/shop\/([^/]+)\/photos$/);
  if (x && m === "GET") return shopListing(decodeURIComponent(x[1]));
  return fail(404, "not-found", `${m} ${p}`);
}

const server = Bun.serve({
  port: 8080,
  maxRequestBodySize: 256 * 1024 * 1024, // a batch: up to 200 photos (nginx caps it the same)
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
console.log(JSON.stringify({ level: "info", msg: `photoshelf api ready on :${server.port}` }));

// SIGTERM: stop accepting, let in-flight requests finish, close the pools, exit well under 10 s.
process.on("SIGTERM", async () => {
  console.log(JSON.stringify({ level: "info", msg: "SIGTERM: draining" }));
  await server.stop();
  redis.close();
  await sql.close({ timeout: 3 });
  process.exit(0);
});
