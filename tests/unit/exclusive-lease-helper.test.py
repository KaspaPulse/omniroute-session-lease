import importlib.util
import io
import json
import os
import threading
import time
import unittest
import urllib.error
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[2] / "bin" / "codex-omni-exclusive-lease.py"
SPEC = importlib.util.spec_from_file_location("exclusive_lease_helper", SCRIPT)
HELPER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(HELPER)


def response(generation=1, connection="connection-1"):
    return {
        "lease": {
            "provider": "codex",
            "connectionId": connection,
            "generation": generation,
            "state": "ACTIVE",
        }
    }


class FakeChild:
    def __init__(self, code=0):
        self.code = code

    def wait(self):
        return self.code

    def send_signal(self, _signum):
        pass


class ExclusiveLeaseHelperTests(unittest.TestCase):
    def run_helper(self, side_effect, child_code=0):
        with mock.patch.object(HELPER, "request_json", side_effect=side_effect), mock.patch.object(
            HELPER.subprocess, "Popen", return_value=FakeChild(child_code)
        ) as popen, mock.patch.object(HELPER, "renew_loop"), mock.patch.object(
            HELPER.signal, "signal", return_value=mock.Mock()
        ):
            code = HELPER.run_with_lease(
                "http://shadow", "test-key", "session-a", "codex", "cx/test", ["child"]
            )
        return code, popen

    def test_normal_exit_releases_immediately_with_latest_generation(self):
        calls = []

        def request_json(*args):
            calls.append(args)
            body = args[4] if len(args) > 4 else None
            if body and body.get("action") == "acquire":
                return response(1)
            if args[3] == "GET":
                return response(2, "connection-2")
            return {"released": True}

        code, popen = self.run_helper(request_json, 23)
        self.assertEqual(code, 23)
        popen.assert_called_once_with(["child"])
        self.assertEqual(calls[-1][4]["action"], "release")
        self.assertEqual(calls[-1][4]["generation"], 2)

    def test_503_prevents_child_launch_and_returns_waiting_exit(self):
        error = urllib.error.HTTPError("http://shadow", 503, "capacity", {}, io.BytesIO(b"{}"))
        with mock.patch.object(HELPER, "request_json", side_effect=error), mock.patch.object(
            HELPER.subprocess, "Popen"
        ) as popen, redirect_stdout(io.StringIO()):
            code = HELPER.run_with_lease(
                "http://shadow", "test-key", "session-a", "codex", "cx/test", ["child"]
            )
        self.assertEqual(code, HELPER.EXIT_WAITING_FOR_CAPACITY)
        popen.assert_not_called()

    def test_heartbeat_renews_and_rediscovers_generation_after_conflict(self):
        calls = []
        stop = threading.Event()

        def request_json(*args):
            calls.append(args)
            body = args[4] if len(args) > 4 else None
            if body and body.get("action") == "renew" and body["generation"] == 1:
                raise urllib.error.HTTPError("http://shadow", 409, "stale", {}, io.BytesIO())
            stop.set()
            return response(2)

        with mock.patch.object(HELPER, "heartbeat_interval", return_value=0), mock.patch.object(
            HELPER.random, "uniform", return_value=-HELPER.MIN_HEARTBEAT_SECONDS
        ), mock.patch.object(HELPER, "request_json", side_effect=request_json):
            HELPER.renew_loop(
                "http://shadow", "key", "session", "codex", HELPER.LeaseGeneration(1), stop
            )
        self.assertEqual(calls[0][4]["action"], "renew")
        self.assertEqual(calls[1][3], "GET")

    def test_crash_without_finalizer_has_no_release_and_relies_on_ttl(self):
        acquired = response(1)
        with mock.patch.object(HELPER, "request_json", return_value=acquired) as request_json:
            # A process killed after this acquisition cannot execute run_with_lease's finally block.
            HELPER.lease_generation(HELPER.request_json("url", "key", "session", "POST", {}))
        self.assertEqual(request_json.call_count, 1)
        self.assertFalse(any(call.args[4].get("action") == "release" for call in request_json.mock_calls))

    def test_public_output_omits_connection_identifier(self):
        payload = response(7, "private-connection-id")
        rendered = json.dumps(HELPER.public_lease(payload), sort_keys=True)
        self.assertNotIn("private-connection-id", rendered)
        self.assertNotIn("connectionId", rendered)
        self.assertIn('"generation": 7', rendered)

    def test_heartbeat_is_capped_safely_below_lease_ttl(self):
        with mock.patch.dict(
            os.environ,
            {
                "EXCLUSIVE_SESSION_LEASE_HEARTBEAT_SECONDS": "300",
                "EXCLUSIVE_SESSION_LEASE_TTL_MS": "30000",
            },
        ):
            self.assertEqual(HELPER.heartbeat_interval(), 10)

    def test_invalid_heartbeat_configuration_falls_back_to_bounded_defaults(self):
        with mock.patch.dict(
            os.environ,
            {
                "EXCLUSIVE_SESSION_LEASE_HEARTBEAT_SECONDS": "invalid",
                "EXCLUSIVE_SESSION_LEASE_TTL_MS": "invalid",
            },
        ):
            self.assertEqual(HELPER.heartbeat_interval(), HELPER.DEFAULT_HEARTBEAT_SECONDS)


if __name__ == "__main__":
    unittest.main()
