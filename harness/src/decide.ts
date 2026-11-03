// decide.ts — step 5: the decision log and its guards. Every bought need and
// every refused need becomes a decision that names the requirement it serves,
// what it rejects and the compute it avoids — and compiles into a GUARD that the
// hook (prevent), the fitness job (detect) and the witness (prove) enforce.
import type { Fingerprints, Graph } from "./catalog";
import type { Bill, Brief } from "./needs";

export type Claim = { probe: string; expect: string; detail?: string };
export type Guard = {
  id: string;
  decision: string;
  serves: string[];
  owner: string;
  forbid_import: string[];
  forbid_pattern: string[];
  forbid_env: string[];
  forbid_service: string[];
  forbid_path: string[];
  forbid_flag: string[];
  witness: Claim[];
};
export type Decision = {
  id: string;
  title: string;
  serves: string[];
  chose: string;
  rejected: string;
  avoids: string;
  /** The signal that reopens this decision — what a future change must say to buy (or drop) the brick. */
  revisit_when: string;
  /** How the app scales without reopening the decision, and where that stops. */
  scales_by: string;
  /** The bricks this decision buys or keeps out. */
  bricks: string[];
  guard: Guard;
};

type Template = { title: string; chose: string; rejected: string; avoids: string; revisit_when: string; scales_by: string };

// What each need-decision chooses, rejects, avoids — and when it must be reopened. Wording is the doctrine's.
const BOUGHT: Record<string, Template> = {
  identity: {
    title: "Identity through casdoor (OIDC)",
    chose: "one OIDC client, one group per persona, roles checked server-side",
    rejected: "a users table in the app (a second user store)",
    avoids: "password storage, reset flows, a login screen to secure",
    revisit_when: "a persona must act without a company account (visitors, partners) — that is a new persona and a new group, not a users table",
    scales_by: "sessions live in Postgres, so any API replica serves any user; the IdP is shared and scales with the platform",
  },
  "blob-storage": {
    title: "Files in the app's S3 bucket",
    chose: "the app's bucket with its scoped key, streamed through the API",
    rejected: "files as Postgres blobs",
    avoids: "bloated backups and DB reads on every page",
    revisit_when: "a requirement serves the files to anonymous browsers (public-media → PUBLIC_BUCKET=1), or the files need processing (async-work)",
    scales_by: "the object store holds the bytes, the API only streams them; past ~50 requests/s of downloads, serve signed URLs instead of streaming",
  },
  "public-media": {
    title: "Anonymous read on the app's bucket only",
    chose: "PUBLIC_BUCKET=1 — browsers load the files directly",
    rejected: "proxying every image through the API",
    avoids: "an API round-trip and its CPU per image view",
    revisit_when: "a file in the bucket must stay private — split it into a second, private prefix with its own decision",
    scales_by: "browsers hit the object store directly; the API is out of the read path",
  },
  "async-work": {
    title: "Background work on a Valkey stream drained by a worker",
    chose: "a consumer group of competing workers, the API answers 202",
    rejected: "doing the work inside the request",
    avoids: "requests above the 350 ms budget, timeouts under load",
    revisit_when: "a job must wait for a person or a timer beyond 30 s (durable-wait → Temporal), or the backlog never drains",
    scales_by: "add worker replicas to the consumer group; each message is processed once",
  },
  "scheduled-job": {
    title: "A scheduled job in a worker, claimed in Postgres",
    chose: "one worker container that wakes on a clock and claims due work in the app's database (one row per send, an advisory lock for a second replica)",
    rejected: "a Valkey stream and a consumer group for a handful of sends; a cron container outside the bill",
    avoids: "a stream to watch and competing consumers to size for fewer than 100 units per run",
    revisit_when: "one run fans out ≥ 100 units (async-work → valkey + worker), or the work must wait for a person or a timer beyond 30 s (durable-wait → Temporal)",
    scales_by: "an advisory lock makes a second replica safe; the log of what was sent makes a late start or a restart idempotent",
  },
  "durable-wait": {
    title: "A Temporal workflow per long-running process",
    chose: "one namespace, timers and signals, compensation as activities",
    rejected: "status columns polled by a cron",
    avoids: "lost state on restart, hand-written retry and reminder loops",
    revisit_when: "the waits disappear from the requirements — a workflow that never waits is a function call",
    scales_by: "add worker replicas on the task queue; workflow history is the platform's, versioned on every deploy",
  },
  llm: {
    title: "Language tasks through llm.internal",
    chose: "a virtual key, task:* aliases, a token budget per app",
    rejected: "calling a provider SDK with a real key",
    avoids: "a provider key in the app, an unbudgeted bill",
    revisit_when: "the 429s of the token budget become routine — raise secret/core/llm-budgets, never bypass the gateway",
    scales_by: "the per-app token budget is the throttle; the provider switch (OpenAI ⇄ Anthropic) needs no code change",
  },
  "semantic-search": {
    title: "Embeddings in pgvector, task:embed through the gateway",
    chose: "CREATE EXTENSION vector in the app's DB",
    rejected: "a dedicated vector database",
    avoids: "one more container, one more backup",
    revisit_when: "the corpus outgrows one Postgres (millions of chunks) — a vector store becomes a decision of its own",
    scales_by: "an HNSW index in the app's DB; indexing runs offline in the worker",
  },
  "image-generation": {
    title: "Generated images through task:image",
    chose: "the gateway's image alias — OpenAI mode only",
    rejected: "a direct image API",
    avoids: "a second provider key",
    revisit_when: "the gateway runs Anthropic mode (no task:image) — the requirement must accept degraded images or pin the provider",
    scales_by: "the token budget throttles it like any LLM call",
  },
  "product-metrics": {
    title: "Product analytics in Umami",
    chose: "one website, events proxied first-party",
    rejected: "a home-made events table",
    avoids: "a dashboard to build and a privacy review per event",
    revisit_when: "nobody reads the metric any more — remove the site, the beacon and the register entry",
    scales_by: "Umami is shared and single-instance on the platform; events are fire-and-forget",
  },
};

// The tempting purchase a counter-signal refused, and the signal that would make it right.
const VETO_REVISIT: Record<string, { revisit_when: string; scales_by: string }> = {
  "async-work": {
    revisit_when: "the recurrence gains a side effect (send, e-mail, notify, charge) — then buy a worker with that R-id (scheduled-job); one action fanning out ≥ 100 units buys valkey + worker (async-work)",
    scales_by: "the rule is evaluated at read time in SQL + domain code: cost grows with the rows read, not with a clock",
  },
  "durable-wait": {
    revisit_when: "a step must wait for a person or a timer beyond 30 s, survive a restart, or compensate — then buy temporal with that R-id",
    scales_by: "no process waits, so nothing to replicate or version",
  },
};

const NAIVE: Record<string, string> = {
  "async-work": "a scheduler job per recurrence",
  "durable-wait": "one workflow per recurring item",
};

function emptyGuard(id: string, decision: string, serves: string[]): Guard {
  return { id, decision, serves, owner: "decide step · human-reviewed", forbid_import: [], forbid_pattern: [], forbid_env: [], forbid_service: [], forbid_path: [], forbid_flag: [], witness: [] };
}

function forbid(guard: Guard, f: Fingerprints) {
  guard.forbid_import.push(...(f.imports ?? []));
  guard.forbid_pattern.push(...(f.patterns ?? []));
  guard.forbid_env.push(...(f.env ?? []));
  guard.forbid_service.push(...(f.service ?? []));
  guard.forbid_path.push(...(f.paths ?? []));
  guard.forbid_flag.push(...(f.flags ?? []));
}

function absenceClaims(g: Graph, bricks: string[]): Claim[] {
  return bricks
    .map((b) => g.bricks[b].witness)
    .filter(Boolean)
    .map((w) => ({ probe: w!.probe, expect: "absent" }));
}

export function decide(brief: Brief, bill: Bill, g: Graph): Decision[] {
  const decisions: Decision[] = [];
  const next = () => `D${decisions.length + 1}`;
  const owned = new Set([...bill.scaffold, ...bill.bought.map((b) => b.brick)]);

  // 1. Bought needs, in the catalog's order.
  for (const need of Object.keys(g.needs)) {
    const rids = bill.needs[need];
    if (!rids) continue;
    const t = BOUGHT[need];
    const id = next();
    const guard = emptyGuard(id, t.title, rids);
    if (need === "identity") guard.witness.push({ probe: "secret-read", expect: "present", detail: `secret/${brief.app}/oidc` });
    if (need === "blob-storage" && !bill.needs["public-media"]) {
      guard.forbid_flag.push("PUBLIC_BUCKET");
      guard.witness.push({ probe: "s3-anonymous", expect: "denied" });
      decisions.push({ id, title: `${t.title}, private`, serves: rids, chose: t.chose, rejected: `${t.rejected}; PUBLIC_BUCKET=1 (no requirement serves files to anonymous users)`, avoids: t.avoids, revisit_when: t.revisit_when, scales_by: t.scales_by, bricks: g.needs[need].buys, guard: { ...guard, decision: `${t.title}, private` } });
      continue;
    }
    if (need === "llm" || need === "semantic-search" || need === "image-generation") {
      guard.forbid_import.push("openai", "@anthropic-ai/sdk");
      guard.forbid_pattern.push("api\\.openai\\.com", "api\\.anthropic\\.com");
    }
    decisions.push({ id, title: t.title, serves: rids, chose: t.chose, rejected: t.rejected, avoids: t.avoids, revisit_when: t.revisit_when, scales_by: t.scales_by, bricks: g.needs[need].buys, guard });
  }

  // 2. Vetoed needs: the tempting purchase, refused by a counter-signal.
  const vetoGroups = new Map<string, typeof bill.vetoed>();
  for (const v of bill.vetoed) {
    if (bill.needs[v.need]) continue; // another requirement bought it anyway
    const key = v.requirement;
    vetoGroups.set(key, [...(vetoGroups.get(key) ?? []), v]);
  }
  for (const [rid, vs] of vetoGroups) {
    const refusedBricks = [...new Set(vs.flatMap((v) => g.needs[v.need].buys.flatMap((b) => [b, ...g.bricks[b].requires])))].filter((b) => !owned.has(b));
    const names = refusedBricks.filter((b) => b !== "temporal-ui");
    const id = next();
    const title = `No ${names.map((b) => (b === "valkey" ? "Valkey" : b === "temporal" ? "Temporal" : b)).join(", no ")}`;
    const guard = emptyGuard(id, title, [rid]);
    for (const b of refusedBricks) forbid(guard, g.bricks[b].fingerprints);
    guard.witness.push(...absenceClaims(g, refusedBricks));
    decisions.push({
      id,
      title,
      serves: [rid],
      chose: vs.map((v) => v.why).join("; "),
      rejected: vs.map((v) => NAIVE[v.need] ?? v.need).join("; "),
      avoids: [...new Set(vs.map((v) => v.avoids))].join("; "),
      revisit_when: vs.map((v) => VETO_REVISIT[v.need]?.revisit_when ?? `a requirement emits ${v.need} without the counter-signal ${v.rule}`).join("; "),
      scales_by: [...new Set(vs.map((v) => VETO_REVISIT[v.need]?.scales_by).filter(Boolean))].join("; "),
      bricks: refusedBricks,
      guard,
    });
  }

  // 2b. Gaps: the requirement asks for something the platform has no brick for. Recorded, guarded, never filled by the builder.
  const gapIds = [...new Set(bill.gaps.map((x) => x.id))];
  for (const gid of gapIds) {
    const gp = g.gaps.find((x) => x.id === gid)!;
    const rids = [...new Set(bill.gaps.filter((x) => x.id === gid).map((x) => x.requirement))];
    const id = next();
    const title = `Platform gap ${gid.replace(/^G-/, "")}: the CCoE decides`;
    const guard = emptyGuard(id, title, rids);
    guard.forbid_import.push(...gp.forbid_import);
    guard.forbid_pattern.push(...gp.forbid_pattern);
    decisions.push({
      id,
      title,
      serves: rids,
      chose: `the requirement is planned without a brick: ${gp.why}`,
      rejected: "adding a service to the shared platform, or a client library, from inside an app",
      avoids: "an unmonitored relay, a platform change made by an application, a second way to send",
      revisit_when: "the CCoE prices a brick for it in criteria.yaml (an airgap upstream or a relay): then buy it with that R-id",
      scales_by: "nothing runs for it yet: the app records what it would send and the CCoE decides the channel",
      bricks: [],
      guard,
    });
  }

  // 3. Nothing unasked: every other refused brick with fingerprints is guarded.
  const covered = new Set(decisions.flatMap((d) => [...d.guard.forbid_service, ...d.guard.forbid_import]));
  const rest = bill.refused.map((r) => r.brick).filter((b) => {
    const f = g.bricks[b].fingerprints;
    return Object.keys(f).length > 0 && ![...(f.imports ?? []), ...(f.service ?? [])].some((x) => covered.has(x));
  });
  if (rest.length) {
    const id = next();
    const title = "Nothing unasked";
    const guard = emptyGuard(id, title, ["*"]);
    for (const b of rest) forbid(guard, g.bricks[b].fingerprints);
    guard.witness.push(...absenceClaims(g, rest));
    decisions.push({
      id,
      title,
      serves: ["*"],
      chose: `stay out: ${rest.join(", ")} — no requirement emits a signal for them`,
      rejected: rest.map((b) => `${b} "in case"`).join(", "),
      avoids: `${rest.reduce((s, b) => s + g.bricks[b].ops_points, 0)} ops points: ${rest.map((b) => g.bricks[b].costs.join(", ")).join("; ")}`,
      revisit_when: rest.map((b) => `${b}: ${g.bricks[b].use_when}`).join("; "),
      scales_by: "nothing to scale: what does not run costs nothing",
      bricks: rest,
      guard,
    });
  }
  for (const d of decisions) {
    for (const k of ["forbid_import", "forbid_pattern", "forbid_env", "forbid_service", "forbid_path", "forbid_flag"] as const) d.guard[k] = [...new Set(d.guard[k])];
  }
  return decisions;
}
