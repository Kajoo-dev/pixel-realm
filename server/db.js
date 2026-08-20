// Character persistence: "remember your previous character" on the entry
// screen (name/race/color/level, restored via a browser-local playerId --
// see the /api/character/:id route and the "join" handler's continueSaved
// path in index.js, plus getOrCreatePlayerId in public/js/game.js).
//
// Backed by a Render Postgres instance via the standard DATABASE_URL env
// var. Deliberately fully optional/best-effort: if DATABASE_URL isn't set
// (local dev, or the free Postgres instance has expired -- Render's free
// Postgres plan auto-deletes ~30 days after creation) every function below
// silently no-ops/returns null instead of throwing, so the game keeps
// working exactly as before (everyone just starts fresh each visit) rather
// than crashing or blocking joins on a database that may not exist.
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL || "";
// Render's Postgres requires SSL for external connections but presents a
// cert that Node's default strict verification rejects; rejectUnauthorized
// disabled matches Render's own documented connection snippet. Skipped
// entirely for a plain local Postgres (no sslmode negotiation needed).
const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false } })
  : null;

if (pool) {
  pool.on("error", (err) => {
    // A dropped idle connection shouldn't take the whole game server down --
    // log and let the next query attempt (which gets a fresh connection
    // from the pool) succeed or fail on its own.
    console.error("[db] idle client error:", err.message);
  });
}

let schemaReady = null; // Promise, so concurrent early callers share one CREATE TABLE attempt

async function ensureSchema() {
  if (!pool) return;
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS characters (
        player_key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        race TEXT NOT NULL,
        color TEXT NOT NULL,
        level INTEGER NOT NULL DEFAULT 1,
        xp DOUBLE PRECISION NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).then(() => {
      console.log("[db] characters table ready");
    }).catch((err) => {
      console.error("[db] failed to create characters table:", err.message);
      schemaReady = null; // allow a retry on the next call rather than wedging forever
      throw err;
    });
  }
  try {
    await schemaReady;
  } catch {
    // Swallow here too -- callers just get degraded (no persistence)
    // behavior, not a crash.
  }
}

// Returns {name, race, color, level, xp} or null (not found / no db / on
// any error -- errors are logged, never thrown, so a flaky DB read can't
// block someone from joining the game).
async function loadCharacter(playerKey) {
  if (!pool || !playerKey) return null;
  try {
    const { rows } = await pool.query(
      "SELECT name, race, color, level, xp FROM characters WHERE player_key = $1",
      [playerKey]
    );
    if (!rows.length) return null;
    const row = rows[0];
    return { name: row.name, race: row.race, color: row.color, level: row.level, xp: row.xp };
  } catch (err) {
    console.error("[db] loadCharacter failed:", err.message);
    return null;
  }
}

// Fire-and-forget upsert -- callers should NOT await this on a hot path
// (join ack, level-up tick); it deliberately never throws.
async function saveCharacter(playerKey, { name, race, color, level, xp }) {
  if (!pool || !playerKey) return;
  try {
    await pool.query(
      `INSERT INTO characters (player_key, name, race, color, level, xp, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (player_key) DO UPDATE SET
         name = EXCLUDED.name, race = EXCLUDED.race, color = EXCLUDED.color,
         level = EXCLUDED.level, xp = EXCLUDED.xp, updated_at = now()`,
      [playerKey, name, race, color, level, xp]
    );
  } catch (err) {
    console.error("[db] saveCharacter failed:", err.message);
  }
}

module.exports = { ensureSchema, loadCharacter, saveCharacter, isConfigured: !!pool };
