from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
RECONCILE = ROOT / "ops/account-ops/reconcile.py"
LAUNCHER = ROOT / "ops/account-ops/codex-omni"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AccountOpsLeaseIntegrationTests(unittest.TestCase):
    def test_reconcile_atomic_create_cannot_publish_nonexclusive_key(self):
        source = RECONCILE.read_text(encoding="utf-8")
        self.assertIn('"managedExclusivePolicy"', source)
        self.assertIn('created.get("exclusiveSessionConnections") is not True', source)
        self.assertIn('"exclusiveSessionConnections": True', source)

    def test_reconcile_generates_named_launcher_through_generic_lease_authority(self):
        source = RECONCILE.read_text(encoding="utf-8")
        self.assertIn("exec /home/kas/.local/bin/codex-omni --managed-profile", source)
        self.assertIn('X-Session-Id = "CODEX_OMNI_SESSION_AFFINITY"', source)

    def test_generic_launcher_wraps_child_with_python_lease_helper(self):
        source = LAUNCHER.read_text(encoding="utf-8")
        self.assertIn('LEASE_HELPER = Path(', source)
        self.assertIn('[sys.executable, str(LEASE_HELPER), "run", "--", *command]', source)
        self.assertIn('exclusive_session_connections', source)
        self.assertIn('int(row[5] or 0) == 1', source)
        self.assertNotIn('os.exec', source)

    def test_reconcile_key_verification_emits_no_secret(self):
        module = load_module("lease_safe_reconcile", RECONCILE)
        secret = "sk-secret-must-not-appear"
        account = {"profile": "managed", "key_name": "managed-key"}
        responses = [
            (200, {"keys": []}, ""),
            (201, {"key": secret, "id": "key-id"}, ""),
            (200, {"keys": [{"id": "key-id", "exclusiveSessionConnections": False}]}, ""),
            (200, {}, ""),
        ]
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
            module, "account_paths", return_value=(Path(temporary) / "key.env", Path(), Path())
        ), mock.patch.object(module, "request_json", side_effect=responses):
            management = mock.Mock()
            management.ensure.return_value = "management-token"
            with self.assertRaisesRegex(RuntimeError, "atomically enable exclusivity") as raised:
                module.create_restricted_key(account, "connection-id", management)
        self.assertNotIn(secret, str(raised.exception))

    def test_existing_managed_key_update_preserves_scope_and_exclusivity(self):
        module = load_module("lease_safe_existing_reconcile", RECONCILE)
        calls = [
            (200, {}, ""),
            (
                200,
                {
                    "keys": [
                        {
                            "id": "key-id",
                            "allowedConnections": ["connection-id"],
                            "exclusiveSessionConnections": True,
                        }
                    ]
                },
                "",
            ),
        ]
        management = mock.Mock()
        management.ensure.return_value = "management-token"
        with mock.patch.object(module, "request_json", side_effect=calls) as request:
            module.ensure_existing_managed_key(
                {"id": "key-id"}, "connection-id", management
            )
        patch_body = request.call_args_list[0].args[2]
        self.assertEqual(patch_body["allowedConnections"], ["connection-id"])
        self.assertIs(patch_body["exclusiveSessionConnections"], True)


if __name__ == "__main__":
    unittest.main()
