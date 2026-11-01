// catalog.ts — the capability graph (step 2). Rebuilt at every run from the
// platform's OWN files, merged with the curated criteria. Never a hand-made copy
// that drifts: if the platform and the criteria disagree, the build FAILS.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const HARNESS_DIR = resolve(import.meta.dir, "..");

export type Fingerprints = {
  imports?: string[];
  patterns?: string[];
  env?: string[];
  flags?: string[];
  service?: string[];
  paths?: string[];
};

export type Brick = {
  brick: string;
  layer: string;
  scaffold: boolean;
  ops_points: number;
  price_assumed: boolean;
  costs: string[];
  use_when?: string;
  not_when?: string;
  switch?: string;
  requires: string[];
  fingerprints: Fingerprints;
  witness?: { probe: string; expect_absent: boolean };
  // from the platform's files
  container?: string;
  image?: string;
  ports: string[];
  aliases: string[];
  sources: string[];
  bought_by: string[]; // needs that buy it
};

export type Signal = { id: string; re?: string; also?: string; numeric?: string };
export type Need = {
  why: string;
  structural?: string;
  signals?: Signal[];
  vetoed_by?: string[];
  requires_need?: string;
  buys: string[];
  flag?: string;
  question?: string;
  provider_constraint?: string;
  extension?: string;
};
export type Veto = {
  why: string;
  re: string;
  unless?: string;
  only_if_signals?: string[];
  cancels: string[];
  avoids: string;
};
export type Criteria = {
  thresholds: Record<string, number>;
  needs: Record<string, Need>;
  vetoes: Record<string, Veto>;
  bricks: Record<string, Omit<Brick, "brick" | "ports" | "aliases" | "sources" | "bought_by" | "requires" | "fingerprints" | "scaffold" | "price_assumed"> & {
    scaffold?: boolean;
    price_assumed?: boolean;
    requires?: string[];
    fingerprints?: Fingerprints;
  }>;
  unsupported: { id: string; re: string; why: string }[];
};
export type AppClass = {
  rank: number;
  budget: number;
  family: string;
  profile: string[];
  trigger_needs?: string[];
  trigger_needs_all?: string[];
};

export type Graph = {
  built_from: string[];
  thresholds: Record<string, number>;
  needs: Record<string, Need>;
  vetoes: Record<string, Veto>;
  bricks: Record<string, Brick>;
  classes: Record<string, AppClass>;
  unsupported: Criteria["unsupported"];
  bootstrap_flags: string[];
};

const yaml = (p: string) => Bun.YAML.parse(readFileSync(p, "utf8")) as any;

// The README section that documents each brick — cited as the node's source.
const README_SECTIONS: Record<string, string> = {
  temporal: "## Durable orchestration",
  "temporal-ui": "## Durable orchestration",
  casdoor: "## The identity provider",
  apisix: "## The `llm.internal` LLM gateway",
  s3: "## The object store",
  openbao: "## Auditability",
  frontend: "## The ports convention",
  api: "## The ports convention",
  worker: "## The ports convention",
};

export function corePlatformDir(): string {
  const cfg = yaml(join(HARNESS_DIR, "harness.yaml"));
  return resolve(HARNESS_DIR, process.env.CORE_PLATFORM ?? cfg.core_platform);
}

export function loadHarnessConfig(): any {
  return yaml(join(HARNESS_DIR, "harness.yaml"));
}

export function buildGraph(core = corePlatformDir()): Graph {
  const criteria = yaml(join(HARNESS_DIR, "catalog/criteria.yaml")) as Criteria;
  const classes = yaml(join(HARNESS_DIR, "catalog/budgets.yaml")).classes as Record<string, AppClass>;
  const coreCompose = yaml(join(core, "podman-compose.yml"));
  const appCompose = yaml(join(core, "templates/podman-compose.yml"));
  const readme = readFileSync(join(core, "README.md"), "utf8");
  const bootstrap = readFileSync(join(core, "templates/bootstrap.sh"), "utf8");
  const errors: string[] = [];

  const bootstrapFlags = [...new Set([...bootstrap.matchAll(/\$\{([A-Z_]+):-0\}" = "1"/g)].map((m) => m[1]))];

  const services: Record<string, any> = { ...coreCompose.services, ...appCompose.services };
  const bricks: Record<string, Brick> = {};
  for (const [name, svc] of Object.entries<any>(services)) {
    const c = criteria.bricks[name];
    if (!c) {
      errors.push(`compose service '${name}' has no entry in catalog/criteria.yaml — price it before any app can buy it`);
      continue;
    }
    const nets = svc.networks ?? {};
    const aliases = Array.isArray(nets) ? [] : Object.values<any>(nets).flatMap((n) => n?.aliases ?? []);
    const sources = [name in coreCompose.services ? "core-platform/podman-compose.yml" : "core-platform/templates/podman-compose.yml"];
    const section = README_SECTIONS[name];
    if (section) {
      if (!readme.includes(section)) errors.push(`README section '${section}' cited for '${name}' no longer exists`);
      else sources.push(`README ${section.replace(/^## /, "§ ")}`);
    }
    bricks[name] = {
      brick: name,
      layer: c.layer,
      scaffold: c.scaffold ?? false,
      ops_points: c.ops_points,
      price_assumed: c.price_assumed ?? false,
      costs: c.costs ?? [],
      use_when: c.use_when,
      not_when: c.not_when,
      switch: c.switch,
      requires: c.requires ?? [],
      fingerprints: c.fingerprints ?? {},
      witness: c.witness,
      container: svc.container_name,
      image: svc.image,
      ports: (svc.ports ?? []).map(String),
      aliases,
      sources,
      bought_by: [],
    };
  }
  for (const name of Object.keys(criteria.bricks)) {
    if (!services[name]) errors.push(`criteria.yaml prices '${name}' but no compose file defines it — remove it or add the service`);
  }
  for (const [needId, need] of Object.entries(criteria.needs)) {
    for (const b of need.buys) {
      if (!criteria.bricks[b]) errors.push(`need '${needId}' buys unknown brick '${b}'`);
      else bricks[b]?.bought_by.push(needId);
    }
    const flag = need.flag?.split("=")[0];
    if (flag && !bootstrapFlags.includes(flag)) errors.push(`need '${needId}' switches ${flag}, which bootstrap.sh no longer reads`);
    for (const v of need.vetoed_by ?? []) if (!criteria.vetoes[v]) errors.push(`need '${needId}' is vetoed by unknown rule '${v}'`);
  }
  for (const [name, b] of Object.entries(bricks)) {
    for (const f of b.fingerprints.flags ?? []) if (!bootstrapFlags.includes(f)) errors.push(`brick '${name}' fingerprints flag ${f}, which bootstrap.sh no longer reads`);
    for (const r of b.requires) if (!bricks[r]) errors.push(`brick '${name}' requires unknown brick '${r}'`);
  }
  if (errors.length) throw new Error(`capability graph out of sync with the platform:\n  - ${errors.join("\n  - ")}`);

  return {
    built_from: ["core-platform/podman-compose.yml", "core-platform/templates/podman-compose.yml", "core-platform/README.md", "core-platform/templates/bootstrap.sh", "harness/catalog/criteria.yaml", "harness/catalog/budgets.yaml"],
    thresholds: criteria.thresholds,
    needs: criteria.needs,
    vetoes: criteria.vetoes,
    bricks,
    classes,
    unsupported: criteria.unsupported,
    bootstrap_flags: bootstrapFlags,
  };
}

export function scaffoldBricks(g: Graph): string[] {
  return Object.values(g.bricks).filter((b) => b.scaffold).map((b) => b.brick);
}

export function exists(p: string) {
  return existsSync(p);
}
