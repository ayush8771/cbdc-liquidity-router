"""Stage 1A reward mechanics.

Implements the reward formula approved in the FINAL Approved Specification
and the Action/Execution Semantics clarification, computed on EXECUTED
amounts only (unexecuted/unrouted money incurs no fee, latency, or risk
since it never moved - it is penalized separately via the unrouted term).

    cost_term     = [baseline_cost_pct * A_executed - sum(executed_i * fee_i)] / A
    latency_term  = sum((executed_i / A) * congestion_i)
    risk_term     = sum((executed_i / A) * risk_i)
    unrouted_term = unrouted / A

    R = cost_term - lambda_L * latency_term - lambda_R * risk_term - lambda_U * unrouted_term

IMPORTANT - lambda weights are NOT finalized. Per the approved spec, weight
calibration (the $-conversion / Pareto-sweep method) is a separate decision
that has not yet been approved. The defaults below (1.0 each) are
PLACEHOLDERS for wiring/testing the mechanics only and must not be read as
a calibrated or recommended weighting.

Similarly, `baseline_cost_pct` defaults to a PLACEHOLDER value. The
approved real source (RPW `cc2 total cost %`) is a Stage 1B data-pipeline
deliverable, not implemented here - this function accepts it as an
explicit parameter so Stage 1B can supply the real value without any
change to this file.
"""

# PLACEHOLDER ONLY - not the approved real_cost_baseline (RPW cc2 total
# cost %), which is a Stage 1B deliverable. Must be passed explicitly for
# any run that claims to reflect real data.
DEFAULT_BASELINE_COST_PCT_PLACEHOLDER = 0.05

# PLACEHOLDER weights - see module docstring. Not a calibration result.
DEFAULT_LAMBDA_LATENCY_PLACEHOLDER = 1.0
DEFAULT_LAMBDA_RISK_PLACEHOLDER = 1.0
DEFAULT_LAMBDA_UNROUTED_PLACEHOLDER = 1.0


def compute_reward_components(
    amount,
    executed,
    fees,
    congestion,
    risk,
    unrouted,
    baseline_cost_pct=DEFAULT_BASELINE_COST_PCT_PLACEHOLDER,
    lambda_latency=DEFAULT_LAMBDA_LATENCY_PLACEHOLDER,
    lambda_risk=DEFAULT_LAMBDA_RISK_PLACEHOLDER,
    lambda_unrouted=DEFAULT_LAMBDA_UNROUTED_PLACEHOLDER,
):
    """Computes each reward term and the total, given per-bridge executed
    amounts and per-bridge fee/congestion/risk values (all same length).

    Args:
        amount: original requested transaction amount (A).
        executed: list of executed amounts per feasible bridge slot.
        fees: list of fee rates (fraction) per feasible bridge slot.
        congestion: list of congestion values (PLACEHOLDER until Stage 1B) per slot.
        risk: list of risk values (PLACEHOLDER until Stage 1B) per slot.
        unrouted: total unrouted amount (A - sum(executed), including any
            amount that was requested against infeasible slots).
        baseline_cost_pct: traditional-cost baseline percentage.
        lambda_latency, lambda_risk, lambda_unrouted: term weights.

    Returns:
        dict with cost_term, latency_term, risk_term, unrouted_term, total,
        and the raw intermediate values used, for test inspection.
    """
    if amount <= 0:
        raise ValueError("amount must be positive")
    if not (len(executed) == len(fees) == len(congestion) == len(risk)):
        raise ValueError("executed/fees/congestion/risk must be the same length")

    executed_total = sum(executed)
    baseline_cost = baseline_cost_pct * executed_total
    actual_fee_cost = sum(e * f for e, f in zip(executed, fees))

    cost_term = (baseline_cost - actual_fee_cost) / amount
    latency_term = sum((e / amount) * c for e, c in zip(executed, congestion))
    risk_term = sum((e / amount) * r for e, r in zip(executed, risk))
    unrouted_term = unrouted / amount

    total = (
        cost_term
        - lambda_latency * latency_term
        - lambda_risk * risk_term
        - lambda_unrouted * unrouted_term
    )

    return {
        "executed_total": executed_total,
        "baseline_cost": baseline_cost,
        "actual_fee_cost": actual_fee_cost,
        "cost_term": cost_term,
        "latency_term": latency_term,
        "risk_term": risk_term,
        "unrouted_term": unrouted_term,
        "total": total,
    }