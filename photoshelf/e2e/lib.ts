// e2e/lib.ts — the scenarios log in AS A PERSONA through the real OIDC flow:
// the credentials come from secret/photoshelf/test-users (seeded by the platform),
// never from the platform admin and never from a bypass route.
const BAO = process.env.BAO_ADDR ?? "http://localhost:8200";
const TOKEN = process.env.BAO_TOKEN ?? "root-dev-token";
export const APP = process.env.APP ?? "photoshelf";
export const BASE = process.env.PHOTOSHELF_URL ?? "http://localhost:8020";
export const API = process.env.PHOTOSHELF_API ?? "http://localhost:8021";
const IDP = process.env.IDP_URL ?? "http://localhost:9300";

export async function secret(name: string): Promise<Record<string, string>> {
  const res = await fetch(`${BAO}/v1/secret/data/${APP}/${name}`, {
    headers: { "X-Vault-Token": TOKEN },
  });
  if (!res.ok) throw new Error(`secret/${APP}/${name}: HTTP ${res.status}`);
  return ((await res.json()) as { data: { data: Record<string, string> } }).data.data;
}

export type Session = { cookie: string; persona: string };

export async function login(persona: "marketing" | "catalog-manager"): Promise<Session> {
  const users = await secret("test-users");
  // 1. the app starts the flow and remembers a state
  const start = await fetch(`${BASE}/auth/login`, { redirect: "manual" });
  const authorize = new URL(start.headers.get("location") ?? "");
  const q = authorize.searchParams;
  // 2. the persona signs in at the IdP (what the Casdoor login page posts)
  const params = new URLSearchParams({
    clientId: q.get("client_id")!,
    responseType: "code",
    redirectUri: q.get("redirect_uri")!,
    type: "code",
    scope: q.get("scope")!,
    state: q.get("state")!,
    nonce: "",
  });
  const res = await fetch(`${IDP}/api/login?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      application: APP,
      organization: "built-in",
      username: users[`${persona}_username`],
      password: users.shared_password,
      autoSignin: true,
      type: "code",
    }),
  });
  const body = (await res.json()) as { status: string; data: string; msg: string };
  if (body.status !== "ok") throw new Error(`IdP login failed for ${persona}: ${body.msg}`);
  // 3. the IdP redirects back with a code; the app exchanges it and opens a session
  const cb = await fetch(`${BASE}/auth/callback?code=${body.data}&state=${q.get("state")}`, {
    redirect: "manual",
  });
  const cookie = (cb.headers.get("set-cookie") ?? "").split(";")[0];
  if (cb.status !== 302 || !cookie.includes("="))
    throw new Error(`callback failed: HTTP ${cb.status} ${await cb.text()}`);
  return { cookie, persona };
}

export async function call(
  s: Session | null,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const init: RequestInit = {
    method,
    headers: { ...(s ? { Cookie: s.cookie } : {}), ...headers },
    signal: AbortSignal.timeout(20_000), // a scenario fails, it never hangs
  };
  if (body instanceof FormData || body instanceof Uint8Array) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null; // a non-JSON body (an image, nginx's HTML): `raw` carries it
  }
  return { status: res.status, body: json, raw: text, headers: res.headers };
}

/** A SKU no earlier run used, so reruns never see each other's photos. */
export const freshSku = (tag: string) =>
  `E2E-${tag}-${crypto.randomUUID().slice(0, 8)}`.toUpperCase().slice(0, 32);

export const fixture = async (name: string) =>
  new Uint8Array(await Bun.file(`${import.meta.dir}/fixtures/${name}`).arrayBuffer());

/** Uploads one batch, as the browser form does (multipart: sku + photos). */
export async function upload(
  s: Session | null,
  sku: string,
  files: { name: string; bytes: Uint8Array; type?: string }[],
) {
  const form = new FormData();
  form.append("sku", sku);
  for (const f of files) form.append("photos", new Blob([f.bytes], { type: f.type ?? "" }), f.name);
  return call(s, "POST", "/api/v1/batches", form);
}

/** Polls the batch until every photo has its sizes, or the deadline passes. */
export async function waitBatch(s: Session, batchId: number, ms = 25_000) {
  const until = Date.now() + ms;
  for (;;) {
    const r = await call(s, "GET", `/api/v1/batches/${batchId}`);
    if (r.body?.batch?.finished || Date.now() > until) return r;
    await Bun.sleep(400);
  }
}

/** The width written in a WebP file's own header (lossy VP8, lossless VP8L or extended VP8X). */
export function webpWidth(b: Uint8Array): number {
  const tag = new TextDecoder().decode(b.slice(12, 16));
  if (tag === "VP8 ") return (b[26] | (b[27] << 8)) & 0x3fff;
  if (tag === "VP8L") return 1 + (b[21] | ((b[22] & 0x3f) << 8));
  if (tag === "VP8X") return 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
  throw new Error(`not a WebP file (${tag})`);
}

/** An anonymous GET: no cookie, no header — what a shop page's <img> does. */
export async function anonymous(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  return {
    status: res.status,
    type: res.headers.get("content-type"),
    bytes: new Uint8Array(await res.arrayBuffer()),
  };
}
