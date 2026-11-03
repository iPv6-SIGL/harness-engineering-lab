// plan.ts — what one stream message asks of the worker. The API decided the
// widths (api/src/domain.ts, never upscaled); the worker only makes the sizes
// still missing, so a redelivered message is harmless (decision D4).

export type PhotoJob = { onShop: boolean; widths: number[]; made: number[] };

export function sizesToMake(p: PhotoJob): number[] {
  if (!p.onShop) return [];
  return p.widths.filter((w) => !p.made.includes(w));
}

/**
 * A decoding error is permanent (the bytes will never become an image): the
 * message is acked and the photo marked failed. Anything else (the store, the
 * database) is transient: the message stays pending and is retried.
 */
export function isUnreadable(err: unknown): boolean {
  return /vips|unsupported image format|corrupt|premature end|read error|bad seek/i.test(
    String(err),
  );
}

export const originalKey = (photoId: number, format: string) =>
  `originals/${photoId}.${format === "jpeg" ? "jpg" : "png"}`;
export const renditionKey = (photoId: number, width: number) => `photos/${photoId}/${width}.webp`;

export type StreamEntry = { id: string; photoId: number };

/**
 * Reads an XREADGROUP / XAUTOCLAIM reply, whichever shape the client returns
 * (RESP2 arrays or a RESP3 map): entries are [id, [field, value, …]].
 */
export function parseEntries(reply: unknown): StreamEntry[] {
  const out: StreamEntry[] = [];
  const visit = (entries: unknown) => {
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      if (!Array.isArray(e) || typeof e[0] !== "string" || !Array.isArray(e[1])) continue;
      const fields = e[1] as unknown[];
      const i = fields.indexOf("photo");
      const photoId = Number(fields[i + 1]);
      if (i >= 0 && Number.isInteger(photoId) && photoId > 0) out.push({ id: e[0], photoId });
    }
  };
  if (reply === null || reply === undefined) return out;
  if (Array.isArray(reply)) {
    for (const s of reply) if (Array.isArray(s)) visit(s[1]);
  } else if (typeof reply === "object") {
    for (const v of Object.values(reply as Record<string, unknown>)) visit(v);
  }
  return out;
}
