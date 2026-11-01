// auth.ts — decision D1: identity through casdoor (OIDC). No users table, no
// password, no login screen: the authorization-code flow, the token verified
// against the IdP's JWKS (WebCrypto, no library), roles from the persona groups,
// then a server-side session.
import type { Config } from "./config";
import type { Db } from "./db";
import { rolesFromGroups } from "./domain";

export type User = { sub: string; name: string; roles: string[] };
const SESSION_HOURS = 8;
const COOKIE = "deskbook_session";

const b64url = (s: string) =>
  Uint8Array.from(
    atob(
      s
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(s.length / 4) * 4, "="),
    ),
    (c) => c.charCodeAt(0),
  );
const randomToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

let jwks: { keys: (JsonWebKey & { kid: string })[] } | null = null;

async function verifyJwt(token: string, cfg: Config): Promise<Record<string, unknown>> {
  const [h, p, s] = token.split(".");
  const header = JSON.parse(new TextDecoder().decode(b64url(h)));
  jwks ??= await (await fetch(`${cfg.oidc.internalIssuer}/.well-known/jwks`)).json();
  const jwk = jwks?.keys.find((k) => k.kid === header.kid);
  if (!jwk || header.alg !== "RS256") throw new Error("unknown signing key");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64url(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new Error("bad signature");
  const claims = JSON.parse(new TextDecoder().decode(b64url(p)));
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== cfg.oidc.publicIssuer)
    throw new Error(`issuer ${claims.iss} is not ${cfg.oidc.publicIssuer}`);
  if (!aud.includes(cfg.oidc.clientId)) throw new Error("token not issued for this client");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now())
    throw new Error("token expired");
  return claims;
}

export async function loginRedirect(sql: Db, cfg: Config): Promise<Response> {
  const state = randomToken();
  await sql`DELETE FROM oauth_states WHERE created_at < now() - interval '10 minutes'`;
  await sql`INSERT INTO oauth_states (state) VALUES (${state})`;
  const q = new URLSearchParams({
    client_id: cfg.oidc.clientId,
    response_type: "code",
    redirect_uri: cfg.oidc.redirectUri,
    scope: "openid profile",
    state,
  });
  return new Response(null, { status: 302, headers: { Location: `${cfg.oidc.authorize}?${q}` } });
}

export async function callback(sql: Db, cfg: Config, url: URL): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const known =
    await sql`DELETE FROM oauth_states WHERE state = ${state} AND created_at > now() - interval '10 minutes' RETURNING state`;
  if (!code || known.length === 0)
    throw new HttpError(400, "invalid-state", "unknown or expired login attempt");
  const res = await fetch(`${cfg.oidc.internalIssuer}/api/login/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: cfg.oidc.clientId,
      client_secret: cfg.oidc.clientSecret,
      redirect_uri: cfg.oidc.redirectUri,
    }),
  });
  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!body.access_token)
    throw new HttpError(401, "login-failed", body.error ?? "the IdP refused the code");
  const claims = await verifyJwt(body.access_token, cfg);
  const roles = rolesFromGroups((claims.groups as string[]) ?? [], cfg.app);
  if (roles.length === 0)
    throw new HttpError(403, "no-role", "this account has no DeskBook persona");
  const token = randomToken();
  await sql`INSERT INTO sessions (token, sub, name, roles, expires_at)
            VALUES (${token}, ${String(claims.sub)}, ${String(claims.name)}, string_to_array(${roles.join(",")}, ','), now() + make_interval(hours => ${SESSION_HOURS}))`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}`,
    },
  });
}

export async function currentUser(sql: Db, req: Request): Promise<User | null> {
  const cookie = req.headers.get("cookie") ?? "";
  const token = cookie.match(new RegExp(`${COOKIE}=([a-f0-9]{64})`))?.[1];
  if (!token) return null;
  const [s] =
    await sql`SELECT sub, name, array_to_string(roles, ',') AS roles FROM sessions WHERE token = ${token} AND expires_at > now()`;
  return s ? { sub: s.sub, name: s.name, roles: String(s.roles).split(",") } : null;
}

export async function logout(sql: Db, req: Request): Promise<Response> {
  const token = (req.headers.get("cookie") ?? "").match(
    new RegExp(`${COOKIE}=([a-f0-9]{64})`),
  )?.[1];
  if (token) await sql`DELETE FROM sessions WHERE token = ${token}`;
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0` },
  });
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
