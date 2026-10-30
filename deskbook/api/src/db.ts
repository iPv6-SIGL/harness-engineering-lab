// db.ts — Postgres through Bun's built-in client. The schema is small enough to
// migrate at boot, idempotently; the seed is the office layout of the brief
// (about 200 desks on 3 floors, 2 rooms per floor). Every piece of state —
// bookings, sessions, login states — lives here, never in the API process:
// any replica can serve any request.
import { SQL } from "bun";
import { type Booking, type Half, type Resource, seedLayout } from "./domain";

export type Db = SQL; // the pool or a transaction: same tagged-template API

export function connect(url: string): Db {
  return new SQL({ url, max: 10, idleTimeout: 30 });
}

/** Idempotent, and safe when several replicas boot at once: one migrates, the others wait. */
export async function migrate(pool: Db) {
  await pool.begin(async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('deskbook:migrate'))`;
    await schema(sql);
  });
}

async function schema(sql: Db) {
  await sql`CREATE TABLE IF NOT EXISTS resources (
    id serial PRIMARY KEY, floor int NOT NULL, kind text NOT NULL CHECK (kind IN ('desk','room')),
    label text NOT NULL UNIQUE, x int NOT NULL, y int NOT NULL, open boolean NOT NULL DEFAULT true)`;
  await sql`CREATE TABLE IF NOT EXISTS bookings (
    id serial PRIMARY KEY, resource_id int NOT NULL REFERENCES resources(id), user_sub text NOT NULL,
    user_name text NOT NULL, day date NOT NULL, half text NOT NULL CHECK (half IN ('am','pm')),
    repeat_until date, created_at timestamptz NOT NULL DEFAULT now())`;
  await sql`CREATE INDEX IF NOT EXISTS bookings_resource ON bookings (resource_id, half)`;
  await sql`CREATE INDEX IF NOT EXISTS bookings_user ON bookings (user_sub, half)`;
  await sql`CREATE TABLE IF NOT EXISTS sessions (
    token text PRIMARY KEY, sub text NOT NULL, name text NOT NULL, roles text[] NOT NULL, expires_at timestamptz NOT NULL)`;
  await sql`CREATE TABLE IF NOT EXISTS oauth_states (state text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())`;
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM resources`;
  if (n === 0) {
    for (const r of seedLayout()) {
      await sql`INSERT INTO resources (floor, kind, label, x, y, open) VALUES (${r.floor}, ${r.kind}, ${r.label}, ${r.x}, ${r.y}, ${r.open}) ON CONFLICT (label) DO NOTHING`;
    }
  }
}

type Row = {
  id: number;
  resource_id: number;
  user_sub: string;
  day: string;
  half: Half;
  repeat_until: string | null;
};
export const toBooking = (r: Row): Booking => ({
  id: r.id,
  resourceId: r.resource_id,
  userSub: r.user_sub,
  day: r.day,
  half: r.half,
  repeatUntil: r.repeat_until,
});

/** Bookings that may occupy something on or after `from` (single ones from that day, weekly ones still running). */
export async function bookingsFrom(
  sql: Db,
  from: string,
  where: { resourceId?: number; userSub?: string; desksOnly?: boolean; half?: Half },
) {
  const rows: Row[] = await sql`
    SELECT b.id, b.resource_id, b.user_sub, b.day::text AS day, b.half, b.repeat_until::text AS repeat_until
    FROM bookings b JOIN resources r ON r.id = b.resource_id
    WHERE (b.day >= ${from}::date OR b.repeat_until >= ${from}::date)
      AND (${where.resourceId ?? null}::int IS NULL OR b.resource_id = ${where.resourceId ?? null}::int)
      AND (${where.userSub ?? null}::text IS NULL OR b.user_sub = ${where.userSub ?? null}::text)
      AND (${where.half ?? null}::text IS NULL OR b.half = ${where.half ?? null}::text)
      AND (${where.desksOnly ?? false} = false OR r.kind = 'desk')`;
  return rows.map(toBooking);
}

export async function resources(sql: Db, floor?: number): Promise<Resource[]> {
  return floor
    ? sql`SELECT * FROM resources WHERE floor = ${floor} ORDER BY id`
    : sql`SELECT * FROM resources ORDER BY id`;
}
