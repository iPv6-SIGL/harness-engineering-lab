// db.ts — Postgres through Bun's built-in client, migrated at boot. Every piece
// of state — photos, the sizes made, sessions, login states — lives here, never
// in the API process: any replica can serve any request. The worker writes the
// `renditions` rows; the API owns the schema.
import { SQL } from "bun";

export type Db = SQL; // the pool or a transaction: same tagged-template API

export function connect(url: string): Db {
  return new SQL({ url, max: 10, idleTimeout: 30 });
}

/** Idempotent, and safe when several replicas boot at once: one migrates, the others wait. */
export async function migrate(pool: Db) {
  await pool.begin(async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('photoshelf:migrate'))`;
    await sql`CREATE TABLE IF NOT EXISTS batches (
      id serial PRIMARY KEY, sku text NOT NULL, created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS photos (
      id serial PRIMARY KEY, batch_id int NOT NULL REFERENCES batches(id), sku text NOT NULL,
      name text NOT NULL, format text NOT NULL CHECK (format IN ('jpeg','png')),
      width int NOT NULL, height int NOT NULL, widths int[] NOT NULL,
      on_shop boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now())`;
    await sql`CREATE INDEX IF NOT EXISTS photos_sku ON photos (sku)`;
    await sql`CREATE INDEX IF NOT EXISTS photos_batch ON photos (batch_id)`;
    // One row per size made: the primary key is what makes a redelivered message harmless.
    await sql`CREATE TABLE IF NOT EXISTS renditions (
      photo_id int NOT NULL REFERENCES photos(id), width int NOT NULL, bytes int NOT NULL,
      made_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (photo_id, width))`;
    await sql`CREATE TABLE IF NOT EXISTS sessions (
      token text PRIMARY KEY, sub text NOT NULL, name text NOT NULL, roles text[] NOT NULL, expires_at timestamptz NOT NULL)`;
    await sql`CREATE TABLE IF NOT EXISTS oauth_states (state text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())`;
  });
}

export type PhotoRow = {
  id: number;
  batch_id: number;
  sku: string;
  name: string;
  format: "jpeg" | "png";
  width: number;
  height: number;
  widths: number[];
  on_shop: boolean;
  made: number[];
};

/** Photos with the widths already made, as the domain reads them. */
export async function photos(
  sql: Db,
  where: { sku?: string; batchId?: number; id?: number },
): Promise<PhotoRow[]> {
  const rows = await sql`
    SELECT p.id, p.batch_id, p.sku, p.name, p.format, p.width, p.height,
           array_to_string(p.widths, ',') AS widths, p.on_shop,
           coalesce((SELECT string_agg(r.width::text, ',' ORDER BY r.width) FROM renditions r WHERE r.photo_id = p.id), '') AS made
    FROM photos p
    WHERE (${where.sku ?? null}::text IS NULL OR p.sku = ${where.sku ?? null}::text)
      AND (${where.batchId ?? null}::int IS NULL OR p.batch_id = ${where.batchId ?? null}::int)
      AND (${where.id ?? null}::int IS NULL OR p.id = ${where.id ?? null}::int)
    ORDER BY p.id`;
  const ints = (s: string) => (s ? s.split(",").map(Number) : []);
  return rows.map((r: Record<string, unknown>) => ({
    ...(r as PhotoRow),
    widths: ints(String(r.widths)),
    made: ints(String(r.made)),
  }));
}
