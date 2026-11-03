// worker.ts — decision D2: polls the `gearup` task queue in the app's own
// namespace (secret/gearup/temporal, created by bootstrap.sh with TEMPORAL_NS=1).
// Holds no state: a request that waits lives in Temporal's history, so this
// process can restart at any time. Health on :8081; SIGTERM drains and exits.
import { NativeConnection, Worker } from "@temporalio/worker";
import { SQL } from "bun";
import { activities } from "./activities";

const VAULT_ADDR = Bun.env.VAULT_ADDR ?? "http://openbao.internal:8200";
const VAULT_TOKEN = Bun.env.VAULT_TOKEN ?? "root-dev-token";
const VAULT_PATH = Bun.env.VAULT_PATH ?? "secret/gearup";
const APP = VAULT_PATH.split("/").pop() ?? "gearup";

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

async function connectTemporal(address: string): Promise<NativeConnection> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await NativeConnection.connect({ address });
    } catch (e) {
      if (attempt >= 30) throw e;
      await Bun.sleep(1000);
    }
  }
}

const [pg, temporal] = await Promise.all([readSecret("postgres"), readSecret("temporal")]);
const sql = new SQL({
  url: `postgres://${pg.user}:${encodeURIComponent(pg.password)}@${Bun.env.DB_HOST ?? pg.host}:${pg.port}/${pg.database}`,
  max: 4,
});
const connection = await connectTemporal(temporal.address);
const worker = await Worker.create({
  connection,
  namespace: temporal.namespace,
  taskQueue: APP,
  workflowsPath: new URL("./workflows.ts", import.meta.url).pathname,
  activities: activities(sql),
  shutdownGraceTime: "5 seconds",
});

const health = Bun.serve({
  port: 8081,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/health") return Response.json({ status: "ok", worker: worker.getState() });
    if (path === "/ready") {
      try {
        await sql`SELECT 1`;
        if (worker.getState() !== "RUNNING") throw new Error(`worker ${worker.getState()}`);
        return Response.json({ status: "ready" });
      } catch (e) {
        return Response.json({ status: "not-ready", error: String(e) }, { status: 503 });
      }
    }
    return Response.json({ error: { code: "not-found", message: path } }, { status: 404 });
  },
});

log("info", `gearup worker polling task queue ${APP} in namespace ${temporal.namespace}`);
const running = worker.run();

process.on("SIGTERM", async () => {
  log("info", "SIGTERM: draining the activities in hand");
  worker.shutdown();
  await running;
  await health.stop();
  await connection.close();
  await sql.close({ timeout: 2 });
  process.exit(0);
});

await running;
