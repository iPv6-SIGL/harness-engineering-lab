import { describe, expect, test } from "bun:test";
import { afterExpiry } from "./flow";

describe("afterExpiry: what the status means when the 3 days are over", () => {
  test("nobody answered: the request expired, nothing is ordered", () => {
    expect(afterExpiry("expired")).toBe("stop");
  });
  test("approved, but the signal never arrived: the row decides, the order goes on", () => {
    expect(afterExpiry("approved")).toBe("order");
  });
  test("rejected or already closed: nothing to order", () => {
    expect(afterExpiry("rejected")).toBe("closed");
    expect(afterExpiry("ordered")).toBe("closed");
  });
});
