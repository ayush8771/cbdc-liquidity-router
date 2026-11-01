"""Tests for the inference-time capped-simplex projection (Stage 1D experiment)."""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # same as test_stage1d.py

from src.training.capacity_projection import project_capped_simplex


def _check_feasible(x, caps, mask):
    assert abs(x.sum() - 1.0) < 1e-9
    assert (x >= -1e-12).all()
    assert (x[mask] <= caps[mask] + 1e-12).all()
    assert (x[~mask] == 0).all()


def test_feasible_action_is_unchanged():
    mask = np.array([True, True, True, False, False, False])
    caps = np.array([0.5, 0.6, 0.7, 0, 0, 0])
    a = np.array([0.3, 0.3, 0.4, 0, 0, 0])
    np.testing.assert_allclose(project_capped_simplex(a, caps, mask), a, atol=1e-10)


def test_over_allocation_is_moved_to_slots_with_headroom():
    mask = np.array([True, True, True, False, False, False])
    caps = np.array([0.25, 0.8, 0.2, 0, 0, 0])
    a = np.array([0.30, 0.60, 0.10, 0, 0, 0])
    x = project_capped_simplex(a, caps, mask)
    _check_feasible(x, caps, mask)
    assert abs(x[0] - 0.25) < 1e-9  # clipped slot sits at its cap
    assert x[1] > a[1] and x[2] > a[2]  # excess redistributed


def test_projection_is_euclidean_closest_point():
    rng = np.random.default_rng(0)
    mask = np.array([True, True, True, False, False, False])
    for _ in range(200):
        caps = np.r_[rng.uniform(0.1, 0.9, 3), np.zeros(3)]
        if caps[:3].sum() <= 1.0:
            continue
        a = np.r_[rng.dirichlet(np.ones(3)), np.zeros(3)]
        x = project_capped_simplex(a, caps, mask)
        _check_feasible(x, caps, mask)
        # No random feasible point is strictly closer to `a`.
        for _ in range(50):
            y = np.r_[rng.dirichlet(np.ones(3)), np.zeros(3)]
            if (y[:3] <= caps[:3]).all():
                assert np.linalg.norm(x - a) <= np.linalg.norm(y - a) + 1e-9


def test_insufficient_combined_capacity_fills_every_slot():
    mask = np.array([True, True, True, False, False, False])
    caps = np.array([0.2, 0.3, 0.1, 0, 0, 0])
    x = project_capped_simplex(np.array([0.5, 0.3, 0.2, 0, 0, 0]), caps, mask)
    np.testing.assert_allclose(x, caps)


def test_no_feasible_slot_returns_zeros():
    x = project_capped_simplex(np.ones(6) / 6, np.ones(6), np.zeros(6, dtype=bool))
    assert (x == 0).all()


# --- Optimality: exact KKT characterisation + independent brute force -------

M3 = np.array([True, True, True, False, False, False])


def _assert_kkt(a, x, caps, mask, tol=1e-8):
    """x is the projection iff, for some tau, x_i = clip(a_i - tau, 0, u_i) on
    feasible slots (with u_i = clip(cap_i, 0, 1)) and sum x = 1."""
    a, x, u = a[mask], x[mask], np.clip(caps[mask], 0.0, 1.0)
    interior = (x > tol) & (x < u - tol)
    at_zero = x <= tol
    at_cap = (x >= u - tol) & ~at_zero
    lo = max([a[i] - u[i] for i in np.where(at_cap)[0]], default=-np.inf)  # tau <= a_i - u_i ... (capped)
    hi = min([np.inf] + [np.inf])
    if interior.any():
        taus = a[interior] - x[interior]
        assert taus.max() - taus.min() < tol * 10, f"interior slots disagree on tau: {taus}"
        tau = taus.mean()
        assert np.all(a[at_zero] <= tau + tol), "zero slot would receive mass"
        assert np.all(a[at_cap] - u[at_cap] >= tau - tol), "capped slot below its cap at tau"
    else:
        # Need some tau with max(a at zero) <= tau <= min(a - u at cap).
        z = max(a[at_zero], default=-np.inf)
        c = min(a[at_cap] - u[at_cap], default=np.inf)
        assert z <= c + tol, f"no tau satisfies KKT (zero max {z}, cap min {c})"
    assert abs(x.sum() - 1.0) < 1e-9


def test_projection_satisfies_kkt_conditions():
    rng = np.random.default_rng(1)
    n_checked = 0
    for _ in range(2000):
        k = int(rng.integers(2, 7))
        mask = np.zeros(6, dtype=bool)
        mask[:k] = True
        caps = np.r_[rng.uniform(0.0, 1.2, k), np.zeros(6 - k)]
        if caps[:k].clip(0, 1).sum() <= 1.0:
            continue
        a = np.r_[rng.normal(0.2, 0.5, k), np.zeros(6 - k)]  # arbitrary, not necessarily on the simplex
        x = project_capped_simplex(a, caps, mask)
        _check_feasible(x, np.clip(caps, 0, 1), mask)
        _assert_kkt(a, x, caps, mask)
        n_checked += 1
    assert n_checked > 500


def test_projection_matches_brute_force_grid():
    """Independent check: exhaustive search over a fine grid of the feasible set."""
    rng = np.random.default_rng(2)
    step = 0.0025
    grid = np.arange(0.0, 1.0 + step / 2, step)
    g0, g1 = np.meshgrid(grid, grid, indexing="ij")
    g2 = 1.0 - g0 - g1
    for _ in range(40):
        caps = np.r_[rng.uniform(0.15, 0.9, 3), np.zeros(3)]
        if caps[:3].sum() <= 1.0:
            continue
        a = np.r_[rng.dirichlet(np.ones(3)), np.zeros(3)]
        x = project_capped_simplex(a, caps, M3)
        ok = (g2 >= -1e-12) & (g0 <= caps[0]) & (g1 <= caps[1]) & (g2 <= caps[2])
        d = (g0 - a[0]) ** 2 + (g1 - a[1]) ** 2 + (g2 - a[2]) ** 2
        best = np.sqrt(d[ok].min())
        assert np.linalg.norm(x - a) <= best + 1e-12  # projection is at least as close as any grid point
        assert np.linalg.norm(x - a) >= best - 2 * step  # and the grid gets close to it


# --- Edge cases ---------------------------------------------------------------

def test_caps_summing_exactly_to_one_returns_caps():
    caps = np.r_[0.5, 0.25, 0.25, 0, 0, 0]
    x = project_capped_simplex(np.r_[0.5, 0.3, 0.2, 0, 0, 0], caps, M3)
    np.testing.assert_allclose(x, caps)


def test_caps_just_above_one():
    caps = np.r_[[1 / 3 + 1e-13] * 3, [0, 0, 0]]
    x = project_capped_simplex(np.r_[0.9, 0.05, 0.05, 0, 0, 0], caps, M3)
    assert abs(x.sum() - 1.0) < 1e-9
    assert (x[:3] <= caps[:3] + 1e-12).all()


def test_single_feasible_slot():
    mask = np.array([True, False, False, False, False, False])
    np.testing.assert_allclose(project_capped_simplex(np.r_[1, 0, 0, 0, 0, 0.], np.r_[2, 0, 0, 0, 0, 0.], mask),
                               np.r_[1, 0, 0, 0, 0, 0.])
    np.testing.assert_allclose(project_capped_simplex(np.r_[1, 0, 0, 0, 0, 0.], np.r_[0.4, 0, 0, 0, 0, 0.], mask),
                               np.r_[0.4, 0, 0, 0, 0, 0.])  # insufficient: fill to cap


def test_zero_cap_slot_gets_nothing():
    caps = np.r_[0.0, 0.8, 0.8, 0, 0, 0]
    x = project_capped_simplex(np.r_[0.5, 0.3, 0.2, 0, 0, 0], caps, M3)
    _check_feasible(x, caps, M3)
    assert x[0] == 0.0


def test_negative_cap_treated_as_zero():
    x = project_capped_simplex(np.r_[0.5, 0.3, 0.2, 0, 0, 0], np.r_[-0.3, 0.8, 0.8, 0, 0, 0], M3)
    assert x[0] == 0.0 and abs(x.sum() - 1) < 1e-9


def test_mass_on_infeasible_slot_is_dropped_and_reprojected():
    x = project_capped_simplex(np.r_[0.3, 0.3, 0.2, 0.2, 0, 0], np.r_[0.6, 0.6, 0.6, 0, 0, 0], M3)
    _check_feasible(x, np.r_[0.6, 0.6, 0.6, 0, 0, 0], M3)


def test_unnormalized_action_is_projected_onto_simplex():
    caps = np.r_[0.6, 0.6, 0.6, 0, 0, 0]
    x = project_capped_simplex(np.r_[0.2, 0.2, 0.1, 0, 0, 0], caps, M3)
    _check_feasible(x, caps, M3)
    np.testing.assert_allclose(x[:3], np.array([0.2, 0.2, 0.1]) + (1 - 0.5) / 3, atol=1e-9)  # uniform shift


def test_float32_action_accepted():
    a = np.r_[0.3, 0.3, 0.4, 0, 0, 0].astype(np.float32)
    x = project_capped_simplex(a, np.r_[0.6, 0.6, 0.6, 0, 0, 0], M3)
    assert x.dtype == np.float64 and abs(x.sum() - 1.0) < 1e-12


def test_infinite_and_huge_caps_are_non_binding():
    a = np.r_[0.3, 0.3, 0.4, 0, 0, 0]
    for caps in (np.r_[np.inf, 0.6, 0.6, 0, 0, 0], np.r_[1e9, 1e9, 1e9, 0, 0, 0], np.r_[np.inf, np.inf, np.inf, 0, 0, 0]):
        x = project_capped_simplex(a, np.asarray(caps, dtype=float), M3)
        assert np.all(np.isfinite(x))
        np.testing.assert_allclose(x, a, atol=1e-10)


def test_infinite_cap_still_projects_correctly():
    caps = np.r_[np.inf, 0.1, 0.1, 0, 0, 0]
    x = project_capped_simplex(np.r_[0.2, 0.4, 0.4, 0, 0, 0], caps, M3)
    np.testing.assert_allclose(x, [0.8, 0.1, 0.1, 0, 0, 0], atol=1e-9)


def test_nan_cap_on_feasible_slot_raises():
    try:
        project_capped_simplex(np.r_[0.3, 0.3, 0.4, 0, 0, 0], np.r_[np.nan, 0.6, 0.6, 0, 0, 0], M3)
    except ValueError:
        return
    raise AssertionError("expected ValueError for NaN cap")


def test_nan_cap_on_infeasible_slot_is_ignored():
    x = project_capped_simplex(np.r_[0.3, 0.3, 0.4, 0, 0, 0], np.r_[0.6, 0.6, 0.6, np.nan, 0, 0], M3)
    np.testing.assert_allclose(x, [0.3, 0.3, 0.4, 0, 0, 0], atol=1e-10)


def test_nan_or_inf_action_raises():
    for bad in (np.nan, np.inf):
        try:
            project_capped_simplex(np.r_[bad, 0.3, 0.4, 0, 0, 0], np.r_[0.6, 0.6, 0.6, 0, 0, 0], M3)
        except ValueError:
            continue
        raise AssertionError(f"expected ValueError for action value {bad}")


if __name__ == "__main__":
    import sys
    tests = [v for k, v in dict(globals()).items() if k.startswith("test_")]
    failed = 0
    for t in tests:
        try:
            t()
        except AssertionError as e:
            failed += 1
            print(f"FAIL {t.__name__}: {e}")
    print(f"{len(tests) - failed} passed, {failed} failed out of {len(tests)}")
    sys.exit(1 if failed else 0)
