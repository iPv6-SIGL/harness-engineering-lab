import { describe, expect, test } from "bun:test";
import {
  batchProgress,
  canTakeOff,
  canUpload,
  imageInfo,
  isListed,
  isSku,
  MAX_BATCH,
  MAX_PHOTO_BYTES,
  missingWidths,
  originalKey,
  publicUrl,
  renditionKey,
  renditionWidths,
  rolesFromGroups,
  TARGET_WIDTHS,
  validateBatch,
} from "./domain";

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** A PNG header: signature, IHDR length + type, width, height. */
function png(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
    0x49,
    0x48,
    0x44,
    0x52,
    ...be32(width),
    ...be32(height),
    8,
    2,
    0,
    0,
    0,
  ]);
}

/** A JPEG header: SOI, an APP0 segment to skip, a fill byte, then a SOFn with the size. */
function jpeg(width: number, height: number, sof = 0xc0): Uint8Array {
  const app0 = [0xff, 0xe0, 0, 6, 0x4a, 0x46, 0x49, 0x46];
  const frame = [0xff, sof, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0];
  return Uint8Array.from([0xff, 0xd8, ...app0, 0xff, ...frame, 0, 0, 0]);
}

describe("imageInfo reads the header, not the name", () => {
  test("a PNG", () => {
    expect(imageInfo(png(2000, 1333))).toEqual({ format: "png", width: 2000, height: 1333 });
  });
  test("a PNG wider than 65535 pixels reads all four bytes", () => {
    expect(imageInfo(png(70_000, 300))).toEqual({ format: "png", width: 70_000, height: 300 });
    expect(imageInfo(png(300, 70_000))).toEqual({ format: "png", width: 300, height: 70_000 });
  });
  test("a PNG with a zero size is not an image", () => {
    expect(imageInfo(png(0, 10))).toBeNull();
    expect(imageInfo(png(10, 0))).toBeNull();
  });
  test("a truncated PNG header is not an image", () => {
    expect(imageInfo(png(2000, 1333).slice(0, 23))).toBeNull();
    expect(imageInfo(png(2000, 1333).slice(0, 24))).toEqual({
      format: "png",
      width: 2000,
      height: 1333,
    });
  });
  test("a wrong signature byte is not a PNG", () => {
    const b = png(800, 600);
    b[7] = 0x0b;
    expect(imageInfo(b)).toBeNull();
  });
  test("a JPEG, past its APP0 segment and a fill byte", () => {
    expect(imageInfo(jpeg(2000, 1500))).toEqual({ format: "jpeg", width: 2000, height: 1500 });
    expect(imageInfo(jpeg(640, 480))).toEqual({ format: "jpeg", width: 640, height: 480 });
  });
  test("every start-of-frame marker carries the size, the others do not", () => {
    expect(imageInfo(jpeg(500, 400, 0xc0))?.width).toBe(500);
    expect(imageInfo(jpeg(500, 400, 0xc2))?.width).toBe(500);
    expect(imageInfo(jpeg(500, 400, 0xcf))?.width).toBe(500);
    for (const notFrame of [0xc4, 0xc8, 0xcc, 0xd0, 0xbf]) {
      expect(imageInfo(jpeg(500, 400, notFrame))).toBeNull();
    }
  });
  test("a JPEG with a zero size is not an image", () => {
    expect(imageInfo(jpeg(0, 400))).toBeNull();
    expect(imageInfo(jpeg(400, 0))).toBeNull();
  });
  test("a JPEG whose segments lose their marker is not an image", () => {
    const b = jpeg(800, 600);
    b[2] = 0x00;
    expect(imageInfo(b)).toBeNull();
  });
  test("a JPEG with no frame before the end is not an image", () => {
    expect(imageInfo(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]))).toBeNull();
    expect(imageInfo(Uint8Array.from([0xff, 0xd8, 0xff]))).toBeNull();
  });
  test("text, an empty file, half a signature are not images", () => {
    expect(imageInfo(new TextEncoder().encode("not a photo, a text file"))).toBeNull();
    expect(imageInfo(new Uint8Array())).toBeNull();
    expect(imageInfo(Uint8Array.from([0xff, 0xd9, 0xff, 0xc0]))).toBeNull();
  });
});

describe("renditionWidths never upscales", () => {
  test("the three shop widths, in order", () => {
    expect(TARGET_WIDTHS).toEqual([320, 800, 1600]);
    expect(renditionWidths(2000)).toEqual([320, 800, 1600]);
  });
  test("exactly at a width, that width is made", () => {
    expect(renditionWidths(1600)).toEqual([320, 800, 1600]);
    expect(renditionWidths(1599)).toEqual([320, 800]);
    expect(renditionWidths(800)).toEqual([320, 800]);
    expect(renditionWidths(799)).toEqual([320]);
    expect(renditionWidths(320)).toEqual([320]);
  });
  test("500 pixels wide: only the 320 size", () => {
    expect(renditionWidths(500)).toEqual([320]);
  });
  test("narrower than 320: nothing", () => {
    expect(renditionWidths(319)).toEqual([]);
  });
});

describe("validateBatch refuses the whole batch on one bad file", () => {
  const ok = (name = "a.png", w = 2000) => ({ name, bytes: png(w, 1000) });
  test("a good batch: every photo with its widths", () => {
    const r = validateBatch("SKU-1", [ok("a.png"), { name: "b.jpg", bytes: jpeg(500, 300) }]);
    expect(r).toEqual({
      ok: true,
      photos: [
        {
          name: "a.png",
          info: { format: "png", width: 2000, height: 1000 },
          widths: [320, 800, 1600],
        },
        { name: "b.jpg", info: { format: "jpeg", width: 500, height: 300 }, widths: [320] },
      ],
    });
  });
  test("an invalid SKU", () => {
    expect(validateBatch("a b", [ok()])).toMatchObject({
      ok: false,
      error: { code: "invalid-sku" },
    });
    expect(validateBatch(undefined, [ok()])).toMatchObject({ ok: false });
  });
  test("no photo", () => {
    expect(validateBatch("SKU-1", [])).toMatchObject({ ok: false, error: { code: "no-photo" } });
  });
  test("200 photos pass, 201 do not", () => {
    expect(MAX_BATCH).toBe(200);
    const many = Array.from({ length: 200 }, (_, i) => ok(`p${i}.png`, 400));
    const r = validateBatch("SKU-1", many);
    expect(r.ok && r.photos.length).toBe(200);
    expect(validateBatch("SKU-1", [...many, ok()])).toMatchObject({
      ok: false,
      error: { code: "batch-too-large" },
    });
  });
  test("one text file refuses the batch, naming the file", () => {
    const r = validateBatch("SKU-1", [
      ok(),
      { name: "notes.txt", bytes: new TextEncoder().encode("hello") },
    ]);
    expect(r).toEqual({
      ok: false,
      error: { code: "not-an-image", message: "a photo is a JPEG or PNG image", file: "notes.txt" },
    });
  });
  test("a photo above 20 MB is refused, at 20 MB it is not", () => {
    expect(MAX_PHOTO_BYTES).toBe(20 * 1024 * 1024);
    const exact = new Uint8Array(MAX_PHOTO_BYTES);
    exact.set(png(2000, 1000));
    expect(validateBatch("SKU-1", [{ name: "big.png", bytes: exact }]).ok).toBe(true);
    const over = new Uint8Array(MAX_PHOTO_BYTES + 1);
    over.set(png(2000, 1000));
    expect(validateBatch("SKU-1", [{ name: "big.png", bytes: over }])).toMatchObject({
      ok: false,
      error: { code: "too-large", file: "big.png" },
    });
  });
  test("a photo narrower than 320 is refused", () => {
    expect(validateBatch("SKU-1", [ok("tiny.png", 300)])).toMatchObject({
      ok: false,
      error: { code: "too-small", file: "tiny.png" },
    });
  });
});

describe("SKUs", () => {
  test("3 to 32 letters, digits or dashes", () => {
    expect(isSku("ab1")).toBe(true);
    expect(isSku("A".repeat(32))).toBe(true);
    expect(isSku("ab")).toBe(false);
    expect(isSku("A".repeat(33))).toBe(false);
    expect(isSku("SKU_1")).toBe(false);
    expect(isSku(42)).toBe(false);
  });
});

describe("keys and public URLs", () => {
  test("originals and sizes live under separate prefixes", () => {
    expect(originalKey(7, "jpeg")).toBe("originals/7.jpg");
    expect(originalKey(7, "png")).toBe("originals/7.png");
    expect(renditionKey(7, 800)).toBe("photos/7/800.webp");
  });
  test("a public URL is base / bucket / key, whatever the trailing slashes", () => {
    expect(publicUrl("http://localhost:9000", "photoshelf", 7, 320)).toBe(
      "http://localhost:9000/photoshelf/photos/7/320.webp",
    );
    expect(publicUrl("http://localhost:9000//", "photoshelf", 7, 320)).toBe(
      "http://localhost:9000/photoshelf/photos/7/320.webp",
    );
  });
});

describe("listing, what is left to make, batch progress", () => {
  const p = (over = {}) => ({ onShop: true, widths: [320, 800], made: [320, 800], ...over });
  test("listed only when on the shop and every size exists", () => {
    expect(isListed(p())).toBe(true);
    expect(isListed(p({ made: [320] }))).toBe(false);
    expect(isListed(p({ onShop: false }))).toBe(false);
    expect(isListed(p({ widths: [], made: [] }))).toBe(false);
  });
  test("a redelivered message makes only the missing sizes", () => {
    expect(missingWidths(p({ made: [] }))).toEqual([320, 800]);
    expect(missingWidths(p({ made: [800] }))).toEqual([320]);
    expect(missingWidths(p())).toEqual([]);
  });
  test("a photo off the shop has nothing left to make", () => {
    expect(missingWidths(p({ onShop: false, made: [] }))).toEqual([]);
  });
  test("a batch is finished when every photo has its sizes", () => {
    expect(batchProgress([p(), p({ made: [320] })])).toEqual({
      total: 2,
      done: 1,
      finished: false,
    });
    expect(batchProgress([p(), p()])).toEqual({ total: 2, done: 2, finished: true });
  });
});

describe("roles", () => {
  test("marketing and catalog managers upload, only catalog managers take photos off", () => {
    expect(canUpload(["marketing"])).toBe(true);
    expect(canUpload(["catalog-manager"])).toBe(true);
    expect(canUpload(["shopper"])).toBe(false);
    expect(canTakeOff(["catalog-manager"])).toBe(true);
    expect(canTakeOff(["marketing"])).toBe(false);
  });
  test("roles are the app's groups, stripped of their prefix", () => {
    expect(
      rolesFromGroups(
        [
          "built-in/photoshelf-catalog-manager",
          "built-in/other-marketing",
          "built-in/photoshelf-marketing",
        ],
        "photoshelf",
      ),
    ).toEqual(["catalog-manager", "marketing"]);
  });
});
