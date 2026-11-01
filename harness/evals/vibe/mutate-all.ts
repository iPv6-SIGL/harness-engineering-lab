// vibe/mutate-all.ts — are the tests an agent wrote WITHOUT the harness any good?
// Same mutator, same operators, same sample size as step 10 of the harness (≥ 70 % to pass).
//   bun harness/evals/vibe/mutate-all.ts <label>=<service-dir>:<pure-module> ...
//   e.g. desk1=~/vibe-runs/desk1/app/api:src/domain.ts
import { resolve } from "node:path";
import { mutate } from "../../src/mutants";

const rows: string[] = [];
for (const arg of process.argv.slice(2)) {
  const [label, rest] = arg.split("=");
  const [dir, file] = rest.split(":");
  try {
    // the agents put tests in src/ or test/: run them all, as `bun test` does
    const r = mutate(resolve(dir), resolve(dir, file), ["test"]);
    rows.push(`${label.padEnd(8)} ${String(r.killed).padStart(3)}/${String(r.total).padEnd(3)} ${(r.score * 100).toFixed(0).padStart(3)} %  ${r.score >= 0.7 ? "✓ ≥ 70 %" : "✗ < 70 %"}  survivors: ${r.survivors.slice(0, 4).map((s) => `L${s.line} ${s.from}→${s.to}`).join(", ")}`);
  } catch (e) {
    rows.push(`${label.padEnd(8)} n/a  ${(e as Error).message.slice(0, 80)}`);
  }
}
console.log(rows.join("\n"));
