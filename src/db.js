// Database adapter: uses real PostgreSQL in production (Render), PGlite in-process for
// local/sandbox runs. Both speak the same SQL dialect and $1 parameter style.
import 'dotenv/config';

let impl = null;
let kind = 'none';

export async function initDb() {
  const url = process.env.DATABASE_URL;
  const usePglite = !url || process.env.USE_PGLITE === '1';
  if (!usePglite) {
    const pg = (await import('pg')).default;
    const ssl = process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false };
    const pool = new pg.Pool({ connectionString: url, ssl });
    impl = { query: (s, p) => pool.query(s, p) };
    kind = 'postgres';
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = process.env.PGLITE_DIR || './.pglite';
    const lite = new PGlite(dir);
    await lite.waitReady;
    impl = { query: (s, p) => lite.query(s, p) };
    kind = 'pglite';
  }
  return kind;
}

export function dbKind() { return kind; }
export function q(sql, params) { return impl.query(sql, params); }
export async function one(sql, params) { const r = await impl.query(sql, params); return r.rows[0] || null; }
export async function all(sql, params) { const r = await impl.query(sql, params); return r.rows; }
