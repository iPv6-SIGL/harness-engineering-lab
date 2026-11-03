// db.ts — Postgres through Bun's built-in client, migrated at boot. The system
// of record: requests, the team budget's moves, the simulated supplier's stock.
// The workflow keeps the WAITS (decision D2); the rows keep the FACTS, and two
// constraints hold the invariants whatever the code does:
//   - one open request per person and item (a partial unique index);
//   - one charge and one refund at most per request (the moves' primary key).
import { SQL } from "bun";
import { CATALOG, TEAM_BUDGET_CENTS } from "./domain";

export type Db = SQL; // the pool or a transaction: same tagged-template API

export function connect(url: string): Db {
  return new SQL({ url, max: 10, idleTimeout: 30 });
}

/** Idempotent, and safe when several replicas boot at once: one migrates, the others wait. */
export async function migrate(pool: Db) {
  await pool.begin(async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('gearup:migrate'))`;
    await sql`CREATE TABLE IF NOT EXISTS teams (
      id serial PRIMARY KEY, name text NOT NULL UNIQUE, budget_cents int NOT NULL CHECK (budget_cents >= 0))`;
    await sql`CREATE TABLE IF NOT EXISTS members (
      sub text PRIMARY KEY, name text NOT NULL, team_id int NOT NULL REFERENCES teams(id))`;
    await sql`CREATE TABLE IF NOT EXISTS items (
      sku text PRIMARY KEY, name text NOT NULL, price_cents int NOT NULL CHECK (price_cents > 0),
      supplier_stock int NOT NULL CHECK (supplier_stock >= 0))`;
    await sql`CREATE TABLE IF NOT EXISTS requests (
      id serial PRIMARY KEY, sub text NOT NULL, name text NOT NULL, team_id int NOT NULL REFERENCES teams(id),
      item_sku text NOT NULL REFERENCES items(sku), price_cents int NOT NULL,
      status text NOT NULL CHECK (status IN ('waiting','approved','ordered','rejected','expired','cancelled')),
      created_at timestamptz NOT NULL DEFAULT now(), remind_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
      reminded_at timestamptz, decided_by text, decided_at timestamptz, closed_at timestamptz)`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS one_open_request
      ON requests (sub, item_sku) WHERE status IN ('waiting','approved')`;
    await sql`CREATE TABLE IF NOT EXISTS budget_moves (
      request_id int NOT NULL REFERENCES requests(id), kind text NOT NULL CHECK (kind IN ('charge','refund')),
      amount_cents int NOT NULL, at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (request_id, kind))`;
    await sql`CREATE TABLE IF NOT EXISTS supplier_calls (
      id serial PRIMARY KEY, request_id int NOT NULL REFERENCES requests(id), ok boolean NOT NULL,
      at timestamptz NOT NULL DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS sessions (
      token text PRIMARY KEY, sub text NOT NULL, name text NOT NULL, roles text[] NOT NULL, expires_at timestamptz NOT NULL)`;
    await sql`CREATE TABLE IF NOT EXISTS oauth_states (state text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())`;
    await sql`INSERT INTO teams (name, budget_cents) VALUES ('default', ${TEAM_BUDGET_CENTS}) ON CONFLICT (name) DO NOTHING`;
    for (const i of CATALOG) {
      await sql`INSERT INTO items (sku, name, price_cents, supplier_stock)
                VALUES (${i.sku}, ${i.name}, ${i.priceCents}, ${i.stock}) ON CONFLICT (sku) DO NOTHING`;
    }
  });
}

/** Team assignment from the IdP is out of scope: a person joins the default team on first use. */
export async function teamOf(sql: Db, sub: string, name: string): Promise<number> {
  const [m] = await sql`
    INSERT INTO members (sub, name, team_id) SELECT ${sub}, ${name}, id FROM teams WHERE name = 'default'
    ON CONFLICT (sub) DO UPDATE SET name = EXCLUDED.name RETURNING team_id`;
  return m.team_id;
}

export type RequestRow = {
  id: number;
  sub: string;
  name: string;
  team_id: number;
  item_sku: string;
  item_name: string;
  price_cents: number;
  status: string;
  created_at: Date;
  remind_at: Date;
  expires_at: Date;
  reminded_at: Date | null;
  decided_by: string | null;
  closed_at: Date | null;
};

export async function requests(
  sql: Db,
  where: { id?: number; sub?: string; teamId?: number },
): Promise<RequestRow[]> {
  return sql`
    SELECT r.*, i.name AS item_name FROM requests r JOIN items i ON i.sku = r.item_sku
    WHERE (${where.id ?? null}::int IS NULL OR r.id = ${where.id ?? null}::int)
      AND (${where.sub ?? null}::text IS NULL OR r.sub = ${where.sub ?? null}::text)
      AND (${where.teamId ?? null}::int IS NULL OR r.team_id = ${where.teamId ?? null}::int)
    ORDER BY r.id DESC LIMIT 200`;
}

export async function moves(sql: Db, where: { teamId?: number; requestId?: number }) {
  const rows = await sql`
    SELECT m.request_id, m.kind, m.amount_cents, m.at FROM budget_moves m JOIN requests r ON r.id = m.request_id
    WHERE (${where.teamId ?? null}::int IS NULL OR r.team_id = ${where.teamId ?? null}::int)
      AND (${where.requestId ?? null}::int IS NULL OR m.request_id = ${where.requestId ?? null}::int)
    ORDER BY m.at`;
  return rows.map(
    (m: { request_id: number; kind: "charge" | "refund"; amount_cents: number; at: Date }) => ({
      requestId: m.request_id,
      kind: m.kind,
      amountCents: m.amount_cents,
      at: m.at,
    }),
  );
}
