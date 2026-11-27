"""The A-4 timing parameters are labelled simulation values, and stay that way.

The one thing this suite exists to prevent is a **silent promotion**: an A-4
number quietly becoming a production default while AD-8 §3.5's `poll` column is
still unapproved. It therefore asserts the label, the refusal to construct an
unlabelled profile, and — field by field — that no simulation value coincides
with the unapproved AD-8 number it would be mistaken for.
"""
from __future__ import annotations

import ast
from dataclasses import replace
from pathlib import Path

import pytest

from cbdc_ingestion.adapters.retry import BackoffPolicy, CircuitBreaker
from cbdc_ingestion.adapters.simulated_fx import SimulatedTransportFxAdapter
from cbdc_ingestion.adapters.simulation import (
    SIMULATION_ONLY,
    SIMULATION_TIMING,
    SimulatedTimingProfile,
)

from .conftest import SEED, SERVICE_ROOT

# AD-8 §3.5's `poll` column, reproduced here **only** as the thing the
# simulation profile must not be. These values are **UNAPPROVED**: the owner's
# approval of 26 November 2026 is bounded to the `synthetic` column. They appear
# in a test, never in the package, so the package cannot be read as adopting
# them.
AD8_POLL_COLUMN_UNAPPROVED = {
    "backoff_base_ms": 1000,
    "backoff_ceiling_ms": 30000,
    "retry_after_min_ms": 1000,
    "retry_after_max_ms": 300000,
    "breaker_failure_threshold": 5,
    "breaker_window_ms": 60000,
    "breaker_cooldown_ms": 60000,
    "max_response_bytes": 1024 * 1024,
}


def test_the_shipped_profile_is_labelled_a_simulation():
    assert SIMULATION_TIMING.label == SIMULATION_ONLY
    assert SIMULATION_TIMING.is_simulation


def test_a_profile_cannot_be_constructed_without_the_label():
    """The label is a guard, not a comment: an unlabelled profile is refused."""
    with pytest.raises(ValueError, match="SIMULATION_ONLY"):
        SimulatedTimingProfile(label="production")
    with pytest.raises(ValueError, match="SIMULATION_ONLY"):
        SimulatedTimingProfile(label="AD-8 §3.5 poll")


@pytest.mark.parametrize("field,unapproved", sorted(AD8_POLL_COLUMN_UNAPPROVED.items()))
def test_no_simulation_value_coincides_with_an_unapproved_ad8_poll_value(field, unapproved):
    """Field by field, so one promoted value cannot hide behind the others."""
    assert getattr(SIMULATION_TIMING, field) != unapproved, (
        f"{field} now equals AD-8 §3.5's unapproved poll value {unapproved}. "
        "Promoting it needs that column approved, or a bounded owner grant")


def test_every_ad8_poll_field_named_here_exists_on_the_profile():
    """Otherwise the comparison above could pass by naming fields that are gone."""
    for field in AD8_POLL_COLUMN_UNAPPROVED:
        assert hasattr(SIMULATION_TIMING, field), field


def test_the_package_does_not_contain_the_unapproved_numbers_as_defaults():
    """Asserted against the simulation module's own source, so a future edit that
    pastes an AD-8 default into it fails here rather than shipping."""
    source = (SERVICE_ROOT / "cbdc_ingestion" / "adapters" / "simulation.py").read_text(
        encoding="utf-8")
    tree = ast.parse(source)
    literals = {node.value for node in ast.walk(tree)
                if isinstance(node, ast.Constant) and isinstance(node.value, int)}
    collisions = literals & set(AD8_POLL_COLUMN_UNAPPROVED.values())
    assert not collisions, f"unapproved AD-8 poll values appear as literals: {collisions}"


def test_a_variant_profile_is_still_labelled():
    """`replace` is how a case varies one field, and it cannot drop the label."""
    variant = replace(SIMULATION_TIMING, breaker_failure_threshold=1)
    assert variant.is_simulation and variant.breaker_failure_threshold == 1


@pytest.mark.parametrize("kwargs,match", [
    ({"backoff_base_ms": 0}, "base <= ceiling"),
    ({"backoff_ceiling_ms": 1}, "base <= ceiling"),
    ({"retry_after_max_ms": 0}, "Retry-After clamp"),
    ({"breaker_failure_threshold": 0}, "at least one failure"),
    ({"breaker_window_ms": 0}, "window and cooldown"),
    ({"breaker_cooldown_ms": 0}, "window and cooldown"),
    ({"max_response_bytes": 0}, "response limits"),
    ({"max_items_per_response": 0}, "response limits"),
    ({"min_request_interval_ms": -1}, "non-negative"),
])
def test_an_incoherent_profile_is_refused(kwargs, match):
    with pytest.raises(ValueError, match=match):
        replace(SIMULATION_TIMING, **kwargs)


def test_every_a4_component_refuses_an_unlabelled_profile():
    """The label is checked where it is used, not only where it is made.

    A profile object could only be unlabelled by subverting the dataclass, so
    each component is handed a stand-in that reports `is_simulation` false —
    which is the condition each must refuse.
    """
    class _NotASimulation:
        is_simulation = False
        label = "production"

    fake = _NotASimulation()
    with pytest.raises(ValueError, match="SIMULATION_ONLY"):
        BackoffPolicy(fake)
    with pytest.raises(ValueError, match="SIMULATION_ONLY"):
        CircuitBreaker("synthetic.fx", fake)
    with pytest.raises(ValueError, match="SIMULATION_ONLY"):
        SimulatedTransportFxAdapter("synthetic.fx", SEED, profile=fake)


def test_the_simulation_module_documents_why_ad8_is_not_used():
    """The reasoning is load-bearing: a reader who does not know the poll column
    is unapproved would read these numbers as arbitrary and tidy them towards
    AD-8. The docstring is therefore asserted, not merely written."""
    source = (SERVICE_ROOT / "cbdc_ingestion" / "adapters" / "simulation.py").read_text(
        encoding="utf-8")
    doc = ast.get_docstring(ast.parse(source)) or ""
    assert "unapproved" in doc.lower()
    assert "synthetic" in doc and "§3.5" in doc


def test_the_service_root_fixture_points_where_this_suite_thinks_it_does():
    """Cheap, and it stops the two source-reading tests above from passing
    vacuously if the layout ever moves."""
    assert (Path(SERVICE_ROOT) / "cbdc_ingestion" / "adapters" / "simulation.py").is_file()
