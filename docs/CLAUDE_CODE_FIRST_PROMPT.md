# First prompt for the new Claude Pro account / Claude Code

You are taking over an existing research prototype called **CBDC Liquidity Router**. The repository is already on disk in the current working directory.

Read the root `CLAUDE.md` and `docs/PROJECT_HANDOVER.md` first. Treat them as project context, but treat the live repository, data files, git history, and test outcomes as the source of truth.

## Your first task: READ-ONLY PROJECT AUDIT — DO NOT EDIT FILES

Do not implement anything yet. Do not reformat, refactor, rename, regenerate, delete, or modify project files. Do not commit, push, reset, rebase, or change branches.

First inspect:
1. `git status --short --branch`, current branch, HEAD hash, recent commits, and tags.
2. The complete repository tree (exclude `venv`, caches, and large data payloads from the printed listing, but inventory them separately).
3. README, dependency/lock files, `.gitignore`, and all project scripts.
4. Stage 1A–1D source files and tests.
5. The PPO model, PPO training loop, reward function, environment execution, dynamic bridge state, transaction generator, evaluation and metrics modules.
6. The entropy experiment script and its saved output directory, including both checkpoints, training histories, evaluation JSONs, config and paired comparison.
7. Data files required to reproduce training/evaluation, including exact schemas, row counts, regime counts and provenance. Do not change the data.

Then run the full test suite using the repository's documented environment, if dependencies and data are present. Record the exact command, result, warnings and any blocker. Do not install or upgrade dependencies without asking first.

## Audit report required
Produce a structured report containing:

A. **Project understanding** — problem, objective, policy action semantics, environment execution, reward terms, baselines and transaction regimes.

B. **Repository map** — key files and their roles, with exact paths confirmed from the live repo.

C. **Git integrity** — branch, HEAD, working tree, last commits, tags, and uncommitted changes. Identify which changes are already committed versus only local.

D. **Reproducibility** — Python/dependency versions, data availability, exact train/validation/test split paths, generation seeds and commands, model/training command, GPU/CPU status, and any hard-coded paths.

E. **Test status** — exact suite counts and warnings, including any regression failures.

F. **Entropy experiment verification** — verify that the entropy term truly participates in the loss, the runtime coefficient is controlled as intended, checkpoints correspond to the intended conditions, evaluation uses deterministic PPO actions (unless documented otherwise), and output files are complete. Compare the live saved metrics to the values in the handover document.

G. **Research interpretation** — describe the seed-42 result accurately, including improvements and trade-offs. Do not call it robust or statistically significant. Do not hide that waterfall remains stronger and that allocation entropy decreased despite policy entropy regularization.

H. **Open risks** — test-set reuse, single-seed result, small dataset, remaining failed `splitting_needed` cases, baseline gap, data portability/provenance, and any implementation discrepancies.

I. **Recommended next action** — recommend the smallest safe way to run the paired multi-seed experiment (existing baseline entropy 0.0 versus 0.005, additional seeds 123 and 2026), with no unrelated model or reward changes. State which files would need to change, if any, but do not change them yet.

## Strict constraints
- Preserve Stage 1A, 1B, and 1C semantics and all regression tests.
- Preserve the existing Stage 1D 35-test suite; never replace it with stale test files.
- Keep the seed-42 experiment artifacts immutable.
- Do not tune coefficients against the already examined test set. Use validation for model/parameter selection and plan a fresh final holdout before final claims.
- No scope creep: do not redesign the architecture, alter reward weights, regenerate datasets, or modify environment semantics.
- No coding until I review and approve your audit report and next-step plan.

At the end, give me a concise table: `Verified`, `Not verified`, `Discrepancy`, `Recommended next step`.
