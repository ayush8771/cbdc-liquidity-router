import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// The D-24 observation acceptance tests (e2e/p3/). They need stacks that p3_browser_acceptance.py builds (fake ingestion, a web build per
// flavour), so they are NOT part of the Phase 2 `npm test`, which keeps its own config and its 7 tests. Everything else, including the loopback
// guard, the single worker and the no-recording settings, is inherited from playwright.config.ts.
export default defineConfig({ ...base, testDir: "./p3" });
