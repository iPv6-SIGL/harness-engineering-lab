// domain.ts — DeskBook's business rules, pure: no I/O, no clock, no framework.
// One module on purpose (doctrine D-PURE): it is what the harness mutates to
// prove the tests can fail. Decision D3 lives here too: a weekly booking is a
// rule evaluated when someone reads the calendar — no job, no workflow.

export type Half = "am" | "pm";
export type Kind = "desk" | "room";

export type Booking = {
  id?: number;
  resourceId: number;
  userSub: string;
  day: string; // YYYY-MM-DD
  half: Half;
  repeatUntil: string | null; // weekly until this day, inclusive
};

export type Resource = {
  id: number;
  floor: number;
  kind: Kind;
  label: string;
  x: number;
  y: number;
  open: boolean;
};

export const MAX_REPEAT_WEEKS = 26;
const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function toUtc(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

export function addDays(day: string, n: number): string {
  return new Date(toUtc(day) + n * DAY_MS).toISOString().slice(0, 10);
}

export function dayDiff(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
}

export function isValidDay(day: unknown): day is string {
  return typeof day === "string" && DATE.test(day) && addDays(day, 0) === day;
}

export type RequestError = { code: string; message: string };

/** Validates a booking request against the rules a client cannot be trusted with. */
export function validateRequest(
  req: { day?: unknown; half?: unknown; repeatUntil?: unknown },
  today: string,
): RequestError | null {
  if (!isValidDay(req.day))
    return { code: "invalid-day", message: "day must be a date YYYY-MM-DD" };
  if (req.half !== "am" && req.half !== "pm")
    return { code: "invalid-half", message: "half must be am or pm" };
  if (req.day < today) return { code: "past-day", message: "a booking cannot start in the past" };
  if (req.repeatUntil === undefined || req.repeatUntil === null) return null;
  if (!isValidDay(req.repeatUntil))
    return { code: "invalid-repeat", message: "repeatUntil must be a date YYYY-MM-DD" };
  const days = dayDiff(req.day, req.repeatUntil);
  if (days < 7)
    return { code: "invalid-repeat", message: "repeatUntil must be at least one week after day" };
  if (days > MAX_REPEAT_WEEKS * 7)
    return {
      code: "repeat-too-long",
      message: `a booking repeats for ${MAX_REPEAT_WEEKS} weeks at most`,
    };
  return null;
}

/** Does booking b occupy its resource on `day`? The weekly rule, read at query time. */
export function occursOn(b: Booking, day: string): boolean {
  if (day === b.day) return true;
  if (!b.repeatUntil) return false;
  if (day < b.day || day > b.repeatUntil) return false;
  return dayDiff(b.day, day) % 7 === 0;
}

/** Every day the booking occupies. */
export function occurrences(b: Booking): string[] {
  const out = [b.day];
  if (!b.repeatUntil) return out;
  for (let d = addDays(b.day, 7); d <= b.repeatUntil; d = addDays(d, 7)) out.push(d);
  return out;
}

/** The first day on which `candidate` collides with one of `existing` (same half), or null. */
export function firstOverlap(candidate: Booking, existing: Booking[]): string | null {
  for (const day of occurrences(candidate)) {
    for (const e of existing) {
      if (e.half === candidate.half && occursOn(e, day)) return day;
    }
  }
  return null;
}

/** Never two bookings on the same resource and half-day. */
export function resourceConflict(candidate: Booking, onResource: Booking[]): string | null {
  return firstOverlap(
    candidate,
    onResource.filter((b) => b.resourceId === candidate.resourceId),
  );
}

/** Never an employee holding two desks on the same half-day (rooms are meetings, not seats). */
export function deskHolderConflict(
  candidate: Booking,
  usersDeskBookings: Booking[],
): string | null {
  return firstOverlap(
    candidate,
    usersDeskBookings.filter(
      (b) => b.userSub === candidate.userSub && b.resourceId !== candidate.resourceId,
    ),
  );
}

/** The n nearest free, open desks on the same floor — what a refused booking offers instead. */
export function nearestFree(
  target: Resource,
  all: Resource[],
  taken: Set<number>,
  n = 2,
): Resource[] {
  const d2 = (r: Resource) => (r.x - target.x) ** 2 + (r.y - target.y) ** 2;
  return all
    .filter(
      (r) =>
        r.floor === target.floor &&
        r.kind === "desk" &&
        r.open &&
        r.id !== target.id &&
        !taken.has(r.id),
    )
    .sort((a, b) => d2(a) - d2(b) || a.label.localeCompare(b.label))
    .slice(0, n);
}

/** The seeded office: `floors` floors of `rows`×`cols` desks plus two rooms each. */
export function seedLayout(floors = 3, rows = 6, cols = 11): Omit<Resource, "id">[] {
  const out: Omit<Resource, "id">[] = [];
  for (let f = 1; f <= floors; f++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        out.push({
          floor: f,
          kind: "desk",
          label: `F${f}-D${String(r * cols + c + 1).padStart(2, "0")}`,
          x: c * 60 + 40,
          y: r * 60 + 40,
          open: true,
        });
      }
    }
    out.push({ floor: f, kind: "room", label: `F${f}-R1`, x: cols * 60 + 60, y: 60, open: true });
    out.push({ floor: f, kind: "room", label: `F${f}-R2`, x: cols * 60 + 60, y: 240, open: true });
  }
  return out;
}

/** Roles from the IdP's groups: `built-in/<app>-<persona>` → `<persona>`. */
export function rolesFromGroups(groups: string[], app: string): string[] {
  const prefix = `built-in/${app}-`;
  return groups.filter((g) => g.startsWith(prefix)).map((g) => g.slice(prefix.length));
}
