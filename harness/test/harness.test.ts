import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { archiveGaps, mergeSpec } from "../src/archive";
import { checkBrief } from "../src/brief";
import { buildGraph, corePlatformDir } from "../src/catalog";
import { decide } from "../src/decide";
import { checkCommand, checkContent, checkTopology } from "../src/guards";
import { sites } from "../src/mutants";
import { type Brief, needTest, rx } from "../src/needs";
import { composeYml, gitlabCiYml, portBlock } from "../src/scaffold";

const HERE = import.meta.dir;
const g = buildGraph();
const brief = (v: number) => Bun.YAML.parse(readFileSync(join(HERE, `../briefs/deskbook.v${v}.yaml`), "utf8")) as Brief;

describe("capability graph (step 2)", () => {
  test("built from the platform's own files, every compose service priced", () => {
    expect(Object.keys(g.bricks).sort()).toEqual(["api", "apisix", "casdoor", "dozzle", "frontend", "openbao", "postgres", "registry", "s3", "temporal", "temporal-ui", "umami", "valkey", "worker"]);
    expect(g.bricks.temporal.container).toBe("temporal.internal");
    expect(g.bricks.casdoor.aliases).toContain("idp.internal");
    expect(g.bootstrap_flags).toEqual(["PUBLIC_BUCKET", "LLM_VKEY", "TEMPORAL_NS", "ANALYTICS_SITE"]);
  });
  test("a new container without a price breaks the build — it cannot slip in", () => {
    const core = mkdtempSync(join(tmpdir(), "core-"));
    cpSync(corePlatformDir(), core, { recursive: true, filter: (s) => !s.includes(".gitlab-ci-local") });
    const compose = join(core, "podman-compose.yml");
    writeFileSync(compose, readFileSync(compose, "utf8").replace(/\nservices:\n/, "\nservices:\n  kafka:\n    image: docker.io/apache/kafka:4.0.0\n"));
    expect(() => buildGraph(core)).toThrow(/'kafka' has no entry in catalog\/criteria.yaml/);
  });
});

describe("brief loop (steps 1–4)", () => {
  test("v1 scores 3/5 and asks at most three questions, each tied to a brick or a requirement", () => {
    const c = checkBrief(brief(1), g, 1);
    expect(c.score).toBe(3);
    expect(c.ready).toBe(false);
    expect(c.questions.map((q) => q.id)).toEqual(["R4-uploader", "R5-horizon", "data-desks-volume"]);
    for (const q of c.questions) expect(q.affects.length).toBeGreaterThan(0);
  });
  test("v2 is ready at 5/5", () => {
    expect(checkBrief(brief(2), g, 2)).toMatchObject({ score: 5, ready: true, questions: [] });
  });
  test("after the last round, the defaults are applied and listed", () => {
    const c = checkBrief(brief(1), g, 3);
    expect(c.ready).toBe(true);
    expect(c.defaults_applied.length).toBeGreaterThan(0);
  });
});

describe("need test and decisions (steps 3, 5)", () => {
  const bill = needTest(brief(2), g);
  test("DeskBook: 9 / 10, casdoor and s3 each paid by a requirement", () => {
    expect(bill.points).toBe(9);
    expect(bill.class).toBe("crud");
    expect(bill.bought.map((b) => [b.brick, b.paid_by])).toEqual([
      ["s3", ["R4"]],
      ["casdoor", ["R1", "R2", "R3", "R4", "R5"]],
    ]);
  });
  test("R5's weekly rule is refused for Valkey, the worker and Temporal, by name", () => {
    expect(bill.vetoed.map((v) => `${v.need}@${v.requirement}:${v.rule}`)).toEqual(["async-work@R5:V-read-time-recurrence", "durable-wait@R5:V-read-time-recurrence-only"]);
  });
  test("each decision compiles into a guard; D3 forbids the built-in Redis client too", () => {
    const d = decide(brief(2), bill, g);
    expect(d.map((x) => x.title)).toEqual(["Identity through casdoor (OIDC)", "Files in the app's S3 bucket, private", "No Valkey, no worker, no Temporal", "Nothing unasked"]);
    const d3 = d[2].guard;
    expect(d3.forbid_pattern).toContain("Bun\\.RedisClient");
    expect(d3.forbid_service).toEqual(["worker"]);
    expect(d3.witness.map((w) => w.probe)).toEqual(["valkey-keys", "temporal-namespace"]);
    expect(d[1].guard.forbid_flag).toEqual(["PUBLIC_BUCKET"]);
  });
  test("the scaffold is the bill: no worker, no REDIS_URL, every flag at 0", () => {
    const compose = composeYml(brief(2), bill);
    expect(compose).not.toMatch(/worker|REDIS_URL/);
    expect(compose).toContain("S3_BUCKET");
    const ci = Bun.YAML.parse(gitlabCiYml(brief(2), bill)) as any;
    expect([ci.variables.PUBLIC_BUCKET, ci.variables.LLM_VKEY, ci.variables.TEMPORAL_NS, ci.variables.ANALYTICS_SITE]).toEqual(["0", "0", "0", "0"]);
    expect(Object.keys(ci)).not.toContain("image-worker");
    expect(ci.provision.script.join("\n")).toContain("seed-test-users.sh \"$APP\" employee office-manager");
  });
});

describe("guards (steps 7, prevent + detect)", () => {
  const guards = decide(brief(2), needTest(brief(2), g), g).map((d) => d.guard);
  test("imports, built-in clients, env, package.json, flags and services are caught", () => {
    expect(checkContent(guards, "api/src/q.ts", 'import Redis from "ioredis";').map((v) => v.guard)).toEqual(["D3"]);
    expect(checkContent(guards, "api/src/q.ts", "const r = new Bun.RedisClient(url);")[0].match).toBe("Bun.RedisClient");
    expect(checkContent(guards, "api/src/q.ts", "const u = Bun.env.REDIS_URL;").some((v) => v.rule === "forbid_env")).toBe(true);
    expect(checkContent(guards, "api/package.json", JSON.stringify({ dependencies: { bullmq: "5" } }))[0].match).toBe("bullmq");
    expect(checkContent(guards, "api/src/llm.ts", 'await fetch("http://llm.internal:9080/v1/chat/completions")')[0].guard).toBe("D4");
    expect(checkContent(guards, "worker/src/main.ts", "export {}")[0].rule).toBe("forbid_path");
    expect(checkContent(guards, "api/src/ok.ts", 'import { SQL } from "bun"; const s3 = new Bun.S3Client({});')).toEqual([]);
  });
  test("shell installs of a forbidden package, and writes into .harness/", () => {
    expect(checkCommand(guards, "cd api && bun add ioredis@5")[0].match).toBe("bun add ioredis");
    expect(checkCommand(guards, "echo '{}' > .harness/ledger.json")[0].rule).toBe("protected");
    expect(checkCommand(guards, "bun add zod")).toEqual([]);
  });
  test("the hook refuses an edit that breaks D3 and quotes the decision back (exit 2)", () => {
    const app = resolve(HERE, "../../deskbook");
    const run = (input: object) => Bun.spawnSync(["bun", join(HERE, "../hooks/guard.ts")], { stdin: Buffer.from(JSON.stringify({ cwd: app, ...input })), stderr: "pipe" });
    const bad = run({ tool_name: "Edit", tool_input: { file_path: join(app, "api/src/server.ts"), old_string: 'import { S3Client } from "bun";', new_string: 'import { S3Client } from "bun";\nimport Redis from "ioredis";' } });
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr.toString()).toContain("D3 · No Valkey, no worker, no Temporal");
    expect(run({ tool_name: "Write", tool_input: { file_path: join(app, ".harness/ledger.json"), content: "{}" } }).exitCode).toBe(2);
    expect(run({ tool_name: "Write", tool_input: { file_path: join(app, "podman-compose.yml"), content: "" } }).exitCode).toBe(2);
    expect(run({ tool_name: "Edit", tool_input: { file_path: join(app, "api/src/domain.ts"), old_string: "export const MAX_REPEAT_WEEKS = 26;", new_string: "export const MAX_REPEAT_WEEKS = 26; // the brief's horizon" } }).exitCode).toBe(0);
    expect(run({ tool_name: "Bash", tool_input: { command: "cd api && bun add ioredis" } }).exitCode).toBe(2);
  });
  test("the topology check reads compose services and CI flags", () => {
    const app = mkdtempSync(join(tmpdir(), "app-"));
    writeFileSync(join(app, "podman-compose.yml"), "services:\n  api: {}\n  worker: {}\n");
    writeFileSync(join(app, ".gitlab-ci.yml"), 'variables:\n  TEMPORAL_NS: "1"\n');
    expect(checkTopology(guards, app).map((v) => `${v.rule}:${v.match}`)).toEqual(["forbid_service:worker", "forbid_flag:TEMPORAL_NS=1"]);
  });
});

describe("archive (step 15): decisions stay readable for the next change", () => {
  const bill = needTest(brief(2), g);
  const decisions = decide(brief(2), bill, g);
  test("every decision says when to reopen it and how it scales; every bought brick is decided", () => {
    for (const d of decisions) {
      expect(d.revisit_when.length).toBeGreaterThan(20);
      expect(d.scales_by.length).toBeGreaterThan(10);
    }
    expect(decisions[2].revisit_when).toContain("side effect");
    expect(archiveGaps(decisions, ["D1", "D2", "D3", "D4"], ["casdoor", "s3"])).toEqual([]);
  });
  test("a decision without revisit_when, or an undecided brick, is not archivable", () => {
    const broken = decisions.map((d) => (d.id === "D3" ? { ...d, revisit_when: "" } : d));
    expect(archiveGaps(broken, ["D1", "D2", "D3", "D4", "D9"], ["casdoor", "s3", "registry"])).toEqual(["D3 has no revisit_when", "guard D9 has no decision", "bought brick registry is named by no decision"]);
  });
  test("the living spec merges deltas: same R-id replaced, new ones appended", () => {
    const v1 = mergeSpec(null, "## ADDED Requirements\n\n### Requirement: R1 Book\n\nold\n\n### Requirement: R2 Login\n\nx\n", "app");
    const v2 = mergeSpec(v1, "## ADDED Requirements\n\n### Requirement: R1 Book\n\nnew\n\n### Requirement: R6 Visitors\n\ny\n", "app");
    expect(v2.match(/### Requirement: R\d/g)).toEqual(["### Requirement: R1", "### Requirement: R2", "### Requirement: R6"]);
    expect(v2).toContain("new");
    expect(v2).not.toContain("old");
  });
});

describe("ports and French briefs (audit findings)", () => {
  test("a port block already used by a sibling app is refused; none requested → the first free one", () => {
    const root = mkdtempSync(join(tmpdir(), "apps-"));
    for (const [app, port] of [["a", 8000], ["b", 8010]] as const) {
      mkdirSync(join(root, app));
      writeFileSync(join(root, app, ".gitlab-ci.yml"), `variables:\n  FRONTEND_PORT: "${port}"\n`);
    }
    const app = join(root, "c");
    expect(() => portBlock(app, 8010)).toThrow(/already b's/);
    expect(() => portBlock(app, 8015)).toThrow(/multiple of 10/);
    expect(portBlock(app)).toBe(8020);
    expect(portBlock(join(root, "b"), 8010)).toBe(8010); // an app keeps its own block on re-plan
  });
  test("accented words are whole words: the French brief is read like the English one", () => {
    expect(rx("\\bsanté\\b").test("les données de santé des patients")).toBe(true);
    expect(rx("\\b(upload\\w*|téléverse\\w*)\\b").test("les responsables téléversent")).toBe(true);
    expect(rx("\\bsanté\\b").test("santéx")).toBe(false);
    expect(rx("([\\w-]+ ){0,3}x").test("a-b c x")).toBe(true);
  });
  test("the hook checks a command run from the repo root against the app it names", () => {
    const repo = resolve(HERE, "../..");
    const r = Bun.spawnSync(["bun", join(HERE, "../hooks/guard.ts")], { stdin: Buffer.from(JSON.stringify({ cwd: repo, tool_name: "Bash", tool_input: { command: "cd deskbook/api && bun add ioredis" } })), stderr: "pipe" });
    expect(r.exitCode).toBe(2);
    const ok = Bun.spawnSync(["bun", join(HERE, "../hooks/guard.ts")], { stdin: Buffer.from(JSON.stringify({ cwd: repo, tool_name: "Bash", tool_input: { command: "cd harness && bun add zod" } })) });
    expect(ok.exitCode).toBe(0);
  });
});

describe("mutants (step 10)", () => {
  test("operators inside strings and comments are not mutated", () => {
    const s = sites('const a = b === 1; // x === y\nconst t = "<=";');
    expect(s.map((x) => x.op)).toEqual(["equality", "number"]);
  });
});

describe("MCP platform server (step 2)", () => {
  test("initialize, tools/list, then need_test vetoes a read-time recurrence", async () => {
    const p = Bun.spawn(["bun", join(HERE, "../mcp/platform/server.ts")], { stdin: "pipe", stdout: "pipe" });
    const msgs = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "need_test", arguments: { text: "A booking can repeat every week until an end date." } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "price", arguments: { bricks: ["casdoor", "s3"] } } },
    ];
    p.stdin.write(`${msgs.map((m) => JSON.stringify(m)).join("\n")}\n`);
    p.stdin.end();
    const lines = (await new Response(p.stdout).text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.id)).toEqual([1, 2, 3, 4]);
    expect(lines[1].result.tools.map((t: { name: string }) => t.name)).toEqual(["list_bricks", "explain", "price", "need_test"]);
    const nt = JSON.parse(lines[2].result.content[0].text);
    expect(nt.would_buy).toEqual([]);
    expect(nt.vetoed.map((v: { rule: string }) => v.rule)).toEqual(["V-read-time-recurrence", "V-read-time-recurrence-only"]);
    expect(JSON.parse(lines[3].result.content[0].text)).toMatchObject({ total: 9, budget: 10, within_budget: true });
  });
});
