// e2e/lib.ts — the scenarios log in AS A PERSONA through the real OIDC flow:
// the credentials come from secret/deskbook/test-users (seeded by the platform),
// never from the platform admin and never from a bypass route.
const BAO = process.env.BAO_ADDR ?? "http://localhost:8200";
const TOKEN = process.env.BAO_TOKEN ?? "root-dev-token";
export const APP = process.env.APP ?? "deskbook";
export const BASE = process.env.DESKBOOK_URL ?? "http://localhost:8010";
export const API = process.env.DESKBOOK_API ?? "http://localhost:8011";
const IDP = process.env.IDP_URL ?? "http://localhost:9300";

export async function secret(name: string): Promise<Record<string, string>> {
  const res = await fetch(`${BAO}/v1/secret/data/${APP}/${name}`, {
    headers: { "X-Vault-Token": TOKEN },
  });
  if (!res.ok) throw new Error(`secret/${APP}/${name}: HTTP ${res.status}`);
  return ((await res.json()) as { data: { data: Record<string, string> } }).data.data;
}

export type Session = { cookie: string; persona: string };

export async function login(persona: "employee" | "office-manager"): Promise<Session> {
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
    signal: AbortSignal.timeout(10_000), // a scenario fails, it never hangs
  };
  if (body instanceof Uint8Array) init.body = body;
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

/** A random far-future Monday, so reruns never collide with earlier bookings. */
export function freshMonday(): string {
  const base = Date.UTC(2031 + Math.floor(Math.random() * 40), 0, 6); // 6 Jan, then the next Monday
  const d = new Date(base + Math.floor(Math.random() * 300) * 86_400_000);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
}

export const plus = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export async function deskByLabel(s: Session, label: string, day: string, half = "am") {
  const floor = Number(label.match(/^F(\d)/)![1]);
  const r = await call(s, "GET", `/api/v1/resources?floor=${floor}&day=${day}&half=${half}`);
  return (r.body.resources as any[]).find((x) => x.label === label);
}
