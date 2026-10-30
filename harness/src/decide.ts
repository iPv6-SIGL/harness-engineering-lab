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
  guard: Guard;
};

// What each need-decision chooses, rejects and avoids. Wording is the doctrine's.
const BOUGHT: Record<string, { title: string; chose: string; rejected: string; avoids: string }> = {
  identity: {
    title: "Identity through casdoor (OIDC)",
    chose: "one OIDC client, one group per persona, roles checked server-side",
    rejected: "a users table in the app (a second user store)",
    avoids: "password storage, reset flows, a login screen to secure",
  },
  "blob-storage": {
    title: "Files in the app's S3 bucket",
    chose: "the app's bucket with its scoped key, streamed through the API",
    rejected: "files as Postgres blobs",
    avoids: "bloated backups and DB reads on every page",
  },
  "public-media": {
    title: "Anonymous read on the app's bucket only",
    chose: "PUBLIC_BUCKET=1 — browsers load the files directly",
    rejected: "proxying every image through the API",
    avoids: "an API round-trip and its CPU per image view",
  },
  "async-work": {
    title: "Background work on a Valkey stream drained by a worker",
    chose: "a consumer group of competing workers, the API answers 202",
    rejected: "doing the work inside the request",
    avoids: "requests above the 350 ms budget, timeouts under load",
  },
  "durable-wait": {
    title: "A Temporal workflow per long-running process",
    chose: "one namespace, timers and signals, compensation as activities",
    rejected: "status columns polled by a cron",
    avoids: "lost state on restart, hand-written retry and reminder loops",
  },
  llm: {
    title: "Language tasks through llm.internal",
    chose: "a virtual key, task:* aliases, a token budget per app",
    rejected: "calling a provider SDK with a real key",
    avoids: "a provider key in the app, an unbudgeted bill",
  },
  "semantic-search": {
    title: "Embeddings in pgvector, task:embed through the gateway",
    chose: "CREATE EXTENSION vector in the app's DB",
    rejected: "a dedicated vector database",
    avoids: "one more container, one more backup",
  },
  "image-generation": {
    title: "Generated images through task:image",
    chose: "the gateway's image alias — OpenAI mode only",
    rejected: "a direct image API",
    avoids: "a second provider key",
  },
  "product-metrics": {
    title: "Product analytics in Umami",
    chose: "one website, events proxied first-party",
    rejected: "a home-made events table",
    avoids: "a dashboard to build and a privacy review per event",
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
      decisions.push({ id, title: `${t.title}, private`, serves: rids, chose: t.chose, rejected: `${t.rejected}; PUBLIC_BUCKET=1 (no requirement serves files to anonymous users)`, avoids: t.avoids, guard: { ...guard, decision: `${t.title}, private` } });
      continue;
    }
    if (need === "llm" || need === "semantic-search" || need === "image-generation") {
      guard.forbid_import.push("openai", "@anthropic-ai/sdk");
      guard.forbid_pattern.push("api\\.openai\\.com", "api\\.anthropic\\.com");
    }
    decisions.push({ id, title: t.title, serves: rids, chose: t.chose, rejected: t.rejected, avoids: t.avoids, guard });
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
      guard,
    });
  }
  for (const d of decisions) {
    for (const k of ["forbid_import", "forbid_pattern", "forbid_env", "forbid_service", "forbid_path", "forbid_flag"] as const) d.guard[k] = [...new Set(d.guard[k])];
  }
  return decisions;
}
