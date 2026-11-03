// e2e/lib.ts — the scenarios log in AS A PERSONA through the real OIDC flow:
// the credentials come from secret/gearup/test-users (seeded by the platform),
// never from the platform admin and never from a bypass route.
const BAO = process.env.BAO_ADDR ?? "http://localhost:8200";
const TOKEN = process.env.BAO_TOKEN ?? "root-dev-token";
export const APP = process.env.APP ?? "gearup";
export const BASE = process.env.GEARUP_URL ?? "http://localhost:8030";
export const API = process.env.GEARUP_API ?? "http://localhost:8031";
const IDP = process.env.IDP_URL ?? "http://localhost:9300";

export async function secret(name: string): Promise<Record<string, string>> {
  const res = await fetch(`${BAO}/v1/secret/data/${APP}/${name}`, {
    headers: { "X-Vault-Token": TOKEN },
  });
  if (!res.ok) throw new Error(`secret/${APP}/${name}: HTTP ${res.status}`);
  return ((await res.json()) as { data: { data: Record<string, string> } }).data.data;
}

export type Session = { cookie: string; persona: string };

export async function login(persona: "employee" | "manager"): Promise<Session> {
  const users = await secret("test-users");
  // 1. the app starts the flow and remembers a state
  const start = await fetch(`${BASE}/auth/login`, { redirect: "manual" });
  const authorize = new URL(start.headers.get("location") ?? "");
  const q = authorize.searchParams;
  // 2. the persona signs in at the IdP (what the Casdoor login page posts)
  const params = new URLSearchParams({
    clientId: q.get("client_id") ?? "",
    responseType: "code",
    redirectUri: q.get("redirect_uri") ?? "",
    type: "code",
    scope: q.get("scope") ?? "",
    state: q.get("state") ?? "",
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

export async function call(s: Session | null, method: string, path: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: { ...(s ? { Cookie: s.cookie } : {}) },
    signal: AbortSignal.timeout(15_000), // a scenario fails, it never hangs
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null; // nginx's HTML on a 502
  }
  return { status: res.status, body: json, raw: text };
}

/** Polls a request until `done(status)` or the deadline: the workflow moves it on its own. */
export async function waitStatus(
  s: Session,
  id: number,
  done: (status: string) => boolean,
  ms = 20_000,
) {
  const until = Date.now() + ms;
  for (;;) {
    const r = await call(s, "GET", `/api/v1/requests/${id}`);
    if ((r.status === 200 && done(r.body.request.status)) || Date.now() > until) return r;
    await Bun.sleep(300);
  }
}

/** The workflow's own history, read from Temporal (the CLI inside the platform container). */
export function history(workflowId: string): string {
  const p = Bun.spawnSync([
    "podman",
    "exec",
    "temporal.internal",
    "sh",
    "-c",
    `temporal workflow show -w ${workflowId} -n ${APP} --output json --address $(hostname -i):7233`,
  ]);
  return `${p.stdout}${p.stderr}`;
}

/** Restarts a container and waits until its health port answers again. */
export async function restart(container: string, readyUrl: string) {
  if (Bun.spawnSync(["podman", "restart", "-t", "10", container]).exitCode !== 0)
    throw new Error(`podman restart ${container} failed`);
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(readyUrl, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      // not up yet: the container is still starting
    }
    await Bun.sleep(500);
  }
  throw new Error(`${container} not ready after restart`);
}
