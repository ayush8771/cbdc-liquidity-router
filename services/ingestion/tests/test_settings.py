"""Settings: defaults, parsing and refusal.

An unparsable value must stop the process rather than fall back to a default: a
component that quietly ran on a different seed would produce events that nobody
can reproduce, which is the one property AD-1 §6 item 1 depends on.
"""
from __future__ import annotations

import pytest

from cbdc_ingestion.settings import DEFAULT_HOST, DEFAULT_PORT, DEFAULT_SEED, from_environment


def test_an_empty_environment_gives_the_documented_defaults():
    settings = from_environment({})
    assert (settings.seed, settings.host, settings.port) == (DEFAULT_SEED, DEFAULT_HOST, DEFAULT_PORT)
    assert settings.case_id == "normal"
    assert settings.log_level == "INFO"
    assert settings.host == "127.0.0.1", "the default bind address is loopback (AD-1 §2)"


def test_values_are_read_and_trimmed():
    settings = from_environment({
        "CBDC_INGESTION_SEED": " 7 ", "CBDC_INGESTION_PORT": "9001",
        "CBDC_INGESTION_HOST": " 0.0.0.0 ", "CBDC_INGESTION_CASE_ID": " outage ",
        "CBDC_INGESTION_LOG_LEVEL": "debug"})
    assert (settings.seed, settings.port, settings.host) == (7, 9001, "0.0.0.0")
    assert settings.case_id == "outage"
    assert settings.log_level == "DEBUG"


def test_a_blank_value_falls_back_to_the_default():
    settings = from_environment({"CBDC_INGESTION_SEED": "  ", "CBDC_INGESTION_CASE_ID": ""})
    assert settings.seed == DEFAULT_SEED
    assert settings.case_id == "normal"


@pytest.mark.parametrize("env", [
    {"CBDC_INGESTION_SEED": "abc"},
    {"CBDC_INGESTION_SEED": "1.5"},
    {"CBDC_INGESTION_SEED": "-1"},
    {"CBDC_INGESTION_SEED": str(2 ** 53)},
    {"CBDC_INGESTION_PORT": "70000"},
    {"CBDC_INGESTION_PORT": "http"},
    {"CBDC_INGESTION_CASE_ID": "x" * 201},
])
def test_an_unusable_value_is_refused(env):
    with pytest.raises(ValueError):
        from_environment(env)


def test_there_is_no_setting_that_can_name_an_external_host():
    """The component contacts nothing, so no provider URL or credential setting
    exists to be set by mistake (AD-1 §1, D-24)."""
    settings = from_environment({"CBDC_INGESTION_PROVIDER_URL": "https://example.invalid",
                                 "CBDC_INGESTION_API_KEY": "nope"})
    assert not hasattr(settings, "provider_url")
    assert not any("url" in field or "key" in field or "token" in field
                   for field in settings.__dataclass_fields__)
