import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-lease-race-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET ||= "exclusive-process-race-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");

const childScript = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.RACE_DB_PATH);
db.exec("PRAGMA busy_timeout = 30000");
const owner = process.argv[1];
const candidates = JSON.parse(process.argv[2]);
let result;
db.exec("BEGIN IMMEDIATE");
try {
  let connectionId = null;
  const occupied = db.prepare(
    "SELECT 1 FROM exclusive_connection_leases WHERE provider = 'codex' AND connection_id = ? AND state = 'ACTIVE'"
  );
  for (const candidate of candidates) if (!occupied.get(candidate)) { connectionId = candidate; break; }
  if (connectionId) {
    const now = new Date().toISOString();
    db.prepare(\`INSERT INTO exclusive_connection_leases
      (api_key_id, provider, owner_key, connection_id, generation, state,
       acquired_at, renewed_at, expires_at)
      VALUES ('race-key', 'codex', ?, ?, 1, 'ACTIVE', ?, ?, ?)\`)
      .run(owner, connectionId, now, now, new Date(Date.now() + 60000).toISOString());
    result = { kind: "acquired", lease: { connectionId } };
  } else result = { kind: "waiting", reason: "ALL_ELIGIBLE_CONNECTIONS_LEASED" };
  db.exec("COMMIT");
} catch (error) { db.exec("ROLLBACK"); throw error; }
db.close();
process.stdout.write(JSON.stringify(result));
`;
const RACE_DB_PATH = path.join(TEST_DATA_DIR, "race.sqlite");

async function runChild(owner: string, candidates: string[]) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx/esm", "--eval", childScript, owner, JSON.stringify(candidates)],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          RACE_DB_PATH,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) return reject(new Error(`child ${owner} failed (${code}): ${stderr}`));
      const jsonStart = stdout.lastIndexOf('{"kind"');
      resolve(JSON.parse(stdout.slice(jsonStart)));
    });
  });
}

test.before(async () => {
  await core.ensureDbInitialized();
  const sourceDb = core.getDbInstance();
  const schema = sourceDb
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'exclusive_connection_leases'")
    .get() as { sql: string };
  const { DatabaseSync } = await import("node:sqlite");
  const raceDb = new DatabaseSync(RACE_DB_PATH);
  raceDb.exec(schema.sql);
  raceDb.exec(`CREATE UNIQUE INDEX idx_race_active_connection
    ON exclusive_connection_leases(provider, connection_id) WHERE state = 'ACTIVE'`);
  raceDb.close();
  core.resetDbInstance();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("independent processes racing for nine connections never double allocate", async () => {
  const candidates = Array.from({ length: 9 }, (_, index) => `connection-${index + 1}`);
  const results = await Promise.all(
    Array.from({ length: 18 }, (_, index) => runChild(`owner-${index + 1}`, candidates))
  );
  const acquired = results.filter((result) => result.kind === "acquired");
  const waiting = results.filter((result) => result.kind === "waiting");
  assert.equal(acquired.length, 9);
  assert.equal(waiting.length, 9);
  assert.equal(new Set(acquired.map((result) => result.lease.connectionId)).size, 9);
  assert.ok(waiting.every((result) => result.reason === "ALL_ELIGIBLE_CONNECTIONS_LEASED"));
});
