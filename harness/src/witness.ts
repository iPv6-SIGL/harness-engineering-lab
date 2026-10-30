// witness.ts — PROVE (step 11). Every app has its own DB user, secret path,
// bucket key, key prefix, virtual key and namespace, so every access it makes is
// attributable, for free. Each decision states what the trails must show; one
// failing claim blocks the merge, whatever the tests say.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { corePlatformDir } from "./catalog";
import type { Guard } from "./decide";

export type Evidence = { claim: string; decision: string; probe: string; expect: string; observed: string; ok: boolean };

function sh(cmd: string): { code: number; out: string } {
  const p = Bun.spawnSync(["bash", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: `${p.stdout.toString()}${p.stderr.toString()}`.trim() };
}
const bao = (args: string) => sh(`podman exec -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN=root-dev-token openbao.internal bao ${args}`);
const httpCode = (url: string) => sh(`curl -s -o /dev/null -w '%{http_code}' -m 5 '${url}'`).out;

type Ctx = { app: string; apiPort: number; frontendPort: number };

const PROBES: Record<string, (c: Ctx, detail?: string) => { observed: string; present: boolean }> = {
  "valkey-keys": ({ app }) => {
    const r = sh(`podman exec valkey.internal valkey-cli --scan --pattern '${app}:*' | wc -l`);
    const n = Number.parseInt(r.out, 10) || 0;
    return { observed: `${n} keys ${app}:*`, present: n > 0 };
  },
  "temporal-namespace": ({ app }) => {
    const r = sh(`podman exec temporal.internal sh -c 'temporal operator namespace describe -n ${app} --address $(hostname -i):7233' 2>&1`);
    return { observed: r.code === 0 ? `namespace ${app} exists` : `no namespace ${app}`, present: r.code === 0 };
  },
  "llm-consumer": ({ app }) => {
    const vkey = bao(`kv get -field=${app} secret/core/llm-vkeys`).code === 0;
    const yamlPath = join(corePlatformDir(), "apisix", "apisix.yaml");
    const consumer = existsSync(yamlPath) && new RegExp(`username:\\s*"?${app}"?\\b`).test(readFileSync(yamlPath, "utf8"));
    return { observed: `${vkey ? "a" : "no"} vkey in secret/core/llm-vkeys, ${consumer ? "a" : "no"} APISIX consumer ${app}`, present: vkey || consumer };
  },
  "analytics-site": ({ app }) => {
    const r = bao(`kv get secret/${app}/analytics`);
    return { observed: r.code === 0 ? `secret/${app}/analytics exists` : `no secret/${app}/analytics`, present: r.code === 0 };
  },
  "secret-read": ({ app }, detail) => {
    // Reads of the path in OpenBao's audit device, FROM the api container's IP.
    const ip = sh(`podman inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${app}-api`).out;
    const path = (detail ?? `secret/${app}/oidc`).replace(/^secret\//, "secret/data/");
    const log = Bun.spawnSync(["podman", "exec", "openbao.internal", "cat", "/openbao/logs/audit.log"]).stdout.toString();
    let n = 0;
    for (const line of log.split("\n")) {
      if (!line.includes(path)) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === "request" && e.request?.path === path && e.request?.operation === "read" && e.request?.remote_address === ip) n++;
      } catch {}
    }
    return { observed: `${n} audit reads of ${path} from ${app}-api (${ip || "no ip"})`, present: n > 0 };
  },
  "s3-anonymous": ({ app }) => {
    // A 403 alone proves nothing (a missing bucket answers 403 too): the bucket
    // must exist and hold objects, AND refuse them to an anonymous reader.
    const list = sh(`podman exec -i s3 sh -c "echo 's3.bucket.list' | weed shell -master=localhost:9333" 2>/dev/null`).out;
    const line = list.split("\n").find((l) => l.trim().split(/\s+/)[0] === app) ?? "";
    const objects = Number(line.match(/chunk:(\d+)/)?.[1] ?? line.match(/size:(\d+)/)?.[1] ?? 0);
    const codes = [`/${app}/`, `/${app}/floors/1`, `/${app}/floors/2`].map((p) => httpCode(`http://localhost:9000${p}`));
    if (!line) return { observed: `no bucket ${app}: nothing to prove`, present: true };
    return { observed: `bucket ${app} exists (${line.trim().split(/\s+/).slice(1, 3).join(" ")}${objects ? "" : ", empty"}); anonymous GET → ${codes.join(", ")}`, present: codes.includes("200") || objects === 0 };
  },
};

export function contractClaims(c: Ctx): Evidence[] {
  const out: Evidence[] = [];
  const ready = httpCode(`http://localhost:${c.apiPort}/ready`);
  out.push({ claim: "/ready answers 200", decision: "contract", probe: "http", expect: "200", observed: `GET :${c.apiPort}/ready → ${ready}`, ok: ready === "200" });
  const front = httpCode(`http://localhost:${c.frontendPort}/`);
  out.push({ claim: "frontend serves /", decision: "contract", probe: "http", expect: "200", observed: `GET :${c.frontendPort}/ → ${front}`, ok: front === "200" });
  const pg = sh(`podman exec -e PGPASSWORD=postgres-dev-password postgres.internal psql -U postgres -tAc "SELECT count(*) FROM pg_stat_activity WHERE usename='${c.app}'"`);
  const sessions = Number.parseInt(pg.out, 10) || 0;
  out.push({ claim: `the api connects as DB user ${c.app}`, decision: "contract", probe: "pg_stat_activity", expect: "≥ 1", observed: `${sessions} sessions of ${c.app}`, ok: sessions > 0 });
  const logs = sh(`podman logs --tail 50 ${c.app}-api 2>&1 | wc -l`);
  out.push({ claim: "logs on stdout (Dozzle)", decision: "contract", probe: "podman logs", expect: "> 0 lines", observed: `${logs.out} lines`, ok: Number(logs.out) > 0 });
  // SIGTERM: drain and exit under 10 s, then come back.
  const t0 = Date.now();
  sh(`podman stop -t 10 ${c.app}-api`);
  const secs = (Date.now() - t0) / 1000;
  const exit = sh(`podman inspect -f '{{.State.ExitCode}}' ${c.app}-api`).out;
  sh(`podman start ${c.app}-api`);
  for (let i = 0; i < 40 && httpCode(`http://localhost:${c.apiPort}/ready`) !== "200"; i++) Bun.sleepSync(500);
  out.push({ claim: "SIGTERM: drain and exit < 10 s", decision: "contract", probe: "podman stop", expect: "< 10 s, exit 0|143", observed: `${secs.toFixed(1)} s, exit ${exit}`, ok: secs < 10 && (exit === "0" || exit === "143") });
  return out;
}

export function witness(guards: Guard[], c: Ctx): Evidence[] {
  const out: Evidence[] = [];
  for (const g of guards) {
    for (const w of g.witness) {
      const probe = PROBES[w.probe];
      if (!probe) {
        out.push({ claim: `${w.probe} ${w.expect}`, decision: `${g.id} · ${g.decision}`, probe: w.probe, expect: w.expect, observed: "no such probe", ok: false });
        continue;
      }
      const r = probe(c, w.detail);
      const ok = w.expect === "present" ? r.present : !r.present; // "absent" | "denied"
      out.push({ claim: `${w.probe} ${w.expect}${w.detail ? ` (${w.detail})` : ""}`, decision: `${g.id} · ${g.decision}`, probe: w.probe, expect: w.expect, observed: r.observed, ok });
    }
  }
  return [...out, ...contractClaims(c)];
}
