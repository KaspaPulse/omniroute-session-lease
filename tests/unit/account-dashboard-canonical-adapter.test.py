from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "ops/account-dashboard/canonical_contract_adapter.py"
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


if __name__ == "__main__":
    unittest.main()

