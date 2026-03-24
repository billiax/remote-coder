import { Pool } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool | null {
  return pool;
}

export async function initDb(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("[db] DATABASE_URL not set — running without database");
    return;
  }

  pool = new Pool({
    connectionString: url,
    max: 5,
    ssl: url.includes("azure.com") ? { rejectUnauthorized: false } : undefined,
  });

  // Test connection
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    console.log("[db] Connected to database");
  } finally {
    client.release();
  }

  // Run migrations
  await migrate();
}

async function migrate(): Promise<void> {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id    TEXT PRIMARY KEY,
      workspace     TEXT NOT NULL,
      model         TEXT NOT NULL DEFAULT 'sonnet',
      engine        TEXT NOT NULL DEFAULT 'claude',
      tools         JSONB,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_active   TIMESTAMPTZ NOT NULL DEFAULT now(),
      total_cost    DOUBLE PRECISION NOT NULL DEFAULT 0,
      total_turns   INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Add tools column if upgrading from older schema
  await pool.query(`
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tools JSONB;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity (
      id            SERIAL PRIMARY KEY,
      session_id    TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      role          TEXT NOT NULL,
      summary       TEXT,
      duration_ms   INTEGER,
      cost_usd      DOUBLE PRECISION,
      input_tokens  INTEGER,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_activity_session ON activity(session_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS request_logs (
      id            SERIAL PRIMARY KEY,
      session_id    TEXT,
      endpoint      TEXT NOT NULL,
      workspace     TEXT,
      engine        TEXT,
      model         TEXT,
      has_images    BOOLEAN NOT NULL DEFAULT false,
      image_count   INTEGER,
      image_meta    JSONB,
      status        TEXT NOT NULL DEFAULT 'ok',
      error_message TEXT,
      duration_ms   INTEGER,
      cost_usd      DOUBLE PRECISION,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_request_logs_created ON request_logs(created_at);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_request_logs_status ON request_logs(status) WHERE status != 'ok';
  `);

  console.log("[db] Schema ready");
}

// ─── Session helpers ───

export async function upsertSession(
  sessionId: string,
  workspace: string,
  model: string,
  engine: string,
  tools?: any[] | null,
): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO sessions (session_id, workspace, model, engine, tools)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (session_id) DO UPDATE SET last_active = now()`,
    [sessionId, workspace, model, engine, tools ? JSON.stringify(tools) : null],
  );
}

export async function recordActivity(
  sessionId: string,
  role: string,
  summary: string | null,
  durationMs: number | null,
  costUsd: number | null,
  inputTokens: number | null,
): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO activity (session_id, role, summary, duration_ms, cost_usd, input_tokens)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [sessionId, role, summary, durationMs, costUsd, inputTokens],
  );

  // Update session aggregates
  await pool.query(
    `UPDATE sessions
     SET last_active = now(),
         total_cost = total_cost + COALESCE($2, 0),
         total_turns = total_turns + 1
     WHERE session_id = $1`,
    [sessionId, costUsd],
  );
}

// ─── Request log helpers ───

export async function logRequest(opts: {
  sessionId?: string;
  endpoint: string;
  workspace?: string;
  engine?: string;
  model?: string;
  hasImages: boolean;
  imageCount?: number;
  imageMeta?: { index: number; media_type: string; base64_length: number; estimated_mb: string }[];
  status: "ok" | "error" | "validation_error";
  errorMessage?: string;
  durationMs?: number;
  costUsd?: number;
}): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO request_logs (session_id, endpoint, workspace, engine, model, has_images, image_count, image_meta, status, error_message, duration_ms, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      opts.sessionId ?? null,
      opts.endpoint,
      opts.workspace ?? null,
      opts.engine ?? null,
      opts.model ?? null,
      opts.hasImages,
      opts.imageCount ?? null,
      opts.imageMeta ? JSON.stringify(opts.imageMeta) : null,
      opts.status,
      opts.errorMessage ?? null,
      opts.durationMs ?? null,
      opts.costUsd ?? null,
    ],
  );
}

export async function deleteSessionDb(sessionId: string): Promise<void> {
  if (!pool) return;
  await pool.query(`DELETE FROM sessions WHERE session_id = $1`, [sessionId]);
}

export async function listSessionsDb(): Promise<
  { sessionId: string; workspace: string; model: string; engine: string; createdAt: Date; lastActive: Date; totalCost: number; totalTurns: number }[]
> {
  if (!pool) return [];
  const res = await pool.query(
    `SELECT session_id, workspace, model, engine, created_at, last_active, total_cost, total_turns
     FROM sessions ORDER BY last_active DESC`,
  );
  return res.rows.map((r: any) => ({
    sessionId: r.session_id,
    workspace: r.workspace,
    model: r.model,
    engine: r.engine,
    createdAt: r.created_at,
    lastActive: r.last_active,
    totalCost: r.total_cost,
    totalTurns: r.total_turns,
  }));
}
