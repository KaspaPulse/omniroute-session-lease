#!/usr/bin/env python3
"""Zero-model lifecycle client for OmniRoute exclusive session leases."""

from __future__ import annotations

import argparse
import json
import os
import random
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request


DEFAULT_BASE_URL = "http://127.0.0.1:20128"
DEFAULT_HEARTBEAT_SECONDS = 30
DEFAULT_LEASE_TTL_MS = 120_000
MIN_HEARTBEAT_SECONDS = 5
MAX_HEARTBEAT_SECONDS = 300
EXIT_WAITING_FOR_CAPACITY = 75


def request_json(
    base_url: str,
    api_key: str,
    session_id: str,
    method: str,
    body: dict[str, object] | None = None,
) -> dict[str, object]:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/v1/session-lease",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "X-Session-Id": session_id,
        },
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def lease_generation(payload: dict[str, object]) -> int:
    lease = payload.get("lease")
    if not isinstance(lease, dict):
        raise RuntimeError("active lease response is missing")
    generation = int(lease.get("generation", 0))
    if generation <= 0:
        raise RuntimeError("active lease generation is missing")
    return generation


def public_lease(payload: dict[str, object]) -> dict[str, object]:
    lease = payload.get("lease")
    if not isinstance(lease, dict):
        raise RuntimeError("active lease response is missing")
    return {
        "provider": lease.get("provider"),
        "generation": lease_generation(payload),
        "state": lease.get("state"),
    }


def heartbeat_interval() -> int:
    try:
        interval = int(
            os.environ.get(
                "EXCLUSIVE_SESSION_LEASE_HEARTBEAT_SECONDS",
                DEFAULT_HEARTBEAT_SECONDS,
            )
        )
    except ValueError:
        interval = DEFAULT_HEARTBEAT_SECONDS
    try:
        ttl_ms = int(os.environ.get("EXCLUSIVE_SESSION_LEASE_TTL_MS", DEFAULT_LEASE_TTL_MS))
    except ValueError:
        ttl_ms = DEFAULT_LEASE_TTL_MS
    if ttl_ms < 30_000 or ttl_ms > 1_800_000:
        ttl_ms = DEFAULT_LEASE_TTL_MS
    safe_max = max(MIN_HEARTBEAT_SECONDS, ttl_ms // 3_000)
    return min(max(interval, MIN_HEARTBEAT_SECONDS), MAX_HEARTBEAT_SECONDS, safe_max)


class LeaseGeneration:
    def __init__(self, generation: int) -> None:
        self._generation = generation
        self._lock = threading.Lock()

    def get(self) -> int:
        with self._lock:
            return self._generation

    def set(self, generation: int) -> None:
        with self._lock:
            self._generation = generation


def renew_loop(
    base_url: str,
    api_key: str,
    session_id: str,
    provider: str,
    generation: LeaseGeneration,
    stop_event: threading.Event,
) -> None:
    interval = heartbeat_interval()
    while not stop_event.wait(min(interval, max(MIN_HEARTBEAT_SECONDS, interval + random.uniform(-2, 2)))):
        try:
            result = request_json(
                base_url,
                api_key,
                session_id,
                "POST",
                {
                    "action": "renew",
                    "generation": generation.get(),
                    "provider": provider,
                },
            )
            generation.set(lease_generation(result))
        except urllib.error.HTTPError as error:
            if error.code not in {404, 409}:
                continue
            try:
                generation.set(
                    lease_generation(request_json(base_url, api_key, session_id, "GET"))
                )
            except (OSError, ValueError, RuntimeError, urllib.error.HTTPError):
                continue
        except (OSError, ValueError, RuntimeError):
            continue


def release_generation(
    base_url: str,
    api_key: str,
    session_id: str,
    provider: str,
    generation: int,
    reason: str,
) -> None:
    try:
        request_json(
            base_url,
            api_key,
            session_id,
            "POST",
            {
                "action": "release",
                "generation": generation,
                "provider": provider,
                "reason": reason,
            },
        )
    except (OSError, ValueError, RuntimeError, urllib.error.HTTPError):
        # TTL expiry is the crash/network recovery guard.
        pass


def run_with_lease(
    base_url: str,
    api_key: str,
    session_id: str,
    provider: str,
    model: str,
    command: list[str],
) -> int:
    if not command:
        raise RuntimeError("run requires a child command after --")
    try:
        acquired = request_json(
            base_url,
            api_key,
            session_id,
            "POST",
            {"action": "acquire", "model": model},
        )
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        if error.code == 503:
            print(body)
            return EXIT_WAITING_FOR_CAPACITY
        raise

    generation = LeaseGeneration(lease_generation(acquired))
    print(json.dumps({"lease": public_lease(acquired), "status": "LEASE_ACQUIRED"}, sort_keys=True))
    stop_event = threading.Event()
    heartbeat = threading.Thread(
        target=renew_loop,
        args=(
            base_url,
            api_key,
            session_id,
            provider,
            generation,
            stop_event,
        ),
        name="omniroute-exclusive-lease-heartbeat",
        daemon=True,
    )
    child = subprocess.Popen(command)
    heartbeat.start()

    def forward_signal(signum: int, _frame: object) -> None:
        try:
            child.send_signal(signum)
        except ProcessLookupError:
            pass

    previous_handlers = {
        signum: signal.signal(signum, forward_signal)
        for signum in (signal.SIGINT, signal.SIGTERM)
    }
    try:
        return child.wait()
    finally:
        stop_event.set()
        heartbeat.join(timeout=2)
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
        # Fetch the current fenced generation because request-time failover may
        # have replaced the initial lease while the child was running.
        try:
            generation.set(
                lease_generation(request_json(base_url, api_key, session_id, "GET"))
            )
        except (OSError, ValueError, RuntimeError, urllib.error.HTTPError):
            pass
        release_generation(
            base_url,
            api_key,
            session_id,
            provider,
            generation.get(),
            "OWNER_EXIT",
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "action",
        choices=["acquire", "get", "renew", "release", "heartbeat", "run"],
    )
    parser.add_argument("--generation", type=int)
    parser.add_argument("--provider", default="codex")
    parser.add_argument("--reason", default="OWNER_EXIT")
    parser.add_argument("--model", default="cx/gpt-5.6-sol")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    options = parser.parse_args()
    base_url = os.environ.get("OMNIROUTE_BASE_URL", DEFAULT_BASE_URL)
    api_key = os.environ.get("OMNIROUTE_API_KEY", "").strip()
    session_id = os.environ.get("CODEX_OMNI_SESSION_AFFINITY", "").strip()
    if not api_key or not session_id:
        parser.error("OMNIROUTE_API_KEY and CODEX_OMNI_SESSION_AFFINITY are required")

    try:
        if options.action == "run":
            command = options.command[1:] if options.command[:1] == ["--"] else options.command
            return run_with_lease(
                base_url,
                api_key,
                session_id,
                options.provider,
                options.model,
                command,
            )

        if options.action == "acquire":
            result = request_json(
                base_url,
                api_key,
                session_id,
                "POST",
                {"action": "acquire", "model": options.model},
            )
            print(json.dumps({"lease": public_lease(result)}, sort_keys=True))
            return 0

        if options.action == "get":
            result = request_json(base_url, api_key, session_id, "GET")
            print(json.dumps({"lease": public_lease(result)}, sort_keys=True))
            return 0

        current = request_json(base_url, api_key, session_id, "GET")
        generation = LeaseGeneration(options.generation or lease_generation(current))

        if options.action in {"renew", "release"}:
            result = request_json(
                base_url,
                api_key,
                session_id,
                "POST",
                {
                    "action": options.action,
                    "generation": generation.get(),
                    "provider": options.provider,
                    "reason": options.reason,
                },
            )
            if options.action == "renew":
                print(json.dumps({"lease": public_lease(result)}, sort_keys=True))
            else:
                print(json.dumps(result, sort_keys=True))
            return 0

        stop_event = threading.Event()
        renew_loop(
            base_url,
            api_key,
            session_id,
            options.provider,
            generation,
            stop_event,
        )
    except urllib.error.HTTPError as error:
        print(error.read().decode("utf-8", errors="replace"))
        return EXIT_WAITING_FOR_CAPACITY if error.code == 503 else 1
    except (OSError, ValueError, RuntimeError) as error:
        print(json.dumps({"error": str(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
