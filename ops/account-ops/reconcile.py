#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import html
import json
import os
import pwd
import re
import shlex
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

BASE = Path("/opt/omniroute")
OPS = BASE / "account-ops"
PUBLIC = OPS / "public"
STATE_DIR = OPS / "state"
ACCOUNTS_FILE = OPS / "accounts.json"
STATE_FILE = STATE_DIR / "account-state.json"
DB_FILE = BASE / "data/storage.sqlite"
ADMIN_PASSWORD_FILE = BASE / "admin-password.txt"
ENV_FILE = BASE / ".env"

LOGIN_USER = os.environ.get("OMNI_ACCOUNT_USER", "kas")
USER_HOME = Path(os.environ.get("OMNI_ACCOUNT_HOME", f"/home/{LOGIN_USER}"))
CODEX_BIN = os.environ.get("OMNI_CODEX_BIN", "/home/kas/.local/bin/codex")
MODEL = "gpt-5.6-sol"
MODEL_ALIASES = [MODEL, f"cx/{MODEL}", f"codex/{MODEL}"]

TOKEN_PATTERNS = [
    re.compile(r"Bearer\s+[A-Za-z0-9._-]+", re.I),
    re.compile(r"\bsk-[A-Za-z0-9_-]{10,}\b"),
    re.compile(r"\boma_[A-Za-z0-9_-]{10,}\b"),
    re.compile(r"\beyJ[A-Za-z0-9._-]{30,}\b"),
]


def sanitize(value: Any, limit: int = 500) -> str:
    text = str(value or "")
    for pattern in TOKEN_PATTERNS:
        text = pattern.sub("[REDACTED]", text)
    return text.replace("\x00", "")[:limit]


def load_env_value(path: Path, key: str) -> str:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    for line in lines:
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1].strip()
    return ""


TS_IP = load_env_value(ENV_FILE, "TAILSCALE_IP")
OMNI_URL = f"http://{TS_IP}:20128"


def load_config() -> dict[str, Any]:
    with ACCOUNTS_FILE.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def load_state() -> dict[str, Any]:
    if not STATE_FILE.exists():
        return {"accounts": {}, "generated_at": None}
    try:
        with STATE_FILE.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            raise ValueError("invalid state")
        data.setdefault("accounts", {})
        return data
    except Exception:
        return {"accounts": {}, "generated_at": None}


def save_state(state: dict[str, Any]) -> None:
    account_gid = pwd.getpwnam(LOGIN_USER).pw_gid
    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o750)
    os.chown(STATE_DIR, 0, account_gid)
    os.chmod(STATE_DIR, 0o750)
    tmp = STATE_FILE.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.chown(tmp, 0, account_gid)
    os.chmod(tmp, 0o640)
    os.replace(tmp, STATE_FILE)


def db_rows() -> dict[str, dict[str, Any]]:
    connection = sqlite3.connect(f"file:{DB_FILE}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            """
            SELECT id, name, email, provider, is_active, test_status, last_tested,
                   last_error, error_code, rate_limited_until, backoff_level,
                   CASE
                     WHEN COALESCE(access_token, '') <> ''
                       OR COALESCE(refresh_token, '') <> ''
                       OR COALESCE(api_key, '') <> ''
                       OR COALESCE(id_token, '') <> ''
                     THEN 1 ELSE 0
                   END AS provider_credentials_present
            FROM provider_connections
            WHERE provider = 'codex'
            """
        ).fetchall()
        return {str(row["name"]): dict(row) for row in rows}
    finally:
        connection.close()


def request_json(
    method: str,
    url: str,
    payload: Any | None = None,
    token: str | None = None,
    api_key: str | None = None,
    timeout: int = 45,
) -> tuple[int, Any, str]:
    body = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", "replace")
            try:
                parsed = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                parsed = {}
            return response.status, parsed, raw
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            parsed = {}
        return error.code, parsed, raw
    except Exception as error:
        return 0, {}, str(error)


class ManagementSession:
    def __init__(self) -> None:
        self.token = ""
        self.token_id = ""

    def ensure(self) -> str:
        if self.token:
            return self.token
        password = ADMIN_PASSWORD_FILE.read_text(encoding="utf-8").strip()
        status, data, raw = request_json(
            "POST",
            f"{OMNI_URL}/api/cli/connect",
            {
                "password": password,
                "name": "account-ops-reconcile",
                "scope": "admin",
                "expiresInDays": 1,
            },
            timeout=20,
        )
        if status != 200 or not isinstance(data, dict) or not data.get("token"):
            raise RuntimeError(f"management token failed ({status}): {sanitize(raw)}")
        self.token = str(data["token"])
        self.token_id = str(data.get("id") or "")
        return self.token

    def close(self) -> None:
        if self.token and self.token_id:
            request_json(
                "DELETE",
                f"{OMNI_URL}/api/cli/tokens/{self.token_id}",
                token=self.token,
                timeout=10,
            )
        self.token = ""
        self.token_id = ""


def shell_secret_from_env(path: Path) -> str:
    if not path.exists():
        return ""
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("export OMNIROUTE_API_KEY="):
            value = stripped.split("=", 1)[1].strip()
        elif stripped.startswith("OMNIROUTE_API_KEY="):
            value = stripped.split("=", 1)[1].strip()
        else:
            continue
        try:
            parts = shlex.split(value)
            return parts[0] if parts else value
        except ValueError:
            return value.strip("'\"")
    return ""


def account_paths(account: dict[str, Any]) -> tuple[Path, Path, Path]:
    slug = account["profile"]
    env_file = Path(
        account.get("env_file")
        or USER_HOME / ".config" / "omniroute" / "accounts" / f"{slug}.env"
    )
    profile_file = Path(
        account.get("profile_file") or USER_HOME / ".codex" / f"{slug}.config.toml"
    )
    launcher_file = Path(
        account.get("launcher_file") or USER_HOME / ".local" / "bin" / account["command"]
    )
    return env_file, profile_file, launcher_file


def key_name(account: dict[str, Any]) -> str:
    return str(account.get("key_name") or f"account-{account['profile']}")


def list_keys(token: str) -> list[dict[str, Any]]:
    status, data, raw = request_json("GET", f"{OMNI_URL}/api/keys", token=token, timeout=20)
    if status != 200:
        raise RuntimeError(f"list keys failed ({status}): {sanitize(raw)}")
    keys = data.get("keys", []) if isinstance(data, dict) else []
    return keys if isinstance(keys, list) else []


def create_restricted_key(
    account: dict[str, Any],
    connection_id: str,
    management: ManagementSession,
) -> tuple[str, str]:
    token = management.ensure()
    desired_name = key_name(account)
    env_file, _, _ = account_paths(account)

    for existing in list_keys(token):
        if existing.get("name") == desired_name:
            existing_id = str(existing.get("id") or "")
            if existing_id:
                request_json(
                    "DELETE",
                    f"{OMNI_URL}/api/keys/{existing_id}",
                    token=token,
                    timeout=20,
                )

    status, data, raw = request_json(
        "POST",
        f"{OMNI_URL}/api/keys",
        {
            "name": desired_name,
            "scopes": ["self:usage"],
            "allowUsageCommand": True,
            "managedExclusivePolicy": {
                "allowedConnections": [connection_id],
                "allowedModels": MODEL_ALIASES,
                "allowedCombos": [],
                "autoResolve": False,
                "maxSessions": 1,
            },
        },
        token=token,
        timeout=20,
    )
    if status != 201 or not data.get("key") or not data.get("id"):
        raise RuntimeError(f"create key failed ({status}): {sanitize(raw)}")

    api_key = str(data["key"])
    api_key_id = str(data["id"])

    created = next(
        (item for item in list_keys(token) if str(item.get("id") or "") == api_key_id),
        None,
    )
    if not created or created.get("exclusiveSessionConnections") is not True:
        request_json(
            "DELETE",
            f"{OMNI_URL}/api/keys/{api_key_id}",
            token=token,
            timeout=20,
        )
        raise RuntimeError("managed key creation did not atomically enable exclusivity")

    env_file.parent.mkdir(parents=True, exist_ok=True)
    env_file.write_text(f"export OMNIROUTE_API_KEY={shlex.quote(api_key)}\n", encoding="utf-8")
    os.chmod(env_file, 0o600)
    subprocess.run(
        ["chown", f"{LOGIN_USER}:{LOGIN_USER}", str(env_file)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return api_key, api_key_id



def create_profile(account: dict[str, Any]) -> None:
    env_file, profile_file, launcher_file = account_paths(account)
    profile = account["profile"]

    profile_file.parent.mkdir(parents=True, exist_ok=True)
    profile_file.write_text(
        f"""model = "{MODEL}"
model_provider = "omniroute"
model_reasoning_effort = "xhigh"

[model_providers.omniroute]
name = "OmniRoute"
base_url = "{OMNI_URL}/v1"
env_key = "OMNIROUTE_API_KEY"
requires_openai_auth = false
wire_api = "responses"

[model_providers.omniroute.env_http_headers]
X-Session-Id = "CODEX_OMNI_SESSION_AFFINITY"
""",
        encoding="utf-8",
    )
    os.chmod(profile_file, 0o600)

    launcher_file.parent.mkdir(parents=True, exist_ok=True)
    launcher_file.write_text(
        f"""#!/usr/bin/env bash
set -Eeuo pipefail
exec /home/kas/.local/bin/codex-omni --managed-profile {shlex.quote(profile)} \
  --managed-env-file {shlex.quote(str(env_file))} "$@"
""",
        encoding="utf-8",
    )
    os.chmod(launcher_file, 0o700)

    subprocess.run(
        [
            "chown",
            f"{LOGIN_USER}:{LOGIN_USER}",
            str(profile_file),
            str(launcher_file),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def parse_timestamp(value: Any) -> dt.datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def _has_explicit_reset_event(
    events: list[dict[str, Any]],
    trusted_observed: dt.datetime | None,
    candidate_observed: dt.datetime | None,
) -> bool:
    if candidate_observed is None:
        return False
    for event in events:
        observed = parse_timestamp(event.get("observed_at") or event.get("created_at"))
        if observed is None or observed > candidate_observed:
            continue
        if trusted_observed is not None and observed < trusted_observed:
            continue
        previous = event.get("previous_remaining_percentage")
        new = event.get("new_remaining_percentage")
        try:
            if previous is not None and new is not None and float(new) > float(previous):
                return True
        except (TypeError, ValueError):
            continue
    return False



def _first_live_value(record: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in record:
            return record[key]
    return None


def _live_window_state(window_key: str, raw: Any, observed_at: str) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None

    remaining_raw = _first_live_value(
        raw,
        "remaining",
        "remainingPercentage",
        "remaining_percentage",
        "remainingPercent",
        "remaining_percent",
    )
    used_raw = _first_live_value(
        raw,
        "used",
        "usedPercentage",
        "used_percentage",
        "usedPercent",
        "used_percent",
    )
    exhausted_raw = _first_live_value(raw, "isExhausted", "is_exhausted", "exhausted")
    reset_at = _first_live_value(
        raw,
        "nextResetAt",
        "next_reset_at",
        "resetAt",
        "reset_at",
        "resetsAt",
        "resets_at",
    )
    duration = _first_live_value(
        raw,
        "windowDurationMs",
        "window_duration_ms",
        "durationMs",
        "duration_ms",
    )

    remaining = None
    if remaining_raw is not None:
        try:
            remaining = max(0.0, min(100.0, float(remaining_raw)))
        except (TypeError, ValueError):
            remaining = None

    used = None
    if used_raw is not None:
        try:
            used = max(0.0, min(100.0, float(used_raw)))
        except (TypeError, ValueError):
            used = None
    elif remaining is not None:
        used = max(0.0, min(100.0, 100.0 - remaining))

    exhausted = (
        bool(remaining is not None and remaining <= 0.0)
        if exhausted_raw is None
        else bool(exhausted_raw)
    )

    return {
        "window_key": window_key,
        "used_percent": used,
        "remaining_percent": remaining,
        "is_exhausted": exhausted,
        "reset_at": reset_at,
        "window_duration_ms": duration,
        "observed_at": observed_at,
        "trusted": True,
        "authoritative": True,
        "source": "live_provider",
        "rejected_snapshot_count": 0,
        "rejected_reasons": [],
        "latest_raw_remaining_percent": remaining,
        "latest_raw_reset_at": reset_at,
        "latest_raw_observed_at": observed_at,
        "latest_raw_was_rejected": False,
    }


def quota_state_from_live_payload(data: Any, observed_at: str) -> dict[str, Any] | None:
    if not isinstance(data, dict):
        return None
    quotas = data.get("quotas")
    if not isinstance(quotas, dict):
        return None

    normal = _live_window_state("session", quotas.get("session"), observed_at)
    if normal is None or normal.get("remaining_percent") is None:
        return None

    named: dict[str, dict[str, Any]] = {}
    for key, value in quotas.items():
        if key == "session":
            continue
        clean = _live_window_state(str(key), value, observed_at)
        if clean is not None:
            named[str(key)] = clean

    return {"normal": normal, "named": named}


def live_quota_state(
    connection_id: str,
    management: ManagementSession,
) -> tuple[dict[str, Any] | None, str]:
    observed_at = dt.datetime.now(dt.timezone.utc).isoformat()
    try:
        token = management.ensure()
        status, data, raw = request_json(
            "GET",
            f"{OMNI_URL}/api/usage/{connection_id}",
            token=token,
            timeout=50,
        )
    except Exception as error:
        return None, sanitize(error)

    if status != 200:
        return None, f"HTTP {status}: {sanitize(raw, 240)}"

    quota = quota_state_from_live_payload(data, observed_at)
    if quota is None:
        return None, "HTTP 200 without a valid session quota"

    return quota, ""


def _select_trusted_snapshot_sequence(
    rows: list[dict[str, Any]], events: list[dict[str, Any]] | None = None
) -> dict[str, Any] | None:
    """Return the newest monotonic/trusted quota snapshot for one window.

    Inside a still-active quota window, remaining quota may stay the same or
    decrease.  It must not increase, nor may an exhausted window become
    available, unless the prior reset time has passed or a reset event
    explicitly records the increase.
    """
    events = events or []
    trusted: dict[str, Any] | None = None
    rejected = 0
    rejected_reasons: list[str] = []
    latest_raw: dict[str, Any] | None = None

    for raw in rows:
        candidate = dict(raw)
        latest_raw = candidate
        try:
            remaining = float(candidate.get("remaining_percentage"))
        except (TypeError, ValueError):
            rejected += 1
            rejected_reasons.append("INVALID_REMAINING")
            continue
        if not 0.0 <= remaining <= 100.0:
            rejected += 1
            rejected_reasons.append("OUT_OF_RANGE_REMAINING")
            continue

        candidate_observed = parse_timestamp(candidate.get("created_at"))
        if candidate_observed is None:
            rejected += 1
            rejected_reasons.append("INVALID_OBSERVED_AT")
            continue

        if trusted is None:
            trusted = candidate
            continue

        try:
            trusted_remaining = float(trusted.get("remaining_percentage"))
        except (TypeError, ValueError):
            trusted = candidate
            continue

        trusted_observed = parse_timestamp(trusted.get("created_at"))
        trusted_reset = parse_timestamp(trusted.get("next_reset_at"))
        before_trusted_reset = bool(
            trusted_reset is not None and candidate_observed < trusted_reset
        )
        increase = remaining > trusted_remaining + 1e-9
        exhausted_to_available = bool(
            trusted.get("is_exhausted") and not candidate.get("is_exhausted")
        )

        if (
            before_trusted_reset
            and (increase or exhausted_to_available)
            and not _has_explicit_reset_event(
                events, trusted_observed, candidate_observed
            )
        ):
            rejected += 1
            rejected_reasons.append(
                "EXHAUSTED_BECAME_AVAILABLE_BEFORE_RESET"
                if exhausted_to_available
                else "REMAINING_INCREASED_BEFORE_RESET"
            )
            continue

        trusted = candidate

    if trusted is None:
        return None

    trusted = dict(trusted)
    trusted["trusted"] = True
    trusted["rejected_snapshot_count"] = rejected
    trusted["rejected_reasons"] = sorted(set(rejected_reasons))
    if latest_raw is not None:
        trusted["latest_raw_remaining_percentage"] = latest_raw.get(
            "remaining_percentage"
        )
        trusted["latest_raw_reset_at"] = latest_raw.get("next_reset_at")
        trusted["latest_raw_created_at"] = latest_raw.get("created_at")
        trusted["latest_raw_was_rejected"] = bool(
            latest_raw.get("id") != trusted.get("id")
        )
    return trusted


def latest_quota_snapshots() -> dict[str, dict[str, dict[str, Any]]]:
    connection = sqlite3.connect(f"file:{DB_FILE}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        snapshot_rows = connection.execute(
            """
            SELECT q.id, q.connection_id, q.window_key, q.remaining_percentage,
                   q.is_exhausted, q.next_reset_at, q.window_duration_ms,
                   q.created_at, p.name AS connection_name
            FROM quota_snapshots q
            JOIN provider_connections p ON p.id = q.connection_id
            WHERE q.provider = 'codex'
            ORDER BY q.connection_id, q.window_key, q.created_at, q.id
            """
        ).fetchall()

        try:
            event_rows = connection.execute(
                """
                SELECT connection_id, window_key, observed_at, created_at,
                       previous_remaining_percentage, new_remaining_percentage
                FROM provider_quota_reset_events
                WHERE provider = 'codex'
                ORDER BY connection_id, window_key, observed_at, id
                """
            ).fetchall()
        except sqlite3.OperationalError:
            event_rows = []

        events_by_window: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for row in event_rows:
            key = (str(row["connection_id"]), str(row["window_key"]))
            events_by_window.setdefault(key, []).append(dict(row))

        grouped: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
        for row in snapshot_rows:
            key = (
                str(row["connection_name"]),
                str(row["connection_id"]),
                str(row["window_key"]),
            )
            grouped.setdefault(key, []).append(dict(row))

        result: dict[str, dict[str, dict[str, Any]]] = {}
        for (name, connection_id, window_key), rows in grouped.items():
            trusted = _select_trusted_snapshot_sequence(
                rows, events_by_window.get((connection_id, window_key), [])
            )
            if trusted is not None:
                result.setdefault(name, {})[window_key] = trusted
        return result
    finally:
        connection.close()

def quota_state_for_account(
    snapshots: dict[str, dict[str, dict[str, Any]]], connection_name: str
) -> dict[str, Any]:
    account_windows = snapshots.get(connection_name, {})

    def clean(row: dict[str, Any]) -> dict[str, Any]:
        remaining_raw = row.get("remaining_percentage")
        remaining = None if remaining_raw is None else max(0.0, min(100.0, float(remaining_raw)))
        used = None if remaining is None else max(0.0, min(100.0, 100.0 - remaining))
        return {
            "window_key": str(row.get("window_key") or ""),
            "used_percent": used,
            "remaining_percent": remaining,
            "is_exhausted": bool(row.get("is_exhausted")),
            "reset_at": row.get("next_reset_at"),
            "window_duration_ms": row.get("window_duration_ms"),
            "observed_at": row.get("created_at"),
            "trusted": bool(row.get("trusted")),
            "rejected_snapshot_count": int(row.get("rejected_snapshot_count") or 0),
            "rejected_reasons": list(row.get("rejected_reasons") or []),
            "latest_raw_remaining_percent": row.get("latest_raw_remaining_percentage"),
            "latest_raw_reset_at": row.get("latest_raw_reset_at"),
            "latest_raw_observed_at": row.get("latest_raw_created_at"),
            "latest_raw_was_rejected": bool(row.get("latest_raw_was_rejected")),
        }

    normal = clean(account_windows["session"]) if "session" in account_windows else None
    named = {key: clean(value) for key, value in account_windows.items() if key != "session"}
    return {"normal": normal, "named": named}


def normal_quota_status(
    quota: dict[str, Any], fallback_reset: dt.datetime, now: dt.datetime
) -> tuple[str, str]:
    normal = quota.get("normal")
    if isinstance(normal, dict) and normal.get("trusted") is True:
        remaining = normal.get("remaining_percent")
        reset_at = parse_timestamp(normal.get("reset_at"))
        if isinstance(remaining, (int, float)) and remaining > 0:
            return "ready", ""
        if isinstance(remaining, (int, float)) and remaining <= 0:
            if reset_at and reset_at > now:
                return "waiting_reset", ""
            return "needs_review", "انتهت لقطة الحصة السابقة ولم تصل لقطة حديثة بعد إعادة التعيين."
    if now < fallback_reset:
        return "waiting_reset", ""
    return "needs_review", "بيانات الحصة غير متاحة بعد موعد إعادة التعيين؛ لم يتم تنفيذ Smoke أو Model Request."



REAL_SMOKE_MAX_AGE = dt.timedelta(hours=24)


def real_smoke_gate(info: dict[str, Any], now: dt.datetime) -> tuple[str, str]:
    smoke = info.get("real_smoke")
    if not isinstance(smoke, dict):
        return "needs_test", "الحصة متاحة مباشرة، لكن يلزم اختبار نموذج فعلي قبل اعتبار الحساب جاهزًا."

    tested_at = parse_timestamp(smoke.get("tested_at"))
    smoke_status = str(smoke.get("status") or "").upper()

    if smoke_status == "BUSY":
        return (
            "busy",
            "الحساب سليم وحصته متاحة، لكن آخر اختبار فعلي وجد جلسة نموذج نشطة بالفعل؛ لن يبدأ جلسة ثانية.",
        )

    if smoke_status == "FAIL":
        return "test_error", sanitize(
            smoke.get("error") or "فشل اختبار النموذج الفعلي.",
            220,
        )

    if smoke_status != "PASS" or tested_at is None:
        return "needs_test", "لا يوجد اختبار نموذج فعلي ناجح وحديث لهذا الحساب."

    if now - tested_at > REAL_SMOKE_MAX_AGE:
        return "needs_test", "انتهت صلاحية الاختبار الفعلي؛ سيُعاد قبل الاستخدام التالي."

    quota = info.get("quota")
    normal = quota.get("normal") if isinstance(quota, dict) else None
    current_remaining = (
        normal.get("remaining_percent") if isinstance(normal, dict) else None
    )
    tested_remaining = smoke.get("live_remaining_at_test")
    try:
        if (
            current_remaining is not None
            and tested_remaining is not None
            and float(current_remaining) > float(tested_remaining) + 5.0
        ):
            return (
                "needs_test",
                "الحصة ارتفعت منذ آخر اختبار فعلي؛ يلزم اختبار جديد للدورة الحالية.",
            )
    except (TypeError, ValueError):
        pass

    return "ready", ""


STATUS_AR = {
    "ready": "جاهز",
    "waiting_reset": "بانتظار إعادة الحصة",
    "waiting_limit": "الحصة ما زالت مغلقة",
    "missing_connection": "الاتصال غير موجود",
    "key_error": "خطأ في المفتاح",
    "test_error": "فشل الاختبار",
    "needs_test": "يحتاج اختبار فعلي",
    "busy": "قيد الاستخدام",
    "profile_present_waiting_reset": "Profile موجود وبانتظار الحصة",
    "needs_review": "يحتاج مراجعة",
    "auth_failed": "فشل الاعتماد",
}


def render_dashboard(config: dict[str, Any], state: dict[str, Any]) -> None:
    accounts_state = state.get("accounts", {})
    cards: list[str] = []
    ready_count = 0
    busy_count = 0
    waiting_count = 0
    error_count = 0

    for account in sorted(config["accounts"], key=lambda item: item["reset_at"]):
        info = accounts_state.get(account["connection"], {})
        status = str(info.get("status") or "waiting_reset")
        if status == "ready":
            ready_count += 1
        elif status == "busy":
            busy_count += 1
        elif status in {"waiting_reset", "waiting_limit", "profile_present_waiting_reset"}:
            waiting_count += 1
        else:
            error_count += 1

        status_label = STATUS_AR.get(status, status)
        command = html.escape(str(account["command"]))
        last_test = html.escape(str(info.get("last_test") or "لم يُختبر بعد"))
        last_error = html.escape(str(info.get("last_error") or "—"))
        auth_status = html.escape(str(info.get("auth_status") or "UNKNOWN"))
        quota = info.get("quota") if isinstance(info.get("quota"), dict) else {}
        normal_quota = quota.get("normal") if isinstance(quota, dict) else None
        named_quotas = quota.get("named") if isinstance(quota, dict) else {}

        quota_html = '<div class="quota unavailable">بيانات الحصة غير متاحة</div>'
        quota_reset_iso = ""
        if isinstance(normal_quota, dict):
            used = normal_quota.get("used_percent")
            remaining = normal_quota.get("remaining_percent")
            quota_reset_iso = str(normal_quota.get("reset_at") or "")
            if isinstance(used, (int, float)) and isinstance(remaining, (int, float)):
                quota_reset = parse_timestamp(quota_reset_iso)
                quota_reset_display = (
                    quota_reset.astimezone(ZoneInfo("Asia/Riyadh")).strftime("%Y-%m-%d %H:%M")
                    if quota_reset else "غير متاح"
                )
                trust_warning = ""
                quota_html = (
                    '<div class="quota"><strong>الحصة الحالية — تحقق مباشر</strong>'
                    f'<span>المستخدم: {used:g}%</span>'
                    f'<span>المتبقي: {remaining:g}%</span>'
                    f'<span>إعادة التعيين: {html.escape(quota_reset_display)} بتوقيت الرياض</span>'
                    f'{trust_warning}</div>'
                )

        named_html = ""
        if isinstance(named_quotas, dict):
            for key, value in sorted(named_quotas.items()):
                if not isinstance(value, dict):
                    continue
                used = value.get("used_percent")
                remaining = value.get("remaining_percent")
                if not isinstance(used, (int, float)) or not isinstance(remaining, (int, float)):
                    continue
                display = "GPT-5.3-Codex-Spark" if key == "gpt_5_3_codex_spark_session" else str(key)
                named_html += (
                    '<div class="quota named"><strong>' + html.escape(display) + '</strong>'
                    f'<span>المستخدم: {used:g}%</span>'
                    f'<span>المتبقي: {remaining:g}%</span></div>'
                )

        smoke = info.get("real_smoke") if isinstance(info.get("real_smoke"), dict) else {}
        smoke_status = str(smoke.get("status") or "NOT_TESTED").upper()
        smoke_tested = parse_timestamp(smoke.get("tested_at"))
        smoke_tested_display = (
            smoke_tested.astimezone(ZoneInfo("Asia/Riyadh")).strftime("%Y-%m-%d %H:%M:%S")
            if smoke_tested else "لم يُختبر بعد"
        )
        smoke_http = smoke.get("http_status")
        smoke_latency = smoke.get("latency_ms")
        smoke_input = smoke.get("input_tokens")
        smoke_output = smoke.get("output_tokens")
        smoke_css = (
            "pass" if smoke_status == "PASS"
            else "busy" if smoke_status == "BUSY"
            else "fail" if smoke_status == "FAIL"
            else "pending"
        )
        smoke_html = (
            f'<div class="real-smoke smoke-{smoke_css}"><strong>الاختبار الحقيقي</strong>'
            f'<span>الحالة: {html.escape(smoke_status)}</span>'
            f'<span>آخر اختبار: {html.escape(smoke_tested_display)} بتوقيت الرياض</span>'
            f'<span>النموذج: gpt-5.6-sol</span>'
            f'<span>HTTP: {html.escape(str(smoke_http if smoke_http is not None else "—"))} · الزمن: {html.escape(str(smoke_latency if smoke_latency is not None else "—"))} ms</span>'
            f'<span>Tokens: in={html.escape(str(smoke_input if smoke_input is not None else "—"))} · out={html.escape(str(smoke_output if smoke_output is not None else "—"))}</span></div>'
        )

        reset_iso = quota_reset_iso or str(account["reset_at"])
        reset_dt = dt.datetime.fromisoformat(reset_iso).astimezone(ZoneInfo("Asia/Riyadh"))
        reset_display = reset_dt.strftime("%Y-%m-%d %H:%M")
        reset_at = html.escape(reset_iso)
        connection = html.escape(str(account["connection"]))
        label = html.escape(str(account["label"]))
        plan = html.escape(str(account["plan"]))
        css_status = re.sub(r"[^a-z0-9_-]", "-", status.lower())

        cards.append(
            f"""
            <article class="card status-{css_status}">
              <div class="card-head">
                <div>
                  <h2>{label}</h2>
                  <div class="muted">{connection}</div>
                </div>
                <span class="plan">{plan}</span>
              </div>
              <div class="status">{html.escape(status_label)}</div>
              <div class="auth">AUTH: {auth_status}</div>
              {quota_html}
              {named_html}
              {smoke_html}
              <dl>
                <div><dt>موعد إعادة الحصة</dt><dd data-reset="{reset_at}">{html.escape(reset_display)} بتوقيت الرياض</dd></div>
                <div><dt>الوقت المتبقي</dt><dd class="countdown" data-reset="{reset_at}">—</dd></div>
                <div><dt>آخر اختبار</dt><dd>{last_test}</dd></div>
                <div><dt>آخر ملاحظة</dt><dd>{last_error}</dd></div>
              </dl>
              <button class="test-btn" type="button" data-connection="{connection}">اختبار الحساب الآن</button>
              <div class="command"><code>{command}</code></div>
            </article>
            """
        )

    generated_raw = state.get("generated_at")
    if generated_raw:
        generated_dt = dt.datetime.fromisoformat(str(generated_raw)).astimezone(
            ZoneInfo("Asia/Riyadh")
        )
        generated_at = html.escape(
            generated_dt.strftime("%Y-%m-%d %H:%M:%S بتوقيت الرياض")
        )
    else:
        generated_at = "—"
    page = f"""<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>حسابات Codex عبر OmniRoute</title>
<style>
:root {{ color-scheme: dark; font-family: system-ui,-apple-system,"Segoe UI",sans-serif; }}
* {{ box-sizing: border-box; }}
body {{ margin:0; background:#0b1020; color:#eef2ff; }}
main {{ width:min(1320px,94vw); margin:32px auto 64px; }}
header {{ display:flex; justify-content:space-between; gap:20px; align-items:flex-end; margin-bottom:24px; }}
h1 {{ margin:0; font-size:clamp(25px,4vw,42px); }}
.subtitle,.muted {{ color:#9aa6c4; }}
.summary {{ display:grid; grid-template-columns:repeat(4,minmax(120px,1fr)); gap:12px; margin:24px 0; }}
.metric {{ background:#151c32; border:1px solid #27304b; border-radius:16px; padding:18px; }}
.metric strong {{ display:block; font-size:28px; }}
.grid {{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; }}
.card {{ background:#11182b; border:1px solid #29334f; border-radius:18px; padding:18px; box-shadow:0 12px 35px rgba(0,0,0,.18); }}
.card-head {{ display:flex; justify-content:space-between; gap:14px; align-items:flex-start; }}
.card h2 {{ margin:0 0 4px; font-size:20px; }}
.plan {{ background:#283252; border-radius:999px; padding:5px 10px; font-size:13px; }}
.status {{ display:inline-block; margin:16px 0 10px; padding:7px 11px; border-radius:999px; background:#33405f; }}
.status-ready .status {{ background:#155e45; }}
.status-busy .status {{ background:#1d4f91; }}
.status-waiting_reset .status,.status-waiting_limit .status,.status-profile_present_waiting_reset .status {{ background:#694c12; }}
.status-missing_connection .status,.status-key_error .status,.status-test_error .status {{ background:#7f1d1d; }}
.status-needs_review .status,.status-auth_failed .status {{ background:#7f1d1d; }}
.auth {{ color:#9aa6c4; font-size:13px; margin-bottom:8px; }}
.quota {{ display:grid; gap:5px; padding:12px; margin:8px 0; background:#0b1222; border:1px solid #27304b; border-radius:12px; }}
.quota strong {{ margin-bottom:2px; }}
.quota span {{ color:#c9d2ea; }}
.quota.unavailable {{ color:#9aa6c4; }}
.quota.named {{ border-style:dashed; }}
.real-smoke {{ display:grid; gap:5px; padding:12px; margin:8px 0; background:#0b1222; border:1px solid #27304b; border-radius:12px; }}
.real-smoke span {{ color:#c9d2ea; }}
.smoke-pass {{ border-color:#176b4d; }}
.smoke-fail {{ border-color:#8f2d2d; }}
.smoke-busy {{ border-color:#2f5f9f; }}
.smoke-pending {{ border-color:#725518; }}
.test-btn,.test-all-btn {{ width:100%; margin:8px 0 12px; padding:10px 12px; border-radius:10px; border:1px solid #3a496e; background:#1b2742; color:#eef2ff; cursor:pointer; font-weight:700; }}
.test-btn:hover,.test-all-btn:hover {{ background:#253455; }}
.test-btn:disabled,.test-all-btn:disabled {{ opacity:.55; cursor:wait; }}
.actions {{ margin:0 0 18px; display:flex; gap:12px; align-items:center; }}
.actions .test-all-btn {{ width:auto; min-width:220px; margin:0; }}
.action-status {{ color:#9aa6c4; }}
.quota-warning {{ color:#fbbf24 !important; font-weight:600; }}
dl {{ margin:6px 0 14px; }}
dl div {{ display:grid; grid-template-columns:130px 1fr; gap:10px; padding:8px 0; border-bottom:1px solid #202a43; }}
dt {{ color:#9aa6c4; }}
dd {{ margin:0; overflow-wrap:anywhere; }}
.command {{ background:#090e1b; border:1px solid #242d46; border-radius:12px; padding:11px; direction:ltr; text-align:left; }}
footer {{ margin-top:24px; color:#8793b1; }}
@media(max-width:950px) {{
  .grid {{ grid-template-columns:repeat(2,minmax(0,1fr)); }}
}}
@media(max-width:650px) {{
  header {{ align-items:flex-start; flex-direction:column; }}
  .summary {{ grid-template-columns:1fr; }}
  .grid {{ grid-template-columns:1fr; }}
  dl div {{ grid-template-columns:1fr; gap:3px; }}
}}
</style>
</head>
<body>
<main>
<header>
  <div>
    <h1>حسابات Codex عبر OmniRoute</h1>
    <div class="subtitle">PLUS FIRST — PRO RESERVE. الحصة الأساسية الموثوقة فقط؛ التبديل التلقائي عند نفادها مفعّل مع استمرار الجلسة.</div>
  </div>
  <div class="muted">آخر تحديث: {generated_at}</div>
</header>
<section class="summary">
  <div class="metric"><span>جاهز</span><strong>{ready_count}</strong></div>
  <div class="metric"><span>بانتظار الحصة</span><strong>{waiting_count}</strong></div>
  <div class="metric"><span>قيد الاستخدام</span><strong>{busy_count}</strong></div>
        <div class="metric"><span>يحتاج مراجعة</span><strong>{error_count}</strong></div>
</section>
<div class="actions">
  <button id="test-all-accounts" class="test-all-btn" type="button">اختبار جميع الحسابات فعليًا</button>
  <span id="test-action-status" class="action-status"></span>
</div>
<section class="grid">
{''.join(cards)}
</section>
<footer>
PLUS FIRST — PRO RESERVE. لا يوجد تجميع حصص. التبديل التلقائي يحدث فقط بعد ثبوت نفاد الحصة الأساسية الموثوقة؛ Spark مستقلة.
</footer>
</main>
<script>
function updateCountdowns() {{
  const now = Date.now();
  document.querySelectorAll('.countdown').forEach(el => {{
    const target = Date.parse(el.dataset.reset);
    const seconds = Math.floor((target-now)/1000);
    if (seconds <= 0) {{
      el.textContent = 'حان موعد الفحص أو تم تجاوزه';
      return;
    }}
    const days = Math.floor(seconds/86400);
    const hours = Math.floor((seconds%86400)/3600);
    const mins = Math.floor((seconds%3600)/60);
    el.textContent = `${{days}} يوم، ${{hours}} ساعة، ${{mins}} دقيقة`;
  }});
}}
const SMOKE_API = window.location.protocol + '//' + window.location.hostname + ':20141';

async function runRealSmoke(path, button) {{
  const status = document.getElementById('test-action-status');
  const refreshMeta = document.querySelector('meta[http-equiv="refresh"]');
  if (refreshMeta) refreshMeta.remove();
  const oldText = button ? button.textContent : '';
  if (button) {{ button.disabled = true; button.textContent = 'جارٍ الاختبار...'; }}
  if (status) status.textContent = 'يتم تنفيذ طلب نموذج حقيقي وتسجيل النتيجة...';
  try {{
    const response = await fetch(SMOKE_API + path, {{method:'POST'}});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
    if (status) status.textContent = `اكتمل: PASS=${{data.pass ?? 0}} FAIL=${{data.fail ?? 0}}`;
    setTimeout(() => location.reload(), 700);
  }} catch (error) {{
    if (status) status.textContent = 'فشل الاختبار: ' + error.message;
    if (button) {{ button.disabled = false; button.textContent = oldText; }}
  }}
}}

document.querySelectorAll('.test-btn').forEach(btn => {{
  btn.addEventListener('click', () => runRealSmoke('/test?connection=' + encodeURIComponent(btn.dataset.connection), btn));
}});
const allBtn = document.getElementById('test-all-accounts');
if (allBtn) allBtn.addEventListener('click', () => runRealSmoke('/test-all', allBtn));

updateCountdowns();
setInterval(updateCountdowns,30000);
</script>
</body>
</html>
"""
    PUBLIC.mkdir(parents=True, exist_ok=True)
    tmp = PUBLIC / "index.html.tmp"
    tmp.write_text(page, encoding="utf-8")
    final = PUBLIC / "index.html"
    os.chmod(tmp, 0o640)
    os.replace(tmp, final)
    os.chown(final, 0, pwd.getpwnam(LOGIN_USER).pw_gid)


def key_is_exclusive(existing_key: dict[str, Any] | None) -> bool:
    return bool(existing_key and existing_key.get("exclusiveSessionConnections") is True)


def ensure_existing_managed_key(
    existing_key: dict[str, Any],
    connection_id: str,
    management: ManagementSession,
) -> None:
    patch_status, _, patch_raw = request_json(
        "PATCH",
        f"{OMNI_URL}/api/keys/{existing_key['id']}",
        {
            "allowedConnections": [connection_id],
            "allowedModels": MODEL_ALIASES,
            "allowedCombos": [],
            "autoResolve": False,
            "maxSessions": 1,
            "exclusiveSessionConnections": True,
            "isActive": True,
            "allowUsageCommand": True,
            "scopes": ["self:usage"],
        },
        token=management.ensure(),
        timeout=20,
    )
    if patch_status != 200:
        raise RuntimeError(
            f"enforce managed key policy failed ({patch_status}): {sanitize(patch_raw)}"
        )
    verified_key = next(
        (
            item
            for item in list_keys(management.ensure())
            if str(item.get("id") or "") == str(existing_key["id"])
        ),
        None,
    )
    if not key_is_exclusive(verified_key):
        raise RuntimeError("managed key exclusivity verification failed")


def profile_exists(account: dict[str, Any]) -> bool:
    env_file, profile_file, launcher_file = account_paths(account)
    return bool(
        shell_secret_from_env(env_file)
        and profile_file.exists()
        and profile_file.stat().st_size > 0
        and "X-Session-Id" in profile_file.read_text(encoding="utf-8")
        and launcher_file.exists()
        and os.access(launcher_file, os.X_OK)
        and "--managed-profile" in launcher_file.read_text(encoding="utf-8")
    )


def main() -> int:
    config = load_config()
    state = load_state()
    rows = db_rows()
    snapshots = latest_quota_snapshots()
    management = ManagementSession()
    now = dt.datetime.now(dt.timezone.utc)

    try:
        for account in config["accounts"]:
            connection_name = account["connection"]
            reset_at = dt.datetime.fromisoformat(account["reset_at"])
            reset_utc = reset_at.astimezone(dt.timezone.utc)
            previous = state["accounts"].get(connection_name, {})
            info = dict(previous)
            info.update(
                {
                    "connection": connection_name,
                    "plan": account["plan"],
                    "reset_at": account["reset_at"],
                    "profile": account["profile"],
                    "command": account["command"],
                }
            )

            row = rows.get(connection_name)
            if not row:
                info.update(
                    {
                        "status": "missing_connection",
                        "auth_status": "UNKNOWN",
                        "last_error": "لم يُعثر على الاتصال داخل قاعدة OmniRoute.",
                    }
                )
                state["accounts"][connection_name] = info
                continue

            info["connection_id"] = row["id"]
            info["db_test_status"] = row.get("test_status")
            info["db_last_tested"] = row.get("last_tested")
            info["db_last_error"] = sanitize(row.get("last_error") or "", 300)
            fallback_quota = quota_state_for_account(snapshots, connection_name)
            info["quota"] = fallback_quota
            info["quota_source"] = "trusted_cache"

            test_status = str(row.get("test_status") or "").lower()
            credentials_present = bool(row.get("provider_credentials_present"))
            active = bool(row.get("is_active"))
            auth_failed = test_status in {"expired", "deactivated", "banned"}
            info["auth_status"] = (
                "FAILED" if auth_failed else "CONNECTED" if active and credentials_present else "UNKNOWN"
            )

            if auth_failed or not active or not credentials_present:
                info.update(
                    {
                        "status": "auth_failed" if auth_failed else "needs_review",
                        "last_error": sanitize(row.get("last_error") or "بيانات الاعتماد غير مؤكدة."),
                    }
                )
                state["accounts"][connection_name] = info
                continue

            try:
                env_file, _, _ = account_paths(account)
                api_key = shell_secret_from_env(env_file)
                existing_key = next(
                    (
                        item
                        for item in list_keys(management.ensure())
                        if item.get("name") == key_name(account)
                    ),
                    None,
                )
                if not api_key or not existing_key:
                    _, api_key_id = create_restricted_key(account, str(row["id"]), management)
                    info["api_key_id"] = api_key_id
                else:
                    ensure_existing_managed_key(existing_key, str(row["id"]), management)
                if not profile_exists(account):
                    create_profile(account)
            except Exception as error:
                info.update({"status": "key_error", "last_error": sanitize(error)})
                state["accounts"][connection_name] = info
                continue

            live_quota, live_error = live_quota_state(str(row["id"]), management)
            if live_quota is None:
                info["quota"] = fallback_quota
                info["quota_source"] = "live_unavailable"
                info["quota_checked_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
                info["status"] = "needs_review"
                info["last_error"] = (
                    "تعذر التحقق المباشر من الحصة الحالية؛ "
                    "لن يُستخدم الكاش القديم لاتخاذ قرار READY."
                )
                info["quota_live_error"] = sanitize(live_error, 240)
                state["accounts"][connection_name] = info
                continue

            info["quota"] = live_quota
            info["quota_source"] = "live_provider"
            info["quota_checked_at"] = live_quota["normal"].get("observed_at")
            info.pop("quota_live_error", None)

            status, note = normal_quota_status(info["quota"], reset_utc, now)
            normal_quota = info["quota"].get("normal") if isinstance(info["quota"], dict) else None
            if status == "ready":
                status, smoke_note = real_smoke_gate(info, now)
                if smoke_note:
                    note = smoke_note

            info["status"] = status
            info["last_error"] = note
            if status == "ready":
                info["ready_at"] = previous.get("ready_at") or now.isoformat()
            state["accounts"][connection_name] = info
    finally:
        management.close()

    state.pop("fatal_error", None)
    state["generated_at"] = now.isoformat()
    state["model_requests"] = 0
    state["smoke_requests"] = 0
    state["quota_policy"] = "LIVE_PROVIDER_FIRST_FAIL_CLOSED"
    state["quota_decision_source"] = "GET /api/usage/{connectionId}"
    save_state(state)
    render_dashboard(config, state)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        state = load_state()
        state["generated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
        state["fatal_error"] = sanitize(exc)
        save_state(state)
        try:
            render_dashboard(load_config(), state)
        except Exception:
            pass
        print(f"ERROR: {sanitize(exc)}", file=sys.stderr)
        raise
