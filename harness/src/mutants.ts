// mutants.ts — step 10: green tests can be fake. A test counts only if it
// kills mutants. A small, dependency-free mutator (Stryker's idea, not its
// install weight): one operator at a time on the app's pure business module,
// the service's unit tests re-run, the mutant is KILLED if they go red.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

export type Mutant = { line: number; op: string; from: string; to: string; killed: boolean };
export type MutationReport = { file: string; total: number; killed: number; score: number; survivors: Mutant[] };

const OPS: [string, RegExp, (m: string) => string][] = [
  ["equality", /===|!==/g, (m) => (m === "===" ? "!==" : "===")],
  ["boundary", /<=|>=|(?<![=<>!])<(?![=<])|(?<![=>-])>(?![=>])/g, (m) => ({ "<=": "<", ">=": ">", "<": "<=", ">": ">=" })[m]!],
  ["logical", /&&|\|\|/g, (m) => (m === "&&" ? "||" : "&&")],
  ["arithmetic", /(?<=\s)[+-](?=\s)/g, (m) => (m === "+" ? "-" : "+")],
  ["boolean", /\btrue\b|\bfalse\b/g, (m) => (m === "true" ? "false" : "true")],
  ["number", /(?<![\w.])\d+(?![\w.])/g, (m) => String(Number(m) + 1)],
];

/** Blank out strings, template literals and comments so operators inside them are not mutated. */
function mask(src: string): string {
  return src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, (s) => s.replace(/[^\n]/g, " "));
}

export function sites(src: string): { index: number; length: number; op: string; to: string; line: number }[] {
  const masked = mask(src);
  const out: { index: number; length: number; op: string; to: string; line: number }[] = [];
  for (const [op, re, f] of OPS) {
    for (const m of masked.matchAll(re)) {
      const lineStart = masked.lastIndexOf("\n", m.index!) + 1;
      const lineText = masked.slice(lineStart, masked.indexOf("\n", m.index!));
      if (/^\s*(import|export type|type |\})/.test(lineText)) continue;
      out.push({ index: m.index!, length: m[0].length, op, to: f(m[0]), line: masked.slice(0, m.index!).split("\n").length });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

export function mutate(serviceDir: string, file: string, testArgs: string[] = ["test", "src"], max = 80): MutationReport {
  const original = readFileSync(file, "utf8");
  const all = sites(original);
  const step = Math.max(1, Math.ceil(all.length / max));
  const chosen = all.filter((_, i) => i % step === 0);
  const work = mkdtempSync(join(tmpdir(), "mutants-"));
  cpSync(serviceDir, work, { recursive: true, filter: (s) => !s.includes("node_modules") });
  const target = join(work, relative(serviceDir, file));
  const run = () => Bun.spawnSync(["bun", ...testArgs], { cwd: work, stdout: "pipe", stderr: "pipe", timeout: 30_000 }).exitCode;
  if (run() !== 0) throw new Error("the unit tests are red BEFORE mutation — fix them first");
  const mutants: Mutant[] = [];
  for (const s of chosen) {
    const mutated = original.slice(0, s.index) + s.to + original.slice(s.index + s.length);
    writeFileSync(target, mutated);
    mutants.push({ line: s.line, op: s.op, from: original.slice(s.index, s.index + s.length), to: s.to, killed: run() !== 0 });
  }
  writeFileSync(target, original);
  rmSync(work, { recursive: true, force: true });
  const killed = mutants.filter((m) => m.killed).length;
  return { file: relative(dirname(serviceDir), file), total: mutants.length, killed, score: mutants.length ? killed / mutants.length : 0, survivors: mutants.filter((m) => !m.killed) };
}
