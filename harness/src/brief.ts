// brief.ts — brief-check (step 4). Grades the brief on five points and asks at
// most three questions a round — and ONLY questions whose answer changes a brick
// or a requirement (each question names what it `affects`). A gap fixed in the
// brief costs no code.
import type { Graph } from "./catalog";
import { type Brief, needTest, rx } from "./needs";

export type Question = { id: string; ask: string; why: string; affects: string; default: string };
export type BriefCheck = {
  score: number;
  criteria: { id: number; name: string; ok: boolean; gap?: string }[];
  questions: Question[];
  ready: boolean;
  defaults_applied: Question[];
};

// Through rx(): Unicode word boundaries, so the French forms match too.
const RECURRENCE = rx("\\b(every (week|day|month|monday|tuesday|wednesday|thursday|friday)|weekly|daily|monthly|repeat(s|ing)?|recurring|chaque (jour|semaine|mois|lundi|mardi|mercredi|jeudi|vendredi)|hebdomadaire|répét\\w*|récurren\\w*)\\b");
const HORIZON = rx("\\b(until|end date|for \\d+ (weeks|months)|jusqu|date de fin|pendant \\d+ (semaines|mois))");
const UPLOAD = rx("\\b(upload\\w*|téléverse\\w*)\\b");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

export function checkBrief(brief: Brief, g: Graph, round = 1, maxRounds = 3, maxQuestions = 3): BriefCheck {
  const reqs = brief.requirements;
  const criteria = [
    {
      id: 1,
      name: "Who uses it: the personas",
      ok: brief.anonymous === true || brief.personas.length > 0,
      gap: "No persona: identity cannot be decided (casdoor or anonymous).",
    },
    {
      id: 2,
      name: "What they do: needs a test can check",
      ok: reqs.length > 0 && reqs.every((r) => (r.scenarios ?? []).some((s) => s.when && s.then)),
      gap: `Requirements without a WHEN/THEN scenario: ${reqs.filter((r) => !(r.scenarios ?? []).length).map((r) => r.id).join(", ") || "none listed"} — "done" would mean "code exists".`,
    },
    {
      id: 3,
      name: "Which data, and how much",
      ok: (brief.data ?? []).length > 0 && (brief.data ?? []).every((d) => d.volume),
      gap: "Data without a volume: 50 or 5,000 changes the screens and may buy a queue.",
    },
    {
      id: 4,
      name: "What must never happen",
      ok: (brief.never ?? []).length > 0,
      gap: "No invariant: the tests have nothing to protect.",
    },
    {
      id: 5,
      name: "What is out of scope",
      ok: (brief.out_of_scope ?? []).length > 0,
      gap: "No scope limit: every plausible brick looks wanted.",
    },
  ].map((c) => ({ ...c, gap: c.ok ? undefined : c.gap }));

  // Questions — each one changes a brick or a requirement, or it is not asked.
  const answered = brief.answers ?? {};
  const all: Question[] = [];
  for (const r of reqs) {
    if (RECURRENCE.test(r.text) && !HORIZON.test(r.text)) {
      all.push({
        id: `${r.id}-horizon`,
        ask: `"${r.text.match(RECURRENCE)![0]}" — until when?`,
        why: "An end date changes the data model; an open-ended rule never stops occupying the resource.",
        affects: `requirement ${r.id} (data model)`,
        default: "until an end date chosen at booking, at most 26 weeks",
      });
    }
    if (UPLOAD.test(r.text) && !r.persona) {
      all.push({
        id: `${r.id}-uploader`,
        ask: "Who may upload?",
        why: "A dedicated uploader is one more role, so one more test persona.",
        affects: `requirement ${r.id} (roles)`,
        default: "any persona listed on the requirement",
      });
    }
  }
  for (const d of brief.data ?? []) {
    if (!d.volume) {
      all.push({
        id: `data-${slug(d.entity)}-volume`,
        ask: `How many ${d.entity}?`,
        why: `Above ${g.thresholds.fanout_units} units per action the need test buys a queue and a worker.`,
        affects: "async-work need (valkey + worker, 4 points)",
        default: "under 300",
      });
    }
  }
  // An ambiguous blob signal: a file kind is named but nothing says it is uploaded or large.
  const bill = needTest(brief, g);
  for (const [rid, hits] of Object.entries(bill.hits)) {
    const blob = hits.filter((h) => h.need === "blob-storage").map((h) => h.signal);
    if (blob.length === 1 && blob[0] === "S-file-kind") {
      all.push({
        id: `${rid}-blob-size`,
        ask: g.needs["blob-storage"].question!,
        why: "Decides between a Postgres column and an S3 bucket.",
        affects: `s3 (${g.bricks.s3.ops_points} point) for ${rid}`,
        default: "binary and above 1 MB → s3",
      });
    }
  }
  const open = all.filter((q) => !(q.id in answered));
  const exhausted = round >= maxRounds;
  const score = criteria.filter((c) => c.ok).length;
  return {
    score,
    criteria,
    questions: exhausted ? [] : open.slice(0, maxQuestions),
    ready: (score === 5 && open.length === 0) || exhausted,
    defaults_applied: exhausted ? open : [],
  };
}
