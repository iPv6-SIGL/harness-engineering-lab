// archive.ts — step 15. A merged change becomes "today's truth":
//   openspec/specs/<app>/spec.md        its requirements, merged (same R-id replaced)
//   openspec/specs/<app>/decisions.md   the cumulative decision log, with what
//                                       reopens each decision and how it scales
//   openspec/changes/archive/<date>-<change>/   the change + the run's trail
// and the full evidence pack goes to the harness's own bucket (outside Git).
// It refuses to archive a decision that does not say when to revisit it: an
// app stays modular only if the next change knows which brick it may add.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Decision } from "./decide";

type Block = { id: string; body: string };

function requirementBlocks(md: string): Block[] {
  return md
    .split(/^(?=### Requirement: )/m)
    .filter((b) => b.startsWith("### Requirement: "))
    .map((b) => ({ id: b.split("\n")[0].replace("### Requirement: ", "").split(" ")[0], body: b.trimEnd() }));
}

/** Merge a change's spec delta into the app's living spec: same R-id replaced, new ones appended. */
export function mergeSpec(current: string | null, delta: string, app: string): string {
  const blocks = current ? requirementBlocks(current) : [];
  for (const b of requirementBlocks(delta)) {
    const i = blocks.findIndex((x) => x.id === b.id);
    if (i >= 0) blocks[i] = b;
    else blocks.push(b);
  }
  return `# ${app} — specification\n\nToday's truth: the requirements in force, merged by \`harness archive\` from each archived change.\n\n## Requirements\n\n${blocks.map((b) => b.body).join("\n\n")}\n`;
}

/** Every guard is backed by a decision that says when to revisit it and how it scales; every bought brick is decided. */
export function archiveGaps(decisions: Decision[], guardIds: string[], bought: string[]): string[] {
  const gaps: string[] = [];
  for (const id of guardIds) {
    const d = decisions.find((x) => x.id === id);
    if (!d) gaps.push(`guard ${id} has no decision`);
    else {
      if (!d.revisit_when?.trim()) gaps.push(`${id} has no revisit_when`);
      if (!d.scales_by?.trim()) gaps.push(`${id} has no scales_by`);
    }
  }
  for (const b of bought) if (!decisions.some((d) => d.bricks.includes(b))) gaps.push(`bought brick ${b} is named by no decision`);
  return gaps;
}

export type ArchiveInput = {
  appDir: string;
  app: string;
  run: string;
  approvedBy: string;
  bill: { class: string; total: number; budget: number; bought: { brick: string; paid_by: string[] }[] };
  decisions: Decision[];
  runDir: string;
};

export function archiveChange(a: ArchiveInput): { target: string; specPath: string; logPath: string } {
  const change = `add-${a.app}`;
  const changeDir = join(a.appDir, "openspec", "changes", change);
  if (!existsSync(changeDir)) throw new Error(`no open change ${change} — nothing to archive`);
  const date = new Date().toISOString().slice(0, 10);
  const specDir = join(a.appDir, "openspec", "specs", a.app);
  mkdirSync(specDir, { recursive: true });

  const specPath = join(specDir, "spec.md");
  const delta = readFileSync(join(changeDir, "specs", a.app, "spec.md"), "utf8");
  writeFileSync(specPath, mergeSpec(existsSync(specPath) ? readFileSync(specPath, "utf8") : null, delta, a.app));

  const logPath = join(specDir, "decisions.md");
  const header = `# ${a.app} — decision log\n\nEvery decision in force, newest change last. A decision is reopened only by a new change whose requirement matches its **Revisit when** — then the harness re-plans and a human approves the new bill.\n`;
  const prev = existsSync(logPath) ? readFileSync(logPath, "utf8") : header;
  if (!prev.includes(`· ${a.run}`)) {
    const entry = [
      `\n## ${date} · ${change} · ${a.run}`,
      "",
      `Status **accepted** — merge approved by ${a.approvedBy}. Bill: **${a.bill.class}**, ${a.bill.total} / ${a.bill.budget} ops points; bought ${a.bill.bought.map((b) => `${b.brick} (${b.paid_by.join(", ")})`).join(", ") || "scaffold only"}.`,
      "",
      ...a.decisions.flatMap((d) => [
        `### ${d.id} · ${d.title}`,
        "",
        `- **Serves** ${d.serves.join(", ")} · **bricks** ${d.bricks.join(", ")}`,
        `- **Chose** ${d.chose}`,
        `- **Rejected** ${d.rejected}`,
        `- **Avoids** ${d.avoids}`,
        `- **Revisit when** ${d.revisit_when}`,
        `- **Scales by** ${d.scales_by}`,
        `- **Enforced by** \`.harness/guards/${d.id}.yaml\` (hook · fitness · witness)`,
        "",
      ]),
    ].join("\n");
    writeFileSync(logPath, prev.trimEnd() + "\n" + entry);
  }

  let target = join(a.appDir, "openspec", "changes", "archive", `${date}-${change}`);
  if (existsSync(target)) target = `${target}-${a.run}`;
  mkdirSync(join(a.appDir, "openspec", "changes", "archive"), { recursive: true });
  renameSync(changeDir, target);
  // The decision trail travels with the change, in Git; the bulky evidence goes to S3.
  mkdirSync(join(target, "run"), { recursive: true });
  for (const f of ["decisions.jsonl", "report.md", "verdicts.json"]) {
    if (existsSync(join(a.runDir, f))) cpSync(join(a.runDir, f), join(target, "run", f));
  }
  return { target, specPath, logPath };
}

/** Uploads the evidence pack to the harness's own bucket (APP=harness ./bootstrap.sh gives it one). */
export async function uploadEvidence(app: string, run: string, runDir: string): Promise<string> {
  const bao = process.env.BAO_ADDR ?? "http://localhost:8200";
  const res = await fetch(`${bao}/v1/secret/data/harness/objectstore`, { headers: { "X-Vault-Token": process.env.BAO_TOKEN ?? "root-dev-token" } }).catch(() => null);
  if (!res?.ok) return "kept locally only — the harness has no bucket yet (run APP=harness core-platform/templates/bootstrap.sh)";
  const s = ((await res.json()) as { data: { data: Record<string, string> } }).data.data;
  const s3 = new Bun.S3Client({ endpoint: s.endpoint, bucket: s.bucket, accessKeyId: s.access_key, secretAccessKey: s.secret_key, region: "us-east-1" });
  const files = [...new Bun.Glob("*").scanSync(runDir)];
  for (const f of files) await s3.write(`${app}/${run}/${f}`, Bun.file(join(runDir, f)));
  return `s3://${s.bucket}/${app}/${run}/ (${files.length} files)`;
}
