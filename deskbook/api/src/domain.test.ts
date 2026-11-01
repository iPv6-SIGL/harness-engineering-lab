import { describe, expect, test } from "bun:test";
import {
  addDays,
  type Booking,
  dayDiff,
  deskHolderConflict,
  firstOverlap,
  isValidDay,
  MAX_REPEAT_WEEKS,
  nearestFree,
  occurrences,
  occursOn,
  type Resource,
  resourceConflict,
  rolesFromGroups,
  seedLayout,
  validateRequest,
} from "./domain";

const b = (over: Partial<Booking> = {}): Booking => ({
  resourceId: 1,
  userSub: "u1",
  day: "2031-03-03",
  half: "am",
  repeatUntil: null,
  ...over,
});

describe("dates", () => {
  test("addDays crosses months and years", () => {
    expect(addDays("2031-01-31", 1)).toBe("2031-02-01");
    expect(addDays("2031-12-31", 1)).toBe("2032-01-01");
    expect(addDays("2031-03-10", -7)).toBe("2031-03-03");
    expect(addDays("2031-03-03", 0)).toBe("2031-03-03");
  });
  test("dayDiff is signed and exact", () => {
    expect(dayDiff("2031-03-03", "2031-03-10")).toBe(7);
    expect(dayDiff("2031-03-10", "2031-03-03")).toBe(-7);
    expect(dayDiff("2031-03-03", "2031-03-03")).toBe(0);
  });
  test("isValidDay refuses impossible dates and other shapes", () => {
    expect(isValidDay("2031-02-28")).toBe(true);
    expect(isValidDay("2031-02-30")).toBe(false);
    expect(isValidDay("2031-2-3")).toBe(false);
    expect(isValidDay(20310203)).toBe(false);
  });
});

describe("validateRequest", () => {
  const today = "2031-03-01";
  test("a plain booking is valid", () => {
    expect(validateRequest({ day: "2031-03-03", half: "pm" }, today)).toBeNull();
    expect(validateRequest({ day: today, half: "am" }, today)).toBeNull();
  });
  test("bad day, bad half, past day", () => {
    expect(validateRequest({ day: "nope", half: "am" }, today)?.code).toBe("invalid-day");
    expect(validateRequest({ day: "2031-03-03", half: "noon" }, today)?.code).toBe("invalid-half");
    expect(validateRequest({ day: "2031-02-28", half: "am" }, today)?.code).toBe("past-day");
  });
  test("repeat: at least a week, at most 26 weeks", () => {
    expect(validateRequest({ day: "2031-03-03", half: "am", repeatUntil: null }, today)).toBeNull();
    expect(validateRequest({ day: "2031-03-03", half: "am", repeatUntil: "x" }, today)?.code).toBe(
      "invalid-repeat",
    );
    expect(
      validateRequest({ day: "2031-03-03", half: "am", repeatUntil: "2031-03-09" }, today)?.code,
    ).toBe("invalid-repeat");
    expect(
      validateRequest({ day: "2031-03-03", half: "am", repeatUntil: "2031-03-10" }, today),
    ).toBeNull();
    const max = addDays("2031-03-03", MAX_REPEAT_WEEKS * 7);
    expect(validateRequest({ day: "2031-03-03", half: "am", repeatUntil: max }, today)).toBeNull();
    expect(
      validateRequest({ day: "2031-03-03", half: "am", repeatUntil: addDays(max, 1) }, today)?.code,
    ).toBe("repeat-too-long");
    expect(MAX_REPEAT_WEEKS).toBe(26);
  });
});

describe("the weekly rule, read at query time (D3)", () => {
  const weekly = b({ repeatUntil: "2031-03-24" });
  test("occursOn: the day itself, each week until the end, never after", () => {
    expect(occursOn(weekly, "2031-03-03")).toBe(true);
    expect(occursOn(weekly, "2031-03-10")).toBe(true);
    expect(occursOn(weekly, "2031-03-24")).toBe(true);
    expect(occursOn(weekly, "2031-03-31")).toBe(false);
    expect(occursOn(weekly, "2031-02-24")).toBe(false);
    expect(occursOn(weekly, "2031-03-11")).toBe(false);
    expect(occursOn(b(), "2031-03-10")).toBe(false);
    expect(occursOn(b(), "2031-03-03")).toBe(true);
  });
  test("occurrences lists every week, end inclusive", () => {
    expect(occurrences(weekly)).toEqual(["2031-03-03", "2031-03-10", "2031-03-17", "2031-03-24"]);
    expect(occurrences(b())).toEqual(["2031-03-03"]);
    expect(occurrences(b({ repeatUntil: "2031-03-16" }))).toEqual(["2031-03-03", "2031-03-10"]);
  });
});

describe("conflicts", () => {
  test("same resource, same half, same day → conflict on that day", () => {
    expect(resourceConflict(b({ userSub: "u2" }), [b()])).toBe("2031-03-03");
  });
  test("other half or other resource → no conflict", () => {
    expect(resourceConflict(b({ half: "pm" }), [b()])).toBeNull();
    expect(resourceConflict(b({ resourceId: 2 }), [b()])).toBeNull();
  });
  test("a single booking on a repeated week collides; the week after the end does not", () => {
    const weekly = b({ repeatUntil: "2031-03-24" });
    expect(resourceConflict(b({ userSub: "u2", day: "2031-03-17" }), [weekly])).toBe("2031-03-17");
    expect(resourceConflict(b({ userSub: "u2", day: "2031-03-31" }), [weekly])).toBeNull();
  });
  test("a new weekly booking collides with a later single one", () => {
    expect(
      firstOverlap(b({ repeatUntil: "2031-03-24" }), [b({ day: "2031-03-17", userSub: "u2" })]),
    ).toBe("2031-03-17");
  });
  test("one desk per employee per half-day, rebooking the same desk is the resource rule's job", () => {
    const held = [b({ resourceId: 7 })];
    expect(deskHolderConflict(b({ resourceId: 8 }), held)).toBe("2031-03-03");
    expect(deskHolderConflict(b({ resourceId: 8, half: "pm" }), held)).toBeNull();
    expect(deskHolderConflict(b({ resourceId: 8, userSub: "u2" }), held)).toBeNull();
    expect(deskHolderConflict(b({ resourceId: 7 }), held)).toBeNull();
  });
});

describe("nearestFree", () => {
  const r = (id: number, x: number, y: number, over: Partial<Resource> = {}): Resource => ({
    id,
    floor: 1,
    kind: "desk",
    label: `D${id}`,
    x,
    y,
    open: true,
    ...over,
  });
  const target = r(1, 0, 0);
  const all = [
    target,
    r(2, 60, 0),
    r(3, 0, 60),
    r(4, 120, 0),
    r(5, 10, 0, { floor: 2 }),
    r(6, 5, 0, { kind: "room" }),
    r(7, 1, 0, { open: false }),
  ];
  test("the n nearest open desks on the same floor, excluding the target and taken ones", () => {
    expect(nearestFree(target, all, new Set()).map((x) => x.id)).toEqual([2, 3]);
    expect(nearestFree(target, all, new Set([2])).map((x) => x.id)).toEqual([3, 4]);
    expect(nearestFree(target, all, new Set(), 3).map((x) => x.id)).toEqual([2, 3, 4]);
    expect(nearestFree(target, all, new Set([2, 3, 4]))).toEqual([]);
  });
  test("distance first, label breaks ties", () => {
    const tie = [
      target,
      r(9, 0, 30, { label: "B" }),
      r(8, 30, 0, { label: "A" }),
      r(10, 40, 0, { label: "C" }),
    ];
    expect(nearestFree(target, tie, new Set(), 3).map((x) => x.label)).toEqual(["A", "B", "C"]);
  });
});

describe("seed and roles", () => {
  test("3 floors × 66 desks + 2 rooms each", () => {
    const s = seedLayout();
    expect(s.length).toBe(204);
    expect(s.filter((x) => x.kind === "desk").length).toBe(198);
    expect(s.filter((x) => x.kind === "room" && x.floor === 2).length).toBe(2);
    expect(s[0]).toEqual({ floor: 1, kind: "desk", label: "F1-D01", x: 40, y: 40, open: true });
    expect(s[12]).toEqual({ floor: 1, kind: "desk", label: "F1-D13", x: 100, y: 100, open: true });
    expect(s[66].label).toBe("F1-R1");
    expect(s[67]).toMatchObject({ x: 720, y: 240 });
  });
  test("roles are the app's groups, stripped of their prefix", () => {
    expect(
      rolesFromGroups(
        [
          "built-in/deskbook-office-manager",
          "built-in/other-employee",
          "built-in/deskbook-employee",
        ],
        "deskbook",
      ),
    ).toEqual(["office-manager", "employee"]);
  });
});
