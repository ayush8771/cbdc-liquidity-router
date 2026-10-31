# FUTURE_STAGE2_VISION.md — Long-Term Research & Architecture Vision (Stage 2+)

> **CRITICAL DIRECTIVE FOR CLAUDE CODE (DO NOT IGNORE):**
> This document outlines the **future Stage 2+ academic and production vision** for the CBDC Liquidity Router research paper (specifically the future integration of the **Cognee Knowledge Graph**, **ScrapeGraphAI**, **live WebSockets**, **AMM non-linear slippage curves**, and the **React/Vite Explainability Dashboard**).
>
> **DO NOT** implement, audit against, or refactor the current repository to match this document during **Stage 1D** work.
> * For all current tasks, audits, and experiments, treat root `CLAUDE.md`, `docs/PROJECT_HANDOVER.md`, and the live Stage 1A–1D codebase as the **sole source of truth**.
> * Do **not** flag the absence of Cognee, ScrapeGraphAI, WebSockets, or React components as discrepancies during the Stage 1D audit.
> * Preserve all current Stage 1A–1D semantics (415-D observation space, 1D CNN window encoder, masked Dirichlet PPO actor-critic, hard capacity clipping `executed_i = min(requested_i, available_capacity_i)`, lagged RPW cost baselines, and the 91-test suite).

---

## 1. Stage 2+ Executive Summary & Research Paper Vision
While **Stage 1A–1D** establishes the foundational reinforcement learning pipeline—proving that a masked Dirichlet PPO policy with a historical window encoder can learn capacity-aware, congestion-conscious, and cost-effective splitting across multi-venue CBDC corridors—**Stage 2+** expands the validated RL core into a full **Neuro-Symbolic Autonomous Agent**.

The overarching academic goal (titled *"Knowledge-Aware Autonomous Agents for Multi-CBDC Liquidity Routing: An Integration of Cognee-based Semantic Memory and Deep Reinforcement Learning"*) is to bridge reactive quantitative routing with proactive symbolic reasoning for architectures modeled after BIS Project mBridge and Project Mariana.

---

## 2. Roadmap Evolution: Stage 1D (Current) vs. Stage 2+ (Future Vision)

| Architectural Dimension | Stage 1A–1D (Current Implemented Baseline) | Stage 2+ (Future Research Extension) |
| :--- | :--- | :--- |
| **Observation & History** | 31 raw Stage 1D features + 384-D CNN historical window encoder (415-D combined). | 415-D numeric state augmented with **Cognee Knowledge Graph** semantic embeddings ($E_{\text{cognee}}$). |
| **Policy & Action Space** | Masked Dirichlet PPO Actor-Critic outputting simplex allocation shares over feasible venues. | Masked Dirichlet PPO conditioned on both numeric liquidity states and symbolic graph context. |
| **Execution & Capacity** | Hard capacity clipping (`min(requested, available)`) with unrouted penalty (`unrouted / amount`). | Optional AMM constant-product slippage curves ($x \cdot y = k$) alongside hard vault capacity caps. |
| **Compliance & Filtering** | Pre-computed feasibility masks and frozen regulatory transaction caps ($500K). | Dynamic KYC/AML and jurisdictional sanction masks inferred from **Cognee** regulatory graph nodes. |
| **Data Ingestion** | Lagged RPW corridor baselines, historical macro-risk series, and regime-stratified CSV splits. | Live **WebSocket** L1/L2 order book streams + **ScrapeGraphAI** unstructured financial news ingestion. |
| **Explainability & UI** | CLI/JSON evaluation metrics, regime breakdowns, and paired checkpoint comparisons. | **FastAPI + React/Vite Dashboard** featuring live routing maps and Cognee XAI natural-language traces. |

---

## 3. Financial Mechanics & Domain Logic (Research Paper Context)

### 3.1 Why Rates Aren't "Fixed" (Fragmented Liquidity Venues)
While retail users see a single mid-market exchange rate (e.g., $1 = ₹83), institutional cross-border settlement operates across fragmented liquidity venues and independent CBDC bridge pools. At any given millisecond, different pools hold varying reserve ratios, apply different spreads, and experience localized supply/demand shocks or latency lags.

### 3.2 Bridges, Lock Vaults (Liquidity Pools), and Liquidity Providers (LPs)
* **CBDC Bridges:** Smart-contract settlement tunnels connecting distinct sovereign currency ledgers (e.g., e-Rupee ↔ Digital Euro, or multi-hop paths).
* **Lock Vaults (Liquidity Pools):** Dual-currency smart contract reserves sitting inside bridges that enable instant atomic swaps without waiting for a direct counterparty.
* **Liquidity Providers (LPs / Vault Owners):** Commercial banks, financial institutions, or market makers who lock capital inside these vaults.
* **LP Profit Mechanism (Swap Yield, Not Interest):** Vault owners earn **Liquidity / Swap Fees**—a percentage commission charged on every transaction routed through their vault.

### 3.3 The Capacity & Slippage Problem (Smart Order Splitting)
When executing high-value institutional transfers, routing 100% of the volume through the single cheapest venue either exceeds its available liquidity (causing unrouted clipping in Stage 1D) or drains pool depth (causing non-linear execution slippage in AMM pools).
* **The Router's Core Job:** Act as a **Smart Order Router (SOR)** that evaluates available vault capacity, fee tiers, congestion, and corridor risk, splitting transactions across multiple feasible bridges when required (specifically targeting the `splitting_needed` and `near_boundary` regimes).

### 3.4 Total Cost of Transaction (TCoT) Breakdown
In the complete theoretical model, routed transactions account for:
1. **Forex Spread ($C_{\text{spread}}$):** Markup between the mid-market rate and the venue's execution price.
2. **Liquidity / Swap Fee ($C_{\text{LP}}$):** Percentage commission paid to the Vault Owner (LP).
3. **Capacity Clipping / Execution Slippage ($C_{\text{unrouted}} \text{ or } C_{\text{slippage}}$):** Penalty from exceeding available liquidity at a single venue.
4. **Latency / Congestion & Corridor Risk ($C_{\text{latency}}, C_{\text{risk}}$):** Settlement delay and macro/corridor risk costs.

---

## 4. Planned Stage 2+ Neuro-Symbolic Extensions

### 4.1 The Memory Layer: Cognee Knowledge Graph
Standard RL models only observe numeric tensors and are blind to unstructured world events. In Stage 2, **Cognee** will be introduced as a semantic memory layer:
* **Knowledge Graph Mapping:** Stores structured relationships: `(Country) -[ISSUES]-> (CBDC) -[CONNECTS_VIA]-> (Bridge) -[HOSTS]-> (LiquidityVault) -[OWNED_BY]-> (Institution)`.
* **ECL Pipeline (Extract, Cognify, Load):** Uses **ScrapeGraphAI** to ingest central bank announcements, regional banking holidays, server outages, and regulatory updates into the graph.
* **Three Planned Outputs to the Stage 1D PPO Router:**
  1. **Dynamic Compliance Mask:** Updates the feasible bridge mask in real time if a jurisdiction or bank is sanctioned or offline.
  2. **Proactive Risk Context:** Passes graph risk scores to anticipate liquidity drops before they appear in lagged numerical data.
  3. **Explainable AI (XAI):** Generates human-readable explanations detailing *why* specific bridges were favored or avoided based on graph memory.

### 4.2 The Decision Layer: Masked Dirichlet PPO (Built in Stage 1D)
* Uses the existing Stage 1C/1D **CNN historical window encoder + raw feature representation** and **masked Dirichlet policy head** (`src/models/ppo_actor_critic.py`) to output valid simplex allocation shares across feasible bridge venues.
* Evaluated rigorously against deterministic **Cheapest-Feasible** and **Liquidity-Aware Waterfall** baselines (`src/training/baselines.py`).

### 4.3 Planned Stage 2+ Visualization & Interface Layer
Once Stage 1D multi-seed validation and holdout evaluations are finalized, a **FastAPI** backend and **React + Vite + Tailwind CSS** dashboard will wrap the trained PPO checkpoints to visualize:
* Live corridor allocations and multi-bridge splitting vs. Waterfall and Cheapest-Feasible baselines.
* Per-regime telemetry (`below_cheapest`, `near_boundary`, `splitting_needed`, `exceeds_combined`).
* The **Cognee XAI Panel** explaining routing decisions in natural language for academic demonstration.