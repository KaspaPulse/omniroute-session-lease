from __future__ import annotations

import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "ops/account-dashboard/canonical_contract_adapter.py"
HOTFIX = ROOT / "ops/deployment/CONTROLLED_TELEMETRY_HOTFIX.sh"
SPEC = importlib.util.spec_from_file_location("canonical_contract_adapter", SOURCE)
assert SPEC and SPEC.loader
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)


class CanonicalDashboardAdapterTests(unittest.TestCase):
    now = 1786435200000

    def account(self, status: str, **overrides):
        value = {
            "status": status,
            "connection_id": f"synthetic-{status}",
            "quota_checked_at": "2026-08-11T07:59:00.000Z",
            "quota": {
                "normal": {
                    "remaining_percent": 70,
                    "reset_at": "2026-08-18T08:00:00.000Z",
                    "observed_at": "2026-08-11T07:59:00.000Z",
                }
            },
            "real_smoke": {
                "status": "PASS",
                "tested_at": "2026-08-11T07:59:30.000Z",
                "latency_ms": 25,
            },
        }
        value.update(overrides)
        return value

    def test_all_eight_canonical_states(self):
        fixtures = {
            "ready": self.account("ready"),
            "active": self.account("ready", active_assignment_count=1, max_concurrent=2),
            "busy": self.account("busy"),
            "waiting": self.account(
                "waiting_reset",
                quota={"normal": {"remaining_percent": 0, "reset_at": "2026-08-18T08:00:00.000Z", "observed_at": "2026-08-11T07:59:00.000Z"}},
            ),
            "degraded": self.account("needs_test"),
            "auth": self.account("auth_failed"),
            "disabled": self.account("missing_connection"),
            "unknown": self.account("needs_review"),
        }
        result = adapter.project_state({"accounts": fixtures}, now_ms=self.now)
        self.assertEqual({item["state"] for item in result["accounts"]}, set(adapter.STATES))
        self.assertEqual(result["summary"]["TOTAL"], 8)
        self.assertEqual(result["summary"]["routingEligible"], 2)
        for state in adapter.STATES:
            self.assertEqual(result["summary"][state], 1)

    def test_passed_reset_is_fail_closed_and_identifiers_are_hashed(self):
        value = self.account(
            "waiting_reset",
            quota={"normal": {"remaining_percent": 0, "reset_at": "2026-08-11T07:30:00.000Z", "observed_at": "2026-08-11T07:00:00.000Z"}},
        )
        result = adapter.project_account("private-name", value, now_ms=self.now)
        self.assertEqual(result["state"], "WAITING_QUOTA_RESET")
        self.assertTrue(result["quota"]["validationRequired"])
        self.assertFalse(result["routingEligible"])
        self.assertNotIn("synthetic-waiting_reset", str(result))

    def test_fresh_source_generation_outranks_old_probe_for_freshness(self):
        value = self.account(
            "ready",
            real_smoke={"status": "PASS", "tested_at": "2026-08-11T07:00:00.000Z"},
        )
        result = adapter.project_state(
            {
                "generated_at": "2026-08-11T07:59:50.000Z",
                "accounts": {"chatgpt-pro-primary": value},
            },
            now_ms=self.now,
        )
        account = result["accounts"][0]
        self.assertEqual(account["state"], "READY")
        self.assertTrue(account["routingEligible"])
        self.assertFalse(account["stale"])
        self.assertEqual(account["sourceTimestamp"], "2026-08-11T07:59:50Z")
        self.assertGreater(account["ageMs"], result["staleAfterMs"])

    def test_stale_source_generation_remains_unknown(self):
        result = adapter.project_state(
            {
                "generated_at": "2026-08-11T07:00:00.000Z",
                "accounts": {"chatgpt-plus-humoud19802": self.account("ready")},
            },
            now_ms=self.now,
        )
        account = result["accounts"][0]
        self.assertEqual(account["state"], "UNKNOWN")
        self.assertFalse(account["routingEligible"])
        self.assertTrue(account["stale"])

    def test_router_snapshot_projects_aliases_and_exact_summary_without_secrets(self):
        rows = []
        for index, name in enumerate(
            ["chatgpt-pro-primary", "chatgpt-plus-humoud19802", *[f"account-{i}" for i in range(7)]]
        ):
            rows.append(
                {
                    "connection_id": f"safe-fixture-id-{index}",
                    "name": name,
                    "is_active": True,
                    "test_status": "active",
                    "rate_limited": False,
                    "max_concurrent": 1,
                    "quota_remaining_percent": 100,
                    "quota_reset_at": "2026-08-18T08:00:00.000Z",
                    "quota_observed_at": "2026-08-11T07:59:45.000Z",
                    "last_probe_at": "2026-08-01T00:00:00.000Z",
                    "secret": "must-not-serialize",
                }
            )
        result = adapter.project_router_snapshot(
            {"source_timestamp": "2026-08-11T07:59:50.000Z", "accounts": rows},
            now_ms=self.now,
        )
        self.assertEqual(result["summary"]["TOTAL"], 9)
        self.assertEqual(result["summary"]["READY"], 9)
        self.assertEqual(result["summary"]["routingEligible"], 9)
        self.assertIn("chatgpt-pro-primary", str(result))
        self.assertIn("chatgpt-plus-humoud19802", str(result))
        self.assertNotIn("must-not-serialize", str(result))
        self.assertNotIn("safe-fixture-id-0", str(result))

    def test_router_sqlite_uses_latest_row_per_quota_window_and_projects_no_secrets(self):
        with tempfile.TemporaryDirectory() as temporary:
            database_path = Path(temporary) / "router.sqlite"
            database = sqlite3.connect(database_path)
            database.executescript(
                """
                CREATE TABLE provider_connections (
                  id TEXT PRIMARY KEY,
                  provider TEXT NOT NULL,
                  name TEXT,
                  priority INTEGER,
                  is_active INTEGER,
                  test_status TEXT,
                  rate_limited_until TEXT,
                  max_concurrent INTEGER,
                  last_tested TEXT,
                  last_health_check_at TEXT,
                  api_key TEXT,
                  access_token TEXT
                );
                CREATE TABLE quota_snapshots (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  provider TEXT NOT NULL,
                  connection_id TEXT NOT NULL,
                  window_key TEXT NOT NULL,
                  remaining_percentage REAL,
                  is_exhausted INTEGER,
                  next_reset_at TEXT,
                  created_at TEXT NOT NULL
                );
                """
            )
            for index, name in enumerate(
                ["chatgpt-pro-primary", "chatgpt-plus-humoud19802", *[f"account-{i}" for i in range(7)]]
            ):
                connection_id = f"private-connection-{index}"
                database.execute(
                    "INSERT INTO provider_connections VALUES (?, 'codex', ?, ?, 1, 'active', NULL, 1, ?, NULL, ?, ?)",
                    (
                        connection_id,
                        name,
                        index,
                        "2026-08-11T07:59:00Z",
                        "must-not-serialize-api-key",
                        "must-not-serialize-token",
                    ),
                )
                database.execute(
                    "INSERT INTO quota_snapshots (provider,connection_id,window_key,remaining_percentage,is_exhausted,next_reset_at,created_at) VALUES ('codex',?,'session',0,1,?,?)",
                    (connection_id, "2026-08-10T00:00:00Z", "2026-08-10T00:00:00Z"),
                )
                database.execute(
                    "INSERT INTO quota_snapshots (provider,connection_id,window_key,remaining_percentage,is_exhausted,next_reset_at,created_at) VALUES ('codex',?,'session',90,0,?,?)",
                    (connection_id, "2026-08-12T00:00:00Z", "2026-08-11T07:59:50Z"),
                )
            database.commit()
            database.close()

            snapshot = adapter.read_router_sqlite(database_path)
            result = adapter.project_router_snapshot(snapshot)
            serialized = str(result)
            self.assertEqual(result["summary"]["TOTAL"], 9)
            self.assertEqual(result["summary"]["READY"], 9)
            self.assertEqual(result["summary"]["routingEligible"], 9)
            self.assertNotIn("private-connection", serialized)
            self.assertNotIn("must-not-serialize", serialized)

    def test_hotfix_generates_direct_systemd_post_steps(self):
        source = HOTFIX.read_text(encoding="utf-8")
        self.assertIn(
            "ExecStartPost=/usr/bin/python3 %s --input %s --input-format router-sqlite --output %s",
            source,
        )
        self.assertIn("ExecStartPost=/bin/chmod 0644 %s", source)
        self.assertNotIn("ExecStartPost=/bin/sh -c", source)


if __name__ == "__main__":
    unittest.main()
