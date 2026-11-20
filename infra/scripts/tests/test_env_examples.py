"""infra/env/*.env.example and .nvmrc: contract §8 coverage, no secrets (arch §7.3, §8)."""
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
ENV = REPO / "infra" / "env"
SERVICES = ("inference", "backend", "web", "postgres")


def parse(path):
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.lstrip().startswith("#"):
            k, _, v = line.partition("=")
            out[k.strip()] = v.strip()
    return out


def contract_vars():
    """(variable, service) pairs from the contract §8 table."""
    text = (REPO / "docs/PHASE2_API_CONTRACT.md").read_text(encoding="utf-8")
    sec = text.split("## 8. Configuration", 1)[1].split("\n---", 1)[0]
    rows = re.findall(r"^\| `([A-Z_]+)` \| ([a-z]+)", sec, re.M)
    assert len(rows) >= 18
    return set(rows)


def test_nvmrc_pins_exact_node_20():
    assert re.fullmatch(r"20\.\d+\.\d+", (REPO / ".nvmrc").read_text().strip())


def test_every_service_has_an_example_and_no_real_env_file():
    for s in SERVICES:
        assert (ENV / f"{s}.env.example").is_file()
    assert not list(ENV.glob("*.env"))


def test_contract_variables_are_all_present():
    for var, svc in contract_vars():
        assert var in parse(ENV / f"{svc}.env.example"), (var, svc)


def test_contract_defaults_match():
    inf = parse(ENV / "inference.env.example")
    assert (inf["CBDC_ENGINE_WORKERS"], inf["CBDC_ENGINE_REQUEST_DEADLINE_S"], inf["CBDC_ENGINE_TASK_TIMEOUT_S"]) == ("2", "12", "10")
    assert inf["CBDC_ENGINE_STARTUP_TIMEOUT_S"] == "180" and inf["CBDC_ENGINE_MAX_QUEUE"] == "32"
    assert inf["CBDC_ENABLE_COGNEE"] == "false" and inf["CBDC_PPO_CHECKPOINT_ID"] == ""
    assert 0 <= float(inf["CBDC_ENGINE_MIN_START_BUDGET_S"]) < float(inf["CBDC_ENGINE_REQUEST_DEADLINE_S"])
    be = parse(ENV / "backend.env.example")
    assert be["AUTH_MODE"] == "dev" and be["INFERENCE_MODE"] == "live"
    assert int(be["INFERENCE_TIMEOUT_MS"]) > float(inf["CBDC_ENGINE_REQUEST_DEADLINE_S"]) * 1000


def test_no_secrets_and_vite_vars_are_public_only():
    for p in ENV.glob("*.env.example"):
        for k, v in parse(p).items():
            if "PASSWORD" in k:
                assert v.startswith("CHANGE_ME"), (p.name, k)
            assert not re.search(r"(?i)bearer|sk-[a-z0-9]{10}|eyJ[a-z0-9]{10}", v), (p.name, k)
    for k in parse(ENV / "web.env.example"):
        assert k.startswith("VITE_")
        assert not re.search(r"(?i)token|secret|password|key", k)
    be = parse(ENV / "backend.env.example")
    pg = parse(ENV / "postgres.env.example")
    assert be["DATABASE_URL"].split("@")[0].endswith(f"{pg['POSTGRES_USER']}:{pg['POSTGRES_PASSWORD']}")
