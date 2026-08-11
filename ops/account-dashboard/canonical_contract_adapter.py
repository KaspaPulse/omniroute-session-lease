#!/usr/bin/env python3
"""Project the legacy 20140 account state into the canonical telemetry JSON contract."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import sqlite3
from typing import Any


STATES = (
    "READY",
    "ACTIVE",
    "BUSY",
    "WAITING_QUOTA_RESET",
    "DEGRADED",
    "AUTH_ERROR",
    "DISABLED",
    "UNKNOWN",
)
STALE_AFTER_MS = 15 * 60_000


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed and abs(parsed) != float("inf") else None


def _timestamp_ms(value: Any) -> int | None:
    raw = _text(value)
    if raw is None:
        return None
    try:
        parsed = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return int(parsed.timestamp() * 1000)


def _iso(value: int | None) -> str | None:
    if value is None:
        return None
    return dt.datetime.fromtimestamp(value / 1000, dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_id(connection: str) -> str:
    digest = hashlib.sha256(f"codex:{connection}".encode()).hexdigest()[:12]
    return f"codex-{digest}"


def _safe_display(value: Any, safe_id: str) -> str:
    candidate = _text(value)
    if candidate is None:
        return f"Account {safe_id[-6:]}"
    if "@" in candidate:
        local, domain = candidate.split("@", 1)
        return f"{local[:2]}***@{domain}"[:80]
    return candidate[:80]


def _canonical_state(
    legacy_status: str,
    *,
    enabled: bool,
    active: int,
    max_concurrent: int | None,
    remaining: float | None,
    reset_passed: bool,
    stale: bool,
) -> tuple[str, bool, str | None, str | None]:
    if not enabled or legacy_status in {"missing_connection", "key_error"}:
        return "DISABLED", False, "operational_configuration_error", "operational_configuration_error"
    if legacy_status == "auth_failed":
        return "AUTH_ERROR", False, "authentication_expired", None
    if legacy_status in {"waiting_reset", "waiting_limit", "profile_present_waiting_reset"} or (
        remaining is not None and remaining <= 0
    ):
        reason = "quota_reset_validation_required" if reset_passed else "quota_exhausted"
        return "WAITING_QUOTA_RESET", False, reason, None
    if legacy_status == "busy" or (
        max_concurrent is not None and max_concurrent > 0 and active >= max_concurrent
    ):
        return "BUSY", False, "concurrency_limit", None
    if stale:
        return "UNKNOWN", False, "telemetry_stale", None
    if legacy_status in {"needs_test", "test_error"}:
        return "DEGRADED", False, "live_validation_required", None
    if legacy_status == "needs_review":
        return "UNKNOWN", False, "health_not_validated", None
    if legacy_status == "ready" and active > 0:
        return "ACTIVE", True, None, None
    if legacy_status == "ready":
        return "READY", True, None, None
    return "UNKNOWN", False, "health_not_validated", None


def project_account(
    connection_name: str,
    account: dict[str, Any],
    *,
    now_ms: int,
    stale_after_ms: int = STALE_AFTER_MS,
    source_timestamp: str | None = None,
) -> dict[str, Any]:
    legacy_status = str(account.get("status") or "unknown").strip().lower()
    quota = _record(_record(account.get("quota")).get("normal"))
    smoke = _record(account.get("real_smoke"))
    remaining = _number(quota.get("remaining_percent"))
    reset_at = _text(quota.get("reset_at"))
    observed_at = _text(quota.get("observed_at")) or _text(account.get("quota_checked_at"))
    probe_at = _text(smoke.get("tested_at")) or _text(account.get("quota_checked_at")) or observed_at
    probe_ms = _timestamp_ms(probe_at)
    age_ms = None if probe_ms is None else max(0, now_ms - probe_ms)
    source_ms = _timestamp_ms(source_timestamp)
    source_ms = source_ms if source_ms is not None else probe_ms
    source_age_ms = None if source_ms is None else max(0, now_ms - source_ms)
    stale = source_age_ms is None or source_age_ms > stale_after_ms
    reset_ms = _timestamp_ms(reset_at)
    reset_passed = bool(remaining is not None and remaining <= 0 and reset_ms is not None and reset_ms <= now_ms)
    active = max(0, int(_number(account.get("active_assignment_count")) or (1 if legacy_status == "busy" else 0)))
    max_concurrent_raw = _number(account.get("max_concurrent"))
    max_concurrent = int(max_concurrent_raw) if max_concurrent_raw is not None else 1
    state, eligible, reason, disabled_reason = _canonical_state(
        legacy_status,
        enabled=account.get("enabled") is not False,
        active=active,
        max_concurrent=max_concurrent,
        remaining=remaining,
        reset_passed=reset_passed,
        stale=stale,
    )
    connection = _text(account.get("connection_id")) or connection_name
    safe_id = _safe_id(connection)
    smoke_status = str(smoke.get("status") or "").upper()
    probe_outcome = "SUCCESS" if smoke_status == "PASS" else "FAILURE" if smoke_status == "FAIL" else "UNKNOWN"

    return {
        "accountId": safe_id,
        "displayName": _safe_display(account.get("label"), safe_id),
        "provider": "codex",
        "state": state,
        "routingEligible": eligible,
        "routingIneligibleReason": reason,
        "activeAssignmentCount": active,
        "queuedAssignmentCount": max(0, int(_number(account.get("queued_assignment_count")) or 0)),
        "maxConcurrent": max_concurrent,
        "modelCapabilities": ["gpt-5.6-sol"],
        "quota": {
            "available": None if remaining is None else remaining > 0,
            "remainingPercent": remaining,
            "resetAt": reset_at,
            "observedAt": observed_at,
            "validationRequired": reset_passed,
        },
        "lastProbeAt": _iso(probe_ms),
        "lastProbeOutcome": probe_outcome,
        "probeLatencyMs": _number(smoke.get("latency_ms")),
        "sourceTimestamp": _iso(source_ms),
        "sourceAgeMs": source_age_ms,
        "stale": stale,
        "ageMs": age_ms,
        "disabledReason": disabled_reason,
    }


def project_state(
    state: dict[str, Any], *, now_ms: int | None = None, stale_after_ms: int = STALE_AFTER_MS
) -> dict[str, Any]:
    now_ms = now_ms if now_ms is not None else int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000)
    source_timestamp = _text(state.get("generated_at"))
    accounts = [
        project_account(
            name,
            _record(value),
            now_ms=now_ms,
            stale_after_ms=stale_after_ms,
            source_timestamp=source_timestamp,
        )
        for name, value in sorted(_record(state.get("accounts")).items())
    ]
    summary = {name: 0 for name in STATES}
    summary.update({"TOTAL": len(accounts), "routingEligible": 0})
    for account in accounts:
        summary[account["state"]] += 1
        summary["routingEligible"] += int(account["routingEligible"])
    return {
        "provider": "codex",
        "generatedAt": _text(state.get("generated_at")) or _iso(now_ms),
        "staleAfterMs": stale_after_ms,
        "summary": summary,
        "accounts": accounts,
    }


def project_router_snapshot(
    snapshot: dict[str, Any], *, now_ms: int | None = None, stale_after_ms: int = STALE_AFTER_MS
) -> dict[str, Any]:
    """Project a secret-free, read-only router DB snapshot into the canonical contract."""
    source_timestamp = _text(snapshot.get("source_timestamp"))
    accounts: list[dict[str, Any]] = []
    for row in snapshot.get("accounts", []):
        account = _record(row)
        connection_id = _text(account.get("connection_id")) or "missing"
        quota_observed_at = _text(account.get("quota_observed_at"))
        quota_remaining = _number(account.get("quota_remaining_percent"))
        quota = {
            "normal": {
                "remaining_percent": quota_remaining,
                "reset_at": _text(account.get("quota_reset_at")),
                "observed_at": quota_observed_at,
            }
        }
        status = "ready"
        if not bool(account.get("is_active", True)):
            status = "missing_connection"
        elif str(account.get("test_status") or "unknown").lower() in {
            "banned",
            "expired",
            "credits_exhausted",
        }:
            status = "auth_failed"
        elif quota_remaining is not None and quota_remaining <= 0:
            status = "waiting_reset"
        elif bool(account.get("rate_limited")):
            status = "needs_test"
        elif str(account.get("test_status") or "unknown").lower() not in {
            "active",
            "success",
            "ok",
            "ready",
        }:
            status = "needs_review"

        accounts.append(
            project_account(
                connection_id,
                {
                    "connection_id": connection_id,
                    "label": account.get("name"),
                    "enabled": bool(account.get("is_active", True)),
                    "status": status,
                    "active_assignment_count": account.get("active_assignment_count"),
                    "queued_assignment_count": account.get("queued_assignment_count"),
                    "max_concurrent": account.get("max_concurrent"),
                    "quota_checked_at": quota_observed_at,
                    "quota": quota,
                    "real_smoke": {
                        "status": "PASS"
                        if str(account.get("test_status") or "").lower()
                        in {"active", "success", "ok", "ready"}
                        else "UNKNOWN",
                        "tested_at": account.get("last_probe_at"),
                    },
                },
                now_ms=now_ms
                if now_ms is not None
                else int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000),
                stale_after_ms=stale_after_ms,
                source_timestamp=source_timestamp,
            )
        )

    summary = {name: 0 for name in STATES}
    summary.update({"TOTAL": len(accounts), "routingEligible": 0})
    for account in accounts:
        summary[account["state"]] += 1
        summary["routingEligible"] += int(account["routingEligible"])
    return {
        "provider": "codex",
        "generatedAt": source_timestamp
        or _iso(now_ms)
        or dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "staleAfterMs": stale_after_ms,
        "summary": summary,
        "accounts": sorted(accounts, key=lambda item: item["displayName"]),
    }


def read_router_sqlite(path: Path) -> dict[str, Any]:
    """Read only the secret-free fields needed for a lossless router-state projection."""
    database = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    database.row_factory = sqlite3.Row
    try:
        database.execute("PRAGMA query_only=ON")
        rows = database.execute(
            """
            WITH ranked_quota AS (
              SELECT connection_id,
                     window_key,
                     remaining_percentage,
                     is_exhausted,
                     next_reset_at,
                     created_at,
                     ROW_NUMBER() OVER (
                       PARTITION BY connection_id, window_key
                       ORDER BY datetime(created_at) DESC, id DESC
                     ) AS position
              FROM quota_snapshots
              WHERE provider='codex'
            ), latest_quota AS (
              SELECT connection_id,
                     MIN(remaining_percentage) AS quota_remaining_percent,
                     MAX(is_exhausted) AS is_exhausted,
                     MIN(next_reset_at) AS quota_reset_at,
                     MAX(created_at) AS quota_observed_at
              FROM ranked_quota
              WHERE position=1
              GROUP BY connection_id
            )
            SELECT pc.id AS connection_id,
                   pc.name,
                   pc.is_active,
                   pc.test_status,
                   CASE WHEN pc.rate_limited_until IS NOT NULL
                             AND datetime(pc.rate_limited_until) > datetime('now')
                        THEN 1 ELSE 0 END AS rate_limited,
                   pc.max_concurrent,
                   COALESCE(lq.quota_remaining_percent,
                            CASE WHEN lq.is_exhausted=1 THEN 0 END) AS quota_remaining_percent,
                   lq.quota_reset_at,
                   lq.quota_observed_at,
                   COALESCE(pc.last_tested, pc.last_health_check_at) AS last_probe_at
            FROM provider_connections pc
            LEFT JOIN latest_quota lq ON lq.connection_id=pc.id
            WHERE pc.provider='codex'
            ORDER BY pc.priority, pc.id
            """
        ).fetchall()
    finally:
        database.close()
    return {
        "source_timestamp": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "accounts": [dict(row) for row in rows],
    }


def write_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp.{os.getpid()}")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o640)
    os.replace(temporary, path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--input-format", choices=("legacy", "router-snapshot", "router-sqlite"), default="legacy"
    )
    args = parser.parse_args()
    if args.input_format == "router-sqlite":
        projection = project_router_snapshot(read_router_sqlite(args.input))
    else:
        payload = json.loads(args.input.read_text(encoding="utf-8"))
        projection = (
            project_router_snapshot(_record(payload))
            if args.input_format == "router-snapshot"
            else project_state(_record(payload))
        )
    write_atomic(args.output, projection)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
