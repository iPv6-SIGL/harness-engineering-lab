// worker.ts — decision D4: drains the `photoshelf:resize` stream in the
// consumer group `resizers`. Competing workers each get a message once; a
// message left pending by a crashed worker is reclaimed after a minute. Each
// message makes the WebP sizes still missing for one photo and acks.
// Health on :8081 (/health, /ready); SIGTERM finishes the messages in hand.
import { RedisClient, S3Client, SQL } from "bun";
import sharp from "sharp";
import { originalKey, parseEntries, renditionKey, type StreamEntry, sizesToMake } from "./plan";

const VAULT_ADDR = Bun.env.VAULT_ADDR ?? "http://openbao.internal:8200";
const VAULT_TOKEN = Bun.env.VAULT_TOKEN ?? "root-dev-token";
const VAULT_PATH = Bun.env.VAULT_PATH ?? "secret/photoshelf";
const APP = VAULT_PATH.split("/").pop() ?? "photoshelf";
const STREAM = `${APP}:resize`;
const GROUP = "resizers";
const CONSUMER = `${APP}-worker-${crypto.randomUUID().slice(0, 8)}`;
const BATCH = 8;
const RECLAIM_IDLE_MS = 60_000;

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, msg, ...extra }));

async function readSecret(name: string): Promise<Record<string, string>> {
  const [mount, ...rest] = VAULT_PATH.split("/");
  const url = `${VAULT_ADDR}/v1/${mount}/data/${[...rest, name].join("/")}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "X-Vault-Token": VAULT_TOKEN } });
      if (res.ok)
        return ((await res.json()) as { data: { data: Record<string, string> } }).data.data;
    } catch (e) {
      if (attempt >= 30) throw e;
    }
    await Bun.sleep(1000);
  }
}

const [pg, store] = await Promise.all([readSecret("postgres"), readSecret("objectstore")]);
const sql = new SQL({
  url: `postgres://${pg.user}:${encodeURIComponent(pg.password)}@${Bun.env.DB_HOST ?? pg.host}:${pg.port}/${pg.database}`,
  max: 4,
});
const s3 = new S3Client({
  endpoint: Bun.env.S3_ENDPOINT ?? store.endpoint,
  bucket: Bun.env.S3_BUCKET ?? store.bucket,
  accessKeyId: store.access_key,
  secretAccessKey: store.secret_key,
  region: Bun.env.S3_REGION ?? "us-east-1",
});
const redisUrl = Bun.env.REDIS_URL ?? "redis://valkey.internal:6379";
// Two connections: a blocking XREADGROUP must not hold up the acks.
const reader = new RedisClient(redisUrl);
const writer = new RedisClient(redisUrl);

try {
  await writer.send("XGROUP", ["CREATE", STREAM, GROUP, "0", "MKSTREAM"]);
} catch (e) {
  if (!String(e).includes("BUSYGROUP")) throw e;
}

type Row = { format: string; widths: string; on_shop: boolean; made: string };
const ints = (s: string) => (s ? s.split(",").map(Number) : []);

async function photo(id: number) {
  const [r]: Row[] = await sql`
    SELECT p.format, array_to_string(p.widths, ',') AS widths, p.on_shop,
           coalesce((SELECT string_agg(width::text, ',') FROM renditions WHERE photo_id = p.id), '') AS made
    FROM photos p WHERE p.id = ${id}`;
  return r
    ? { format: r.format, onShop: r.on_shop, widths: ints(r.widths), made: ints(r.made) }
    : null;
}

async function handle(e: StreamEntry) {
  const t0 = performance.now();
  const p = await photo(e.photoId);
  const todo = p ? sizesToMake(p) : [];
  if (p && todo.length) {
    const original = await s3.file(originalKey(e.photoId, p.format)).arrayBuffer();
    for (const width of todo) {
      const webp = await sharp(original).resize({ width }).webp({ quality: 80 }).toBuffer();
      await s3.write(renditionKey(e.photoId, width), webp, { type: "image/webp" });
      // Recorded only while the photo is still on the shop; a size made for a photo
      // taken off meanwhile is removed, so its public URL never answers.
      const [kept] = await sql`
        INSERT INTO renditions (photo_id, width, bytes)
        SELECT ${e.photoId}, ${width}, ${webp.length} WHERE EXISTS (SELECT 1 FROM photos WHERE id = ${e.photoId} AND on_shop)
        ON CONFLICT (photo_id, width) DO NOTHING
        RETURNING width`;
      if (!kept && !(await photo(e.photoId))?.onShop)
        await s3.delete(renditionKey(e.photoId, width));
    }
  }
  await writer.send("XACK", [STREAM, GROUP, e.id]);
  log("info", "resized", {
    photo: e.photoId,
    sizes: todo,
    ms: Math.round(performance.now() - t0),
  });
}

let stopping = false;
let inHand = 0;
let lastReclaim = 0;

async function loop() {
  while (!stopping) {
    try {
      let entries: StreamEntry[] = [];
      if (Date.now() - lastReclaim > RECLAIM_IDLE_MS / 2) {
        lastReclaim = Date.now();
        const claimed = (await writer.send("XAUTOCLAIM", [
          STREAM,
          GROUP,
          CONSUMER,
          String(RECLAIM_IDLE_MS),
          "0-0",
          "COUNT",
          String(BATCH),
        ])) as unknown[];
        entries = parseEntries([[STREAM, claimed?.[1]]]);
      }
      if (entries.length === 0) {
        const reply = await reader.send("XREADGROUP", [
          "GROUP",
          GROUP,
          CONSUMER,
          "COUNT",
          String(BATCH),
          "BLOCK",
          "2000",
          "STREAMS",
          STREAM,
          ">",
        ]);
        entries = parseEntries(reply);
      }
      inHand = entries.length;
      await Promise.all(
        entries.map((e) =>
          handle(e).catch((err) =>
            // Not acked: the message stays pending and is reclaimed after a minute.
            log("error", "resize failed", { photo: e.photoId, error: String(err) }),
          ),
        ),
      );
      inHand = 0;
    } catch (err) {
      log("error", "stream read failed", { error: String(err) });
      await Bun.sleep(1000);
    }
  }
}

const health = Bun.serve({
  port: 8081,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/health") return Response.json({ status: "ok", inHand });
    if (path === "/ready") {
      try {
        await sql`SELECT 1`;
        await writer.send("PING", []);
        return Response.json({ status: "ready" });
      } catch (e) {
        return Response.json({ status: "not-ready", error: String(e) }, { status: 503 });
      }
    }
    return Response.json({ error: { code: "not-found", message: path } }, { status: 404 });
  },
});

log("info", `photoshelf worker ${CONSUMER} reading ${STREAM} (group ${GROUP})`);
const running = loop();

process.on("SIGTERM", async () => {
  log("info", "SIGTERM: finishing the messages in hand");
  stopping = true;
  await running;
  await health.stop();
  reader.close();
  writer.close();
  await sql.close({ timeout: 2 });
  process.exit(0);
});
