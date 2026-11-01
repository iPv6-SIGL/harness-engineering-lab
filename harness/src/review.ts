// review.ts — step 12: a reviewer of ANOTHER model family reads the diff
// against design.md. Judges favour their own family; the gateway already
// switches providers, so the builder runs on one and the reviewer on the other.
// No provider key → the review is SKIPPED, never silently green: the human
// gate is told so.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Review = { status: "pass" | "concerns" | "skipped"; provider?: string; reason: string; findings: string[] };

const bao = (args: string[]) => Bun.spawnSync(["podman", "exec", "-e", "BAO_ADDR=http://127.0.0.1:8200", "-e", "BAO_TOKEN=root-dev-token", "openbao.internal", "bao", ...args]);

export async function review(appDir: string, changeDir: string, builderProvider = "anthropic"): Promise<Review> {
  const reviewer = builderProvider === "anthropic" ? "openai" : "anthropic";
  const providerKey = bao(["kv", "get", "-field=api_key", `secret/core/${reviewer}`]);
  const active = bao(["kv", "get", "-field=provider", "secret/core/llm-provider"]).stdout.toString().trim() || "openai";
  const vkey = bao(["kv", "get", "-field=harness", "secret/core/llm-vkeys"]);
  if (providerKey.exitCode !== 0 || vkey.exitCode !== 0) {
    return { status: "skipped", reason: `no ${reviewer} key in secret/core/${reviewer} or no harness vkey — the human gate reviews instead`, findings: [] };
  }
  if (active !== reviewer) {
    return { status: "skipped", reason: `the gateway runs ${active}; the reviewer must run on ${reviewer} (LLM_PROVIDER=${reviewer} ./apisix/seed-and-deploy.sh)`, findings: [] };
  }
  const design = readFileSync(join(changeDir, "design.md"), "utf8");
  const diff = Bun.spawnSync(["git", "diff", "--stat", "HEAD", "--", "."], { cwd: appDir }).stdout.toString();
  const res = await fetch("http://localhost:9080/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${vkey.stdout.toString().trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "task:quality",
      max_tokens: 800,
      messages: [
        { role: "system", content: 'You review a diff against its design decisions. Answer JSON {"status":"pass"|"concerns","findings":[string]}. Flag over-engineering: any brick, dependency or abstraction no requirement pays for.' },
        { role: "user", content: `design.md:\n${design}\n\ndiff:\n${diff}` },
      ],
    }),
  });
  if (!res.ok) return { status: "skipped", provider: reviewer, reason: `gateway answered HTTP ${res.status}`, findings: [] };
  const body: any = await res.json();
  try {
    const v = JSON.parse(body.choices[0].message.content);
    return { status: v.status === "pass" ? "pass" : "concerns", provider: reviewer, reason: "cross-family review", findings: v.findings ?? [] };
  } catch {
    return { status: "concerns", provider: reviewer, reason: "unparseable verdict", findings: [String(body.choices?.[0]?.message?.content ?? "")] };
  }
}
