// guards.ts — one evaluator, two moments:
//   PREVENT  hooks/guard.ts   a proposed edit, before it lands (PreToolUse)
//   DETECT   `harness fitness` the whole repo, before the merge (CI)
// The third moment, PROVE, is witness.ts on the running stack.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { Guard } from "./decide";

export type Violation = { guard: string; decision: string; rule: string; file: string; match: string };

// Files the builder may never write: the desired state and the harness's own state.
export const PROTECTED = [/^\.harness\//, /^openspec\/changes\/[^/]+\/(design|tasks|proposal)\.md$/, /^openspec\/(specs|changes\/archive)\//, /^podman-compose\.yml$/, /^\.gitlab-ci\.yml$/, /^bootstrap\.sh$/, /^\.claude\/settings\.json$/];

const CODE = /\.(ts|tsx|js|mjs|cjs|html|conf|ya?ml|json|sh)$|(^|\/)Dockerfile$/;
const SKIP_DIRS = new Set(["node_modules", ".harness", "openspec", "artifacts", ".git", ".gitlab-ci-local", ".claude", "e2e"]);
const SKIP_FILES = new Set(["bootstrap.sh", "biome.json", "bun.lock", "README.md"]); // CCoE templates copied verbatim

export function findAppRoot(from: string): string | null {
  let d = from;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, ".harness", "guards"))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

export function loadGuards(appRoot: string): Guard[] {
  const dir = join(appRoot, ".harness", "guards");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => Bun.YAML.parse(readFileSync(join(dir, f), "utf8")) as Guard);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

function importRe(pkg: string) {
  // from 'pkg' | from "pkg/sub" | require('pkg') | import('pkg')
  return new RegExp(`(from\\s+|require\\(\\s*|import\\(\\s*)['"]${esc(pkg)}(\\/[^'"]*)?['"]`);
}

/** Check one file's (proposed) content against every guard. `rel` is relative to the app root, with forward slashes. */
export function checkContent(guards: Guard[], rel: string, content: string): Violation[] {
  const out: Violation[] = [];
  const base = rel.split("/").pop()!;
  const v = (g: Guard, rule: string, match: string) => out.push({ guard: g.id, decision: g.decision, rule, file: rel, match });
  for (const g of guards) {
    for (const p of g.forbid_path) if (rel.startsWith(p)) v(g, "forbid_path", p);
    if (!CODE.test(rel) || SKIP_FILES.has(base)) continue;
    if (base === "package.json") {
      try {
        const pkg = JSON.parse(content);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
        for (const i of g.forbid_import) for (const d of Object.keys(deps)) if (d === i || d.startsWith(`${i}/`)) v(g, "forbid_import", d);
      } catch {}
      continue;
    }
    for (const i of g.forbid_import) {
      const m = content.match(importRe(i));
      if (m) v(g, "forbid_import", m[0]);
    }
    for (const p of g.forbid_pattern) {
      const m = content.match(new RegExp(p, "i"));
      if (m) v(g, "forbid_pattern", m[0]);
    }
    for (const e of g.forbid_env) {
      const m = content.match(new RegExp(`(process\\.env|Bun\\.env)\\.${e}\\b|\\b${e}\\s*[:=]`));
      if (m) v(g, "forbid_env", m[0]);
    }
  }
  return out;
}

/** Compose services and CI flags — the topology the bill decided. */
export function checkTopology(guards: Guard[], appRoot: string): Violation[] {
  const out: Violation[] = [];
  const compose = join(appRoot, "podman-compose.yml");
  const ci = join(appRoot, ".gitlab-ci.yml");
  const services = existsSync(compose) ? Object.keys((Bun.YAML.parse(readFileSync(compose, "utf8")) as any).services ?? {}) : [];
  const vars = existsSync(ci) ? ((Bun.YAML.parse(readFileSync(ci, "utf8")) as any).variables ?? {}) : {};
  for (const g of guards) {
    for (const s of g.forbid_service) if (services.includes(s)) out.push({ guard: g.id, decision: g.decision, rule: "forbid_service", file: "podman-compose.yml", match: s });
    for (const f of g.forbid_flag) if (String(vars[f] ?? "0") === "1") out.push({ guard: g.id, decision: g.decision, rule: "forbid_flag", file: ".gitlab-ci.yml", match: `${f}=1` });
  }
  return out;
}

/** Shell commands the builder may run: no installing a forbidden package, no writing protected files. */
export function checkCommand(guards: Guard[], cmd: string): Violation[] {
  const out: Violation[] = [];
  const install = cmd.match(/\b(bun|npm|pnpm|yarn)\s+(add|i|install)\s+([^&|;]+)/);
  if (install) {
    const pkgs = install[3].split(/\s+/).filter((p) => p && !p.startsWith("-")).map((p) => p.replace(/@[^@/]+$/, ""));
    for (const g of guards) for (const i of g.forbid_import) for (const p of pkgs) if (p === i || p.startsWith(`${i}/`)) out.push({ guard: g.id, decision: g.decision, rule: "forbid_import", file: "(shell)", match: `${install[1]} ${install[2]} ${p}` });
  }
  if (/(>|\btee\b|\bsed\s+-i|\brm\b|\bmv\b|\bcp\b)[^;&|]*\.harness\//.test(cmd)) {
    out.push({ guard: "harness", decision: ".harness/ belongs to the harness", rule: "protected", file: ".harness/", match: cmd.slice(0, 80) });
  }
  return out;
}

export function scanRepo(guards: Guard[], appRoot: string): Violation[] {
  const out: Violation[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(p);
        continue;
      }
      const rel = relative(appRoot, p).split(sep).join("/");
      out.push(...checkContent(guards, rel, readFileSync(p, "utf8")));
    }
  };
  walk(appRoot);
  return [...out, ...checkTopology(guards, appRoot)];
}

export function formatViolation(v: Violation): string {
  return `✗ ${v.file}: ${v.rule} \`${v.match}\` breaks ${v.guard} · ${v.decision}`;
}
