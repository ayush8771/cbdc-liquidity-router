import subprocess
import sys
from pathlib import Path

from fastapi.testclient import TestClient

from cbdc_inference import ENGINE_VERSION
from cbdc_inference.api.app import create_app
from cbdc_inference.settings import Settings

SERVICE = Path(__file__).resolve().parents[2]


def test_app_starts_with_defaults_and_ppo_disabled(default_settings):
    app = create_app(default_settings)
    with TestClient(app) as client:
        assert app.version == ENGINE_VERSION
        gate = app.state.checkpoint_gate
        assert (gate.status, gate.reason) == ("disabled", "no approved checkpoint configured")
        assert client.get("/openapi.json").status_code == 200


def test_unapproved_checkpoint_id_stays_disabled(monkeypatch):
    monkeypatch.setenv("CBDC_PPO_CHECKPOINT_ID", "not-approved")
    app = create_app(Settings())
    with TestClient(app):
        assert app.state.checkpoint_gate.enabled is False


def test_no_v1_endpoints_are_registered_yet(default_settings):
    """Endpoints are only added once backed by the engine (no invented stub values)."""
    paths = {r.path for r in create_app(default_settings).routes}
    assert not any(p.startswith("/v1") for p in paths), paths


def test_unknown_path_uses_contract_error_envelope(default_settings):
    with TestClient(create_app(default_settings)) as client:
        r = client.get("/v1/does-not-exist", headers={"X-Request-Id": "req-123"})
    assert r.status_code == 404
    assert r.headers["X-Request-Id"] == "req-123"
    assert r.json() == {"error": {"code": "NOT_FOUND", "message": "Unknown resource.",
                                  "details": {}, "request_id": "req-123"}}


def test_request_id_generated_when_missing(default_settings):
    with TestClient(create_app(default_settings)) as client:
        r = client.get("/v1/does-not-exist")
    rid = r.headers["X-Request-Id"]
    assert rid and r.json()["error"]["request_id"] == rid


def test_importing_app_does_not_load_phase1_or_torch():
    """The FastAPI process holds no Phase 1 state (arch §6.2). Checked in a fresh interpreter."""
    code = ("import sys; import cbdc_inference.api.app; "
            "bad = [m for m in ('src', 'torch', 'gymnasium') if m in sys.modules]; "
            "print(bad); sys.exit(1 if bad else 0)")
    r = subprocess.run([sys.executable, "-c", code], cwd=SERVICE, capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
