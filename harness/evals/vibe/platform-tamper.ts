// vibe/platform-tamper.ts — an agent that "needs" something the platform lacks edits the platform.
// The harness's catalog is rebuilt from the platform's OWN files at every run and FAILS when a
// compose service has no priced entry in criteria.yaml. Does it catch what agents really did?
//   bun harness/evals/vibe/platform-tamper.ts <core-platform-dir> [...]
import { resolve } from "node:path";
import { buildGraph } from "../../src/catalog";

for (const dir of process.argv.slice(2)) {
  try {
    const g = buildGraph(resolve(dir));
    console.log(`${dir}\n  graph built: ${Object.keys(g.bricks).length} bricks`);
  } catch (e) {
    console.log(`${dir}\n  BUILD FAILS: ${String((e as Error).message).split("\n")[0].slice(0, 220)}`);
  }
}
