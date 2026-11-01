// vibe/measure.ts — what an agent WITHOUT the harness really built, measured with
// the harness's own catalog. Reads a delivered app directory (no run, no LLM):
//   bricks found  = catalog fingerprints (imports, patterns, env, flags, services)
//                   + compose images/commands (an agent may name a service anything)
//   bill          = what the need test says the same brief pays for
//   unpaid        = found − paid − scaffold     (over-engineering)
//   missing       = paid − found                (under-building: the brief needed it)
//   points        = scaffold + ops points of every brick found
//
//   bun harness/evals/vibe/measure.ts <app-dir> <brief.yaml> [--guards <app>/.harness/guards] [--json]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { buildGraph, type Graph } from "../../src/catalog";
import { checkContent, checkTopology, loadGuards } from "../../src/guards";
import { type Brief, needTest, ownedBricks } from "../../src/needs";

const SKIP_FILES = new Set(["bootstrap.sh", "biome.json", "bun.lock", "bun.lockb", "package-lock.json"]); // CCoE templates copied verbatim, as the guards treat them
const SKIP = new Set(["node_modules", "artifacts", "dist", "openspec", "e2e"]); // plus every dot-directory: .harness, .git, .gitlab-ci-local hold evidence, not runtime code
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|ya?ml|html|conf|sh|py|toml|env|md)$|(^|\/)(Dockerfile|Containerfile)[^/]*$/;

export type Found = { brick: string; evidence: string[] };
export type Measure = {
  app: string;
  files: number;
  services: { name: string; image?: string }[];
  found: Found[];
  bill: { class: string; budget: number; points: number; owned: string[] };
  points: number;
  unpaid: string[];
  missing: string[];
  overPoints: number;
  violations: string[];
};

function walk(root: string): string[] {
  const out: string[] = [];
  const rec = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) {
        if (!SKIP.has(n) && !n.startsWith(".")) rec(p);
      } else if (TEXT.test(p.split(sep).join("/")) && !/\.(test|spec)\./.test(n) && !SKIP_FILES.has(n) && statSync(p).size < 400_000) out.push(p);
    }
  };
  rec(root);
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** A comment is not a brick: "No OIDC yet" must not count as identity. */
function stripComments(path: string, body: string): string {
  if (/\.(ts|tsx|js|mjs|cjs)$/.test(path)) return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
  if (/\.(ya?ml|sh|toml|conf)$/.test(path) || /(^|\/)(Dockerfile|Containerfile)/.test(path)) return body.replace(/^\s*#.*$/gm, "").replace(/\s#\s.*$/gm, "");
  if (/\.md$/.test(path)) return "";
  return body;
}

export function measure(appDir: string, brief: Brief, g: Graph, guardsDir?: string): Measure {
  const files = walk(appDir);
  const texts = files.map((f) => ({ rel: relative(appDir, f).split(sep).join("/"), body: stripComments(f, readFileSync(f, "utf8")) }));
  // compose topology
  const services: Measure["services"] = [];
  for (const t of texts.filter((x) => /(^|\/)(podman-)?(docker-)?compose[^/]*\.ya?ml$/.test(x.rel))) {
    try {
      const y = Bun.YAML.parse(t.body) as any;
      for (const [name, s] of Object.entries<any>(y?.services ?? {})) services.push({ name, image: s?.image });
    } catch {}
  }
  const hits = new Map<string, Set<string>>();
  const add = (b: string, e: string) => hits.set(b, (hits.get(b) ?? new Set()).add(e));
  for (const [name, b] of Object.entries(g.bricks)) {
    if (b.scaffold || name === "casdoor") continue; // casdoor has its own, stricter detector below
    const fp = b.fingerprints ?? {};
    for (const s of fp.service ?? []) for (const sv of services) if (sv.name === s) add(name, `compose service ${sv.name}`);
    for (const i of fp.imports ?? []) {
      const re = new RegExp(`(from\\s+|require\\(\\s*|import\\(\\s*)['"]${esc(i)}(\\/[^'"]*)?['"]|"${esc(i)}"\\s*:`);
      for (const t of texts) if (re.test(t.body)) add(name, `${t.rel}: ${i}`);
    }
    for (const p of fp.patterns ?? []) {
      const re = new RegExp(p, "i");
      for (const t of texts) {
        if (/(^|\/)README/i.test(t.rel)) continue;
        const m = t.body.match(re);
        if (m) add(name, `${t.rel}: ${m[0]}`);
      }
    }
    for (const e of fp.env ?? []) for (const t of texts) if (new RegExp(`\\b${e}\\b`).test(t.body) && !/README/i.test(t.rel)) add(name, `${t.rel}: ${e}`);
    for (const p of fp.paths ?? []) for (const t of texts) if (t.rel.startsWith(p) || t.rel.includes(`/${p}`)) add(name, `${t.rel}`);
  }
  // an agent may name things freely: read the compose images / commands too
  for (const sv of services) {
    const id = `${sv.name} ${sv.image ?? ""}`;
    if (/valkey|redis/i.test(id)) add("valkey", `compose service ${sv.name} (${sv.image ?? "?"})`);
    if (/temporal/i.test(id) && !/ui/i.test(id)) add("temporal", `compose service ${sv.name}`);
    if (/temporal.*ui|temporalio\/ui/i.test(id)) add("temporal-ui", `compose service ${sv.name}`);
    if (/worker|consumer|renderer|processor|queue/i.test(sv.name)) add("worker", `compose service ${sv.name}`);
    if (/apisix|llm/i.test(sv.name)) add("apisix", `compose service ${sv.name}`);
  }
  // casdoor = the IdP really called by the code: its host, the code flow, or a token verified
  const IDP = /\b(redirect[_-]?uri|client[_-]?secret|authorize[_-]?endpoint|public[_-]?issuer|jwks(_uri)?|id_token|access_token|authorization_code|idp\.internal|casdoor\.internal|openid-client)\b|\.well-known\/|(secret|vaultRead|vault_read|readSecret)\s*\(\s*['"`]oidc['"`]/i;
  for (const t of texts) if (IDP.test(t.body) && /\.(ts|js|json|ya?ml|html)$/.test(t.rel)) add("casdoor", `${t.rel}: ${t.body.match(IDP)![0]}`);
  // s3 = an object store client or the S3 env
  for (const t of texts) if (/\b(S3Client|aws-sdk\/client-s3|S3_ENDPOINT|s3\.internal|presign)\b/i.test(t.body) && !/README/i.test(t.rel)) add("s3", `${t.rel}: s3`);
  // a temporal workflow needs its worker: the harness prices them together
  if (hits.has("temporal") && !hits.has("temporal-ui")) add("temporal-ui", "console shipped with the Temporal stack");

  const bill = needTest(brief, g);
  const owned = new Set(ownedBricks(bill));
  const scaffold = new Set(Object.values(g.bricks).filter((b) => b.scaffold).map((b) => b.brick));
  const found = [...hits.entries()].map(([brick, ev]) => ({ brick, evidence: [...ev].slice(0, 3) }));
  const foundSet = new Set(found.map((f) => f.brick));
  const unpaid = [...foundSet].filter((b) => !owned.has(b) && !scaffold.has(b));
  const missing = [...owned].filter((b) => !foundSet.has(b) && !scaffold.has(b));
  const scaffoldPts = [...scaffold].reduce((s, b) => s + g.bricks[b].ops_points, 0);
  const points = scaffoldPts + [...foundSet].filter((b) => !scaffold.has(b)).reduce((s, b) => s + g.bricks[b].ops_points, 0);
  const overPoints = unpaid.reduce((s, b) => s + g.bricks[b].ops_points, 0);
  const violations: string[] = [];
  if (guardsDir && existsSync(guardsDir)) {
    const guards = loadGuards(resolve(guardsDir, "..", ".."));
    for (const t of texts) for (const v of checkContent(guards, t.rel, t.body)) violations.push(`${v.guard} ${v.rule} ${t.rel}: ${v.match}`);
    for (const v of checkTopology(guards, appDir)) violations.push(`${v.guard} ${v.rule} ${v.file}: ${v.match}`);
  }
  return {
    app: appDir, files: files.length, services, found, bill: { class: bill.class, budget: bill.budget, points: bill.points, owned: [...owned] },
    points, unpaid, missing, overPoints, violations,
  };
}

if (import.meta.main) {
  const [appDir, briefPath, ...rest] = process.argv.slice(2);
  const gi = rest.indexOf("--guards");
  const g = buildGraph(resolve(import.meta.dir, "..", "..", "..", "core-platform"));
  const brief = Bun.YAML.parse(readFileSync(briefPath, "utf8")) as Brief;
  const m = measure(resolve(appDir), brief, g, gi >= 0 ? resolve(rest[gi + 1]) : undefined);
  if (rest.includes("--json")) console.log(JSON.stringify(m, null, 2));
  else {
    console.log(`${m.app} · ${m.files} files · ${m.services.length} compose services: ${m.services.map((s) => s.name).join(", ")}`);
    console.log(`found    : ${m.found.map((f) => f.brick).join(", ") || "—"}`);
    console.log(`paid     : ${m.bill.owned.join(", ") || "—"}   (class ${m.bill.class}, bill ${m.bill.points}/${m.bill.budget})`);
    console.log(`unpaid   : ${m.unpaid.join(", ") || "—"}   (+${m.overPoints} pts)`);
    console.log(`missing  : ${m.missing.join(", ") || "—"}`);
    console.log(`points   : ${m.points}   vs harness ${m.bill.points}   budget ${m.bill.budget}${m.points > m.bill.budget ? "  ✗ OVER BUDGET" : ""}`);
    console.log(`guards   : ${m.violations.length} violation(s)${m.violations.length ? "\n  " + m.violations.slice(0, 8).join("\n  ") : ""}`);
  }
}
