// domain.ts — PhotoShelf's business rules, pure: no I/O, no clock, no framework.
// One module on purpose (doctrine D-PURE): it is what the harness mutates to
// prove the tests can fail. The API decides here WHAT a photo becomes (its
// format, its WebP widths); the worker (decision D4) only carries it out.

export type Format = "jpeg" | "png";
export type ImageInfo = { format: Format; width: number; height: number };

/** The WebP widths the shop pages use, narrowest first. */
export const TARGET_WIDTHS = [320, 800, 1600] as const;
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
export const MAX_BATCH = 200;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const u16 = (b: Uint8Array, i: number) => b[i] * 256 + b[i + 1];
const u32 = (b: Uint8Array, i: number) => u16(b, i) * 65536 + u16(b, i + 2);

/** Reads the format and size from the file's own header — never from its name or its Content-Type. */
export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length >= 24 && PNG_SIGNATURE.every((v, i) => bytes[i] === v)) {
    const width = u32(bytes, 16);
    const height = u32(bytes, 20);
    return width > 0 && height > 0 ? { format: "png", width, height } : null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegInfo(bytes);
  return null;
}

// A start-of-frame marker carries the size: SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
const isStartOfFrame = (m: number) =>
  m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

function jpegInfo(b: Uint8Array): ImageInfo | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (isStartOfFrame(marker)) {
      const height = u16(b, i + 5);
      const width = u16(b, i + 7);
      return width > 0 && height > 0 ? { format: "jpeg", width, height } : null;
    }
    i += 2 + u16(b, i + 2);
  }
  return null;
}

/** The sizes a photo gets: every target width up to its own — never upscaled. */
export function renditionWidths(originalWidth: number): number[] {
  return TARGET_WIDTHS.filter((w) => w <= originalWidth);
}

export type UploadError = { code: string; message: string; file?: string };
export type Upload = { name: string; bytes: Uint8Array };
export type Accepted = { name: string; info: ImageInfo; widths: number[] };

/** Validates a whole batch BEFORE anything is stored or queued: one bad file refuses the batch. */
export function validateBatch(
  sku: unknown,
  files: Upload[],
): { ok: true; photos: Accepted[] } | { ok: false; error: UploadError } {
  if (!isSku(sku))
    return {
      ok: false,
      error: { code: "invalid-sku", message: "sku is 3 to 32 letters, digits or dashes" },
    };
  if (files.length === 0)
    return { ok: false, error: { code: "no-photo", message: "upload at least one photo" } };
  if (files.length > MAX_BATCH)
    return {
      ok: false,
      error: { code: "batch-too-large", message: `a batch holds at most ${MAX_BATCH} photos` },
    };
  const photos: Accepted[] = [];
  for (const f of files) {
    if (f.bytes.length > MAX_PHOTO_BYTES)
      return {
        ok: false,
        error: { code: "too-large", message: "a photo is at most 20 MB", file: f.name },
      };
    const info = imageInfo(f.bytes);
    if (!info)
      return {
        ok: false,
        error: { code: "not-an-image", message: "a photo is a JPEG or PNG image", file: f.name },
      };
    const widths = renditionWidths(info.width);
    if (widths.length === 0)
      return {
        ok: false,
        error: {
          code: "too-small",
          message: `a photo is at least ${TARGET_WIDTHS[0]} pixels wide`,
          file: f.name,
        },
      };
    photos.push({ name: f.name, info, widths });
  }
  return { ok: true, photos };
}

export function isSku(sku: unknown): sku is string {
  return typeof sku === "string" && /^[A-Za-z0-9-]{3,32}$/.test(sku);
}

/** Where the bytes live in the bucket. The shop reads only `photos/`. */
export const originalKey = (photoId: number, format: Format) =>
  `originals/${photoId}.${format === "jpeg" ? "jpg" : "png"}`;
export const renditionKey = (photoId: number, width: number) => `photos/${photoId}/${width}.webp`;

/** The public URL of a size, as a browser sees the bucket (PUBLIC_BUCKET=1, decision D3). */
export function publicUrl(base: string, bucket: string, photoId: number, width: number): string {
  return `${base.replace(/\/+$/, "")}/${bucket}/${renditionKey(photoId, width)}`;
}

export type PhotoState = {
  onShop: boolean;
  widths: number[];
  made: number[];
};

/** A photo is listed on the shop when it is on it AND every one of its sizes exists. */
export function isListed(p: PhotoState): boolean {
  return p.onShop && p.widths.length > 0 && p.widths.every((w) => p.made.includes(w));
}

/** The sizes still to make — what a (re)delivered stream message must do, and only that. */
export function missingWidths(p: PhotoState): number[] {
  if (!p.onShop) return [];
  return p.widths.filter((w) => !p.made.includes(w));
}

export function batchProgress(photos: PhotoState[]): {
  total: number;
  done: number;
  finished: boolean;
} {
  const done = photos.filter((p) => missingWidths(p).length === 0).length;
  return { total: photos.length, done, finished: done === photos.length };
}

/** Who may do what. A catalog manager also uploads like marketing (brief, personas). */
export const canUpload = (roles: string[]) =>
  roles.includes("marketing") || roles.includes("catalog-manager");
export const canTakeOff = (roles: string[]) => roles.includes("catalog-manager");

export function rolesFromGroups(groups: string[], app: string): string[] {
  const prefix = `built-in/${app}-`;
  return groups.filter((g) => g.startsWith(prefix)).map((g) => g.slice(prefix.length));
}
