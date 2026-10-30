#!/usr/bin/env bun
// hooks/guard.ts — the PREVENT moment. Claude Code runs it before every Write,
// Edit, MultiEdit and Bash of the builder (PreToolUse). It reconstructs the file
// AS IT WOULD BE after the edit, checks it against the app's guards, and refuses
// with exit 2: the reason goes back to the agent, quoting the decision it breaks.
//
// Wired by `harness plan` in <app>/.claude/settings.json.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { checkCommand, checkContent, findAppRoot, formatViolation, loadGuards, PROTECTED, type Violation } from "../src/guards";

const input = JSON.parse(await Bun.stdin.text());
const tool: string = input.tool_name;
const ti = input.tool_input ?? {};
const cwd: string = input.cwd ?? process.cwd();

function refuse(violations: Violation[], extra = "") {
  const lines = violations.map(formatViolation);
  process.stderr.write(
    `Refused by the harness guard.\n${lines.join("\n")}\n${extra}` +
      "Change the code to respect the decision, or — if the requirement really needs it — ask for a NEW decision with a requirement id (design.md is not yours to edit).\n",
  );
  process.exit(2);
}

if (tool === "Bash") {
  const root = findAppRoot(cwd);
  if (!root) process.exit(0);
  const v = checkCommand(loadGuards(root), String(ti.command ?? ""));
  if (v.length) refuse(v);
  process.exit(0);
}

if (!["Write", "Edit", "MultiEdit"].includes(tool)) process.exit(0);
const file: string = isAbsolute(ti.file_path) ? ti.file_path : join(cwd, ti.file_path);
const root = findAppRoot(file) ?? findAppRoot(cwd);
if (!root) process.exit(0);
const rel = relative(root, file).split(sep).join("/");

if (PROTECTED.some((re) => re.test(rel))) {
  refuse([{ guard: "harness", decision: "the desired state and the harness state are not the builder's", rule: "protected", file: rel, match: tool }]);
}

// The file as it would be after the edit.
let after = existsSync(file) ? readFileSync(file, "utf8") : "";
if (tool === "Write") after = String(ti.content ?? "");
const edits = tool === "Edit" ? [ti] : tool === "MultiEdit" ? (ti.edits ?? []) : [];
for (const e of edits) {
  after = e.replace_all ? after.split(e.old_string).join(e.new_string) : after.replace(e.old_string, e.new_string);
}

const guards = loadGuards(root);
const before = existsSync(file) ? checkContent(guards, rel, readFileSync(file, "utf8")) : [];
const key = (v: Violation) => `${v.guard}|${v.rule}|${v.match}`;
const known = new Set(before.map(key));
const introduced = checkContent(guards, rel, after).filter((v) => !known.has(key(v)));
if (introduced.length) refuse(introduced);
process.exit(0);
