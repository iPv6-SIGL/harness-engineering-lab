import { describe, expect, test } from "bun:test";
import { originalKey, parseEntries, renditionKey, sizesToMake } from "./plan";

describe("sizesToMake", () => {
  test("only the missing sizes, nothing for a photo off the shop", () => {
    expect(sizesToMake({ onShop: true, widths: [320, 800], made: [] })).toEqual([320, 800]);
    expect(sizesToMake({ onShop: true, widths: [320, 800], made: [320] })).toEqual([800]);
    expect(sizesToMake({ onShop: false, widths: [320], made: [] })).toEqual([]);
  });
});

describe("keys match the API's", () => {
  test("originals and sizes", () => {
    expect(originalKey(3, "jpeg")).toBe("originals/3.jpg");
    expect(originalKey(3, "png")).toBe("originals/3.png");
    expect(renditionKey(3, 320)).toBe("photos/3/320.webp");
  });
});

describe("parseEntries", () => {
  test("a RESP2 XREADGROUP reply", () => {
    const reply = [
      [
        "photoshelf:resize",
        [
          ["1-0", ["photo", "7"]],
          ["2-0", ["photo", "8"]],
        ],
      ],
    ];
    expect(parseEntries(reply)).toEqual([
      { id: "1-0", photoId: 7 },
      { id: "2-0", photoId: 8 },
    ]);
  });
  test("a RESP3 map reply", () => {
    expect(parseEntries({ "photoshelf:resize": [["1-0", ["photo", "9"]]] })).toEqual([
      { id: "1-0", photoId: 9 },
    ]);
  });
  test("nothing, or entries without a photo, give nothing", () => {
    expect(parseEntries(null)).toEqual([]);
    expect(
      parseEntries([
        [
          "s",
          [
            ["1-0", ["other", "1"]],
            ["2-0", null],
          ],
        ],
      ]),
    ).toEqual([]);
  });
});
