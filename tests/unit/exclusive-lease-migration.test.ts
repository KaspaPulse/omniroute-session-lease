import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const migrationPath = path.resolve(
  "src/lib/db/migrations/151_exclusive_session_connection_leases.sql"
);
const migrationSql = fs.readFileSync(migrationPath, "utf8");

test("migration 151 is idempotent and adds the API-key policy to an existing database", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE api_keys (id TEXT PRIMARY KEY)");
    db.exec(migrationSql);
    const columns = db.prepare("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "exclusive_session_connections")) {
      db.exec(
        "ALTER TABLE api_keys ADD COLUMN exclusive_session_connections INTEGER NOT NULL DEFAULT 0"
      );
    }
    assert.doesNotThrow(() => db.exec(migrationSql));
    assert.equal(
      Number(
        db
          .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE 'exclusive_%'")
          .get()?.count
      ) >= 1,
      true
    );
    assert.equal(
      (db.prepare("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>).some(
        (column) => column.name === "exclusive_session_connections"
      ),
      true
    );
  } finally {
    db.close();
  }
});

test("migration constraints reject two ACTIVE owners for one connection", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(migrationSql);
    const insert = db.prepare(`INSERT INTO exclusive_connection_leases
      (api_key_id, provider, owner_key, connection_id, generation, state,
       acquired_at, renewed_at, expires_at)
      VALUES (?, 'codex', ?, 'connection-1', 1, 'ACTIVE', ?, ?, ?)`);
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 60_000).toISOString();
    insert.run("key-a", "owner-a", now, now, expires);
    assert.throws(() => insert.run("key-b", "owner-b", now, now, expires), /UNIQUE/);
  } finally {
    db.close();
  }
});
