# Stage 1E — Cognee / Semantic Memory

**Status:** complete as an **infrastructure milestone** (2 November 2026).
**Deferred:** populating the knowledge base with real, cited regulatory and operational knowledge. Today the knowledge base holds only the project's own assumed $500K transfer cap.

Stage 1E adds a controlled memory layer: a deterministic, provenance-tagged knowledge base, plus an optional Cognee semantic layer that retrieves and explains facts. It does **not** change PPO, the CNN, the environment's semantics, the reward, the datasets or the checkpoints.

---

## 1. Architecture

```
data/knowledge/regulatory_facts.json   versioned, provenance-tagged facts (SHA-256 recorded)
        │  load + validate (src/memory/knowledge.py)
        ▼
StaticMemoryProvider (src/memory/provider.py)      ── ONLY authority for feasibility
        │  legacy_constraints()                           check_transaction / get_context / explain
        ▼
CogneeMemoryLayer (src/memory/cognee_layer.py)     ── wrapper used by CBDCLiquidityEnv; same
        │                                                constraints dict, logic and reason strings
        ▼                                                as the pre-1E stub
CBDCLiquidityEnv.get_feasibility_mask()  (unchanged)

Optional, never imported by the environment, training, evaluation or the model:
CogneeAdapter (src/memory/cognee_adapter.py)       ── lazy `import cognee`; ingests facts as
        │                                                deterministic documents; CHUNKS retrieval;
        ▼                                                grounds results to known fact_ids
CogneeExplanationProvider                          ── decisions delegated to StaticMemoryProvider;
                                                       Cognee adds `semantic_context` to explain() only
Read-only audit (src/memory/explanation_audit.py, run_stage1e_explanation_audit.py)
```

| Component | File | Role |
|---|---|---|
| Knowledge base | `data/knowledge/regulatory_facts.json` | Schema v1. Rule types: `max_single_transfer_usd`, `restricted_corridor`. Each fact carries a scope, an effective date range, `provenance_tag` (`real_regulation`, `real_operational`, `project_assumption`, `synthetic`), a `verified` flag and a `source`. |
| Loader/validator | `src/memory/knowledge.py` | Strict validation, SHA-256, inclusive as-of-date lookup (with no date, only undated facts apply). A `project_assumption` or `synthetic` fact can never be marked verified. |
| Static provider | `src/memory/provider.py` | Deterministic. The smallest applicable cap wins; corridor restrictions are checked after the cap (the legacy order). |
| Environment wrapper | `src/memory/cognee_layer.py` | Derives `constraints` from the knowledge base. Refuses dated or corridor-scoped caps, which the date-free environment check cannot express. |
| Cognee adapter | `src/memory/cognee_adapter.py` | Configuration, ingestion into a dataset named after the knowledge-base hash, retrieval, grounding. |
| Audit | `src/memory/explanation_audit.py` | Read-only, template-based explanations of Stage 1D results, cross-checked against the static provider. |

## 2. Influence boundaries

| Path | Allowed? | Detail |
|---|---|---|
| **Explanations and audit** | Yes | Cognee retrieval is advisory. It is grounded to known `fact_id`s; unknown IDs are reported, never trusted. A Cognee failure never changes a decision. |
| **Feasibility (hard constraints)** | Only through the deterministic knowledge base | Only undated global caps and undated exact-corridor restrictions reach the environment. Dated facts, corridor-scoped caps and anything retrieved by Cognee **cannot** affect feasibility. Enabling them requires an approved, tested environment change. |
| **PPO observation, action or reward** | No | Knowledge is never a policy input. Using it as one would change the observation and require retraining. |
| **Datasets, checkpoints, Stage 1D results** | Read-only | The audit hashes its inputs before and after, and fails if they change. |

**No invented knowledge.** Facts must cite a real source. `verified: true` is reserved for checked `real_*` sources.

## 3. Ollama setup (local; knowledge text and queries stay on the machine)

Verified with Cognee 1.4.2, Ollama 0.15.6, `llama3.1:8b` and `nomic-embed-text:latest` (768 dimensions).

```powershell
cd C:\Users\Ayush\OneDrive\Desktop\cbdc-liquidity-router
.\venv\Scripts\Activate.ps1
$env:LLM_PROVIDER         = "ollama"
$env:LLM_MODEL            = "llama3.1:8b"
$env:LLM_ENDPOINT         = "http://localhost:11434/v1"        # OpenAI-compatible endpoint
$env:EMBEDDING_PROVIDER   = "ollama"
$env:EMBEDDING_MODEL      = "nomic-embed-text:latest"
$env:EMBEDDING_ENDPOINT   = "http://localhost:11434/api/embed"
$env:EMBEDDING_DIMENSIONS = "768"                               # required; Cognee's Ollama default is 1024
$env:LITELLM_LOCAL_MODEL_COST_MAP = "True"                      # stops litellm fetching its price table online
$env:CBDC_COGNEE_DLL_DIR  = "C:\Program Files\Git\mingw64\bin"   # Windows only; see section 4
```

Adapter defaults for Ollama (no manual setting needed):

| Default | Reason |
|---|---|
| `LLM_API_KEY` = placeholder `"ollama"`, also exported to the environment | Cognee requires a non-empty key, and its config validator reads the environment directly |
| `LLM_INSTRUCTOR_MODE` = `json_schema_mode` | Cognee's Ollama default, `json_mode`, failed schema validation with `llama3.1:8b`: 0 of 3 valid in a direct probe, against 3 of 3 with schema mode |
| Telemetry off | Set `CBDC_COGNEE_TELEMETRY=1` to opt in |
| Storage under `.cognee/` (git-ignored) | Override with `CBDC_COGNEE_ROOT` |

The placeholder key is never used for a hosted embedding provider. You can override any default by setting the variable yourself.

**Hosted providers** (for example OpenAI): set `LLM_API_KEY` and optionally `LLM_MODEL` / `EMBEDDING_*`. The knowledge text and queries are then **sent to that provider**, which is why both scripts require `--yes`.

## 4. Windows OpenSSL configuration

Cognee 1.4.2's default graph database (LadybugDB 0.18.x, a Kuzu fork) downloads a `json` extension to `%USERPROFILE%\.lbdb\extension\...`. That extension imports `libssl-3-x64.dll` and `libcrypto-3-x64.dll` (OpenSSL 3), under exactly those names.

- **The wheel's own copy doesn't match:** the `ladybug` wheel bundles OpenSSL only under hash-suffixed names.
- **The symptom:** without OpenSSL 3 on the DLL search path, ingestion fails with `IO exception: Failed to load library ... libjson.lbug_extension ... The specified module could not be found`.
- **The fix:** set `CBDC_COGNEE_DLL_DIR` to a directory containing those DLLs, for example Git for Windows' `C:\Program Files\Git\mingw64\bin` (OpenSSL 3.5.5). The adapter **appends** it to `PATH` before importing Cognee.
  - It uses `PATH`, not only `os.add_dll_directory`, because Cognee opens the graph database in a worker subprocess.
  - Appending means it never overrides existing DLLs.
- **Caveat:** Git's OpenSSL is a MinGW build, while the extension is an MSVC build. OpenSSL 3 keeps a stable C interface across 3.x, and live runs succeeded. Even so, this ties the setup to a local Git install.

## 5. Commands

| Purpose | Command |
|---|---|
| Unit tests (no network, no LLM) | `python -m pytest tests/` |
| Live smoke test | `python run_cognee_smoke_test.py --yes` |
| Live explanation audit | `python run_stage1e_explanation_audit.py --yes` (`--skip-ingest`, `--top-k N`, `--inputs ...`) |
| Static-only audit (no provider) | `python run_stage1e_explanation_audit.py --static-only` |

Both live scripts exit with code 2, writing nothing, when configuration is invalid or `--yes` is missing. The audit writes to a new folder, `outputs/memory_audit/stage1e_explanation_audit_<timestamp>/` (`explanations.jsonl`, `retrievals.json`, `summary.json`, `input_hashes.json`, `provenance.json`), and never overwrites one.

## 6. Results

**Tests:** `python -m pytest tests/` gives **177 passed**, with 9 known pandas `pct_change` FutureWarnings.

| Suite | Tests |
|---|---:|
| Stage 1A | 17 |
| Stage 1B | 26 |
| Stage 1C | 13 |
| Stage 1D | 35 |
| Capacity projection | 20 |
| Stage 1E (`tests/test_stage1e.py`) | 18 |
| Stage 1E Cognee adapter (`tests/test_stage1e_cognee.py`) | 33 |
| Stage 1E audit (`tests/test_stage1e_audit.py`) | 15 |

The tests cover:
- parity of feasibility masks with the pre-1E stub on more than 2,000 rows (every Stage 1D split, the holdouts and the fixture);
- that the generator's cap equals the knowledge-base cap;
- isolation: the environment, training, evaluation and the model never import Cognee;
- grounding, the Ollama defaults, DLL handling and clean chunk text;
- detection of modified audit inputs.

**Live smoke test** (Ollama, adapter defaults only, fresh storage root): **7 of 7 passed**. Ingestion succeeded; retrieval was grounded to `global_max_single_transfer_usd`; decisions matched `StaticMemoryProvider` in all 3 cases. The result is local (`.cognee/verify_20261102_013648/`, git-ignored).

**Live audit** (`outputs/memory_audit/stage1e_explanation_audit_20261102_020138/`, committed):
- 1,522 unique transactions from the authoritative Stage 1D holdouts and failure diagnostics;
- 3 of 3 corridors retrieved and grounded, with 0 ungrounded results and 0 unknown fact IDs;
- 1,500 of 1,500 decisions consistent with the recorded Stage 1D outcomes. The 22 diagnostics-only rows have no recorded rejection status to compare against.
- An independent hash check confirmed the input files were unchanged.

## 7. Safe cleanup of `.cognee/` storage

`.cognee/` is git-ignored, local and **rebuildable**. Nothing authoritative lives there. The knowledge base is `data/knowledge/regulatory_facts.json`, and committed results live under `outputs/`.

1. **Make sure no smoke test or audit is running.** Cognee holds open database files.
2. **Remove only test-run folders,** keeping the default dataset:
   ```powershell
   Remove-Item -Recurse -Force .\.cognee\verify_*
   ```
3. **Full reset.** The next run with `--yes` re-ingests from the knowledge file:
   ```powershell
   Remove-Item -Recurse -Force .\.cognee
   ```
4. **Optional:** remove the downloaded graph-DB extension cache, which is re-downloaded on next use and needs internet:
   ```powershell
   Remove-Item -Recurse -Force "$env:USERPROFILE\.lbdb"
   ```

Never delete `data/knowledge/`, `outputs/` or the `venv/` site-packages folders as part of this cleanup. A changed knowledge file automatically gets a new dataset name, from its hash, so stale datasets are never mixed with new ones. They simply stay on disk until you clean up.

## 8. Limitations and deferred work

- **Deferred — real knowledge.** The knowledge base holds one fact, the assumed $500K cap (`project_assumption`, `verified: false`). Regulatory caps, restricted corridors, payment-system holidays and operational events need real, cited sources.
- **Retrieval quality is unmeasured.** With a single fact, full retrieval coverage is easy to achieve. Precision and recall on a realistic knowledge base, and a labelled evaluation set, are future work.
- **The cap is duplicated.** The generator still hard-codes the cap (`MAX_REGULATORY_TRANSFER_USD`). A test now enforces that it equals the knowledge-base value; changing the cap means changing both, deliberately.
- **Reproducibility:**
  - live runs depend on local Ollama model builds, and provenance doesn't record the Ollama version or model digests;
  - `cognify`'s LLM graph extraction isn't deterministic and can need retries, although CHUNKS retrieval doesn't use the graph;
  - token counting uses an approximate tiktoken fallback, because `transformers` isn't installed;
  - only `cognee` is pinned, and there's no lock file.
- **Windows OpenSSL dependency** on a Git for Windows install (section 4).
- **Process-wide side effects.** The adapter sets `PATH`, `TELEMETRY_DISABLED`, `LLM_INSTRUCTOR_MODE` and, for Ollama, `LLM_API_KEY` in the process environment before importing Cognee. That's intended for scripts; avoid in long-lived shared processes.
- **Corridor-level retrieval.** The audit retrieves per corridor; date-specific applicability comes from the static cross-check, by design.
- **Live tests are manual.** There is no CI.
