// e2e/scenarios.test.ts — one test per spec scenario, named "<R-id> <scenario-id>"
// exactly as in openspec/changes/add-photoshelf/specs/photoshelf/spec.md: the
// harness runs them by name to flip the ledger (`harness verify-task`). Against
// the deployed stack — API, worker, Valkey stream, public bucket — as the seeded
// personas. No mocks.
import { beforeAll, describe, expect, test } from "bun:test";
import {
  API,
  APP,
  anonymous,
  BASE,
  call,
  fixture,
  freshSku,
  login,
  type Session,
  upload,
  waitBatch,
  webpWidth,
} from "./lib";

let mkt: Session;
let mgr: Session;
let shoot: Uint8Array;
let narrow: Uint8Array;
let small: Uint8Array;

beforeAll(async () => {
  mkt = await login("marketing");
  mgr = await login("catalog-manager");
  shoot = await fixture("shoot-2000.jpg");
  narrow = await fixture("narrow-500.png");
  small = await fixture("batch-400.jpg");
});

/** One photo uploaded and resized: what most scenarios start from. */
async function readyPhoto(sku: string, bytes = small, name = "p.jpg") {
  const up = await upload(mkt, sku, [{ name, bytes }]);
  expect(up.status).toBe(202);
  const done = await waitBatch(mkt, up.body.batch.id);
  expect(done.body.batch.finished).toBe(true);
  return done.body.photos[0];
}

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
    expect(await r.text()).toContain("PhotoShelf");
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
    const s = await login("marketing");
    expect((await call(s, "GET", "/api/v1/me")).status).toBe(200);
    expect(Bun.spawnSync(["podman", "restart", "-t", "10", `${APP}-api`]).exitCode).toBe(0);
    let me = await call(s, "GET", "/api/v1/me");
    for (let i = 0; i < 40 && me.status >= 500; i++) {
      await Bun.sleep(500);
      me = await call(s, "GET", "/api/v1/me");
    }
    expect(me.status).toBe(200);
    expect(me.body.user.name).toBe(`${APP}-test-marketing`);
  });
});

describe("R1 · uploads resized to WebP by the worker", () => {
  test("R1 upload-resized", async () => {
    const sku = freshSku("R1");
    const t0 = performance.now();
    const up = await upload(mkt, sku, [{ name: "shoot.jpg", bytes: shoot, type: "image/jpeg" }]);
    const ms = performance.now() - t0;
    expect(up.status).toBe(202);
    expect(ms).toBeLessThan(2000); // accepted at once: the request never waits for the resizing
    expect(up.body.photos[0].widths).toEqual([320, 800, 1600]);
    const done = await waitBatch(mkt, up.body.batch.id, 30_000);
    expect(done.body.batch).toMatchObject({ total: 1, done: 1, finished: true });
    const sizes = done.body.photos[0].sizes as { width: number; url: string }[];
    expect(sizes.map((s) => s.width)).toEqual([320, 800, 1600]);
    for (const s of sizes) {
      const img = await anonymous(s.url);
      expect(img.status).toBe(200);
      expect(webpWidth(img.bytes)).toBe(s.width);
    }
  }, 40_000);

  test("R1 batch-200", async () => {
    const sku = freshSku("B200");
    const files = Array.from({ length: 200 }, (_, i) => ({ name: `shot-${i}.jpg`, bytes: small }));
    const up = await upload(mkt, sku, files);
    expect(up.status).toBe(202);
    expect(up.body.batch.total).toBe(200);
    const done = await waitBatch(mkt, up.body.batch.id, 50_000);
    expect(done.body.batch).toEqual({
      id: up.body.batch.id,
      sku,
      total: 200,
      done: 200,
      failed: 0,
      finished: true,
    });
    // Exactly once: each photo has its one size, recorded once (renditions' primary key).
    for (const p of done.body.photos) expect(p.made).toEqual([320]);
    expect(new Set(done.body.photos.map((p: { id: number }) => p.id)).size).toBe(200);
    // Every message was acknowledged: nothing pending in the consumer group.
    const pending = Bun.spawnSync([
      "podman",
      "exec",
      "valkey.internal",
      "valkey-cli",
      "XPENDING",
      `${APP}:resize`,
      "resizers",
    ]).stdout.toString();
    expect(pending.split("\n")[0].trim()).toBe("0");
  }, 60_000);

  test("R1 never-upscaled", async () => {
    const p = await readyPhoto(freshSku("NARROW"), narrow, "narrow.png");
    expect(p.width).toBe(500);
    expect(p.widths).toEqual([320]);
    expect(p.made).toEqual([320]);
    const img = await anonymous(p.sizes[0].url);
    expect(webpWidth(img.bytes)).toBe(320);
    expect((await anonymous(p.sizes[0].url.replace("/320.webp", "/800.webp"))).status).not.toBe(
      200,
    );
  }, 30_000);

  test("R1 not-an-image", async () => {
    const sku = freshSku("TXT");
    const text = new TextEncoder().encode("this is a shot list, not a photo");
    const r = await upload(mkt, sku, [
      { name: "good.jpg", bytes: small },
      { name: "notes.jpg", bytes: text, type: "image/jpeg" }, // the name and type lie; the header does not
    ]);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("not-an-image");
    expect(r.body.error.details.file).toBe("notes.jpg");
    // Nothing stored, nothing queued: not even the good photo of the batch.
    const list = await call(mkt, "GET", `/api/v1/photos?sku=${sku}`);
    expect(list.body.photos).toEqual([]);
  });
});

describe("R2 · the shop loads the sizes anonymously", () => {
  test("R2 public-url", async () => {
    const p = await readyPhoto(freshSku("PUB"));
    const img = await anonymous(p.sizes[0].url);
    expect(img.status).toBe(200);
    expect(img.type).toBe("image/webp");
    expect(new TextDecoder().decode(img.bytes.slice(8, 12))).toBe("WEBP");
    expect(p.sizes[0].url.startsWith(`http://localhost:9000/${APP}/photos/`)).toBe(true);
  }, 30_000);

  test("R2 shop-listing", async () => {
    const a = freshSku("SHOPA");
    const b = freshSku("SHOPB");
    const pa = await readyPhoto(a);
    const pb = await readyPhoto(b);
    const r = await call(null, "GET", `/api/v1/shop/${a}/photos`); // no session
    expect(r.status).toBe(200);
    expect(r.body.photos.map((p: { id: number }) => p.id)).toEqual([pa.id]);
    expect(r.body.photos[0].sizes).toEqual(pa.sizes);
    expect(JSON.stringify(r.body)).not.toContain(`/photos/${pb.id}/`);
  }, 30_000);
});

describe("R3 · a catalog manager takes photos off the shop", () => {
  test("R3 take-off", async () => {
    const sku = freshSku("OFF");
    const p = await readyPhoto(sku);
    const off = await call(mgr, "PATCH", `/api/v1/photos/${p.id}`, { onShop: false });
    expect(off.status).toBe(200);
    expect(off.body.photo).toMatchObject({ onShop: false, listed: false, made: [] });
    const shop = await call(null, "GET", `/api/v1/shop/${sku}/photos`);
    expect(shop.body.photos).toEqual([]);
    for (const s of p.sizes) expect((await anonymous(s.url)).status).toBe(404);
  }, 30_000);

  test("R3 put-back", async () => {
    const sku = freshSku("BACK");
    const p = await readyPhoto(sku);
    await call(mgr, "PATCH", `/api/v1/photos/${p.id}`, { onShop: false });
    const back = await call(mgr, "PATCH", `/api/v1/photos/${p.id}`, { onShop: true });
    expect(back.status).toBe(202);
    let shop = await call(null, "GET", `/api/v1/shop/${sku}/photos`);
    for (let i = 0; i < 50 && shop.body.photos.length === 0; i++) {
      await Bun.sleep(400);
      shop = await call(null, "GET", `/api/v1/shop/${sku}/photos`);
    }
    expect(shop.body.photos.map((x: { id: number }) => x.id)).toEqual([p.id]);
    for (const s of shop.body.photos[0].sizes) expect((await anonymous(s.url)).status).toBe(200);
  }, 30_000);

  test("R3 marketing-cannot-take-off", async () => {
    const p = await readyPhoto(freshSku("NOPE"));
    const r = await call(mkt, "PATCH", `/api/v1/photos/${p.id}`, { onShop: false });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("forbidden");
    expect((await anonymous(p.sizes[0].url)).status).toBe(200);
  }, 30_000);
});

describe("R4 · company sign-in, roles enforced server-side", () => {
  test("R4 sso-login", async () => {
    const r = await call(mkt, "GET", "/api/v1/me");
    expect(r.status).toBe(200);
    expect(r.body.user.roles).toEqual(["marketing"]);
    const m = await call(mgr, "GET", "/api/v1/me");
    expect(m.body.user.roles).toEqual(["catalog-manager"]);
  });
  test("R4 anonymous-refused", async () => {
    const r = await upload(null, freshSku("ANON"), [{ name: "a.jpg", bytes: small }]);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("unauthenticated");
  });
});
