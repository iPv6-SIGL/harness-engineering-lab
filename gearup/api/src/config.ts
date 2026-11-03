// config.ts — every credential comes from OpenBao at boot (secret/gearup/*),
// never from the repo or the image. Waits for the store: the platform may be
// restarting when the container starts.

const VAULT_ADDR = Bun.env.VAULT_ADDR ?? "http://openbao.internal:8200";
const VAULT_TOKEN = Bun.env.VAULT_TOKEN ?? "root-dev-token";
const VAULT_PATH = Bun.env.VAULT_PATH ?? "secret/gearup";

export async function readSecret(name: string): Promise<Record<string, string>> {
  const [mount, ...rest] = VAULT_PATH.split("/");
  const url = `${VAULT_ADDR}/v1/${mount}/data/${[...rest, name].join("/")}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "X-Vault-Token": VAULT_TOKEN } });
      if (res.ok)
        return ((await res.json()) as { data: { data: Record<string, string> } }).data.data;
      if (res.status === 404)
        throw new Error(`${VAULT_PATH}/${name} is missing — run the provision job`);
    } catch (e) {
      if (attempt >= 30) throw e;
    }
    await Bun.sleep(1000);
  }
}

export type Config = {
  app: string;
  db: { url: string };
  /** secret/gearup/temporal, written by bootstrap.sh (TEMPORAL_NS=1, decision D2). */
  temporal: { address: string; namespace: string; taskQueue: string };
  oidc: {
    internalIssuer: string;
    publicIssuer: string;
    clientId: string;
    clientSecret: string;
    authorize: string;
    redirectUri: string;
  };
};

export async function loadConfig(): Promise<Config> {
  const [pg, temporal, oidc] = await Promise.all([
    readSecret("postgres"),
    readSecret("temporal"),
    readSecret("oidc"),
  ]);
  const host = Bun.env.DB_HOST ?? pg.host;
  const app = VAULT_PATH.split("/").pop() ?? "gearup";
  return {
    app,
    db: {
      url: `postgres://${pg.user}:${encodeURIComponent(pg.password)}@${host}:${pg.port}/${pg.database}`,
    },
    temporal: { address: temporal.address, namespace: temporal.namespace, taskQueue: app },
    oidc: {
      internalIssuer: oidc.issuer,
      publicIssuer: oidc.public_issuer,
      clientId: oidc.client_id,
      clientSecret: oidc.client_secret,
      authorize: oidc.authorize_endpoint,
      redirectUri: oidc.redirect_uri,
    },
  };
}
