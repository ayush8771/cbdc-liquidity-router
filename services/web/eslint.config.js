import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist", "coverage", "src/api/generated"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Tokens must never be logged (arch §8.3).
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  // Phase 3 D-24, AD-6 B-8: observation state stays separate from form, routing and transaction state,
  // with no import path either way. Only the dashboard mounts the panel, through ObservationsSection.
  {
    files: ["src/features/observations/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/newTransaction/**",
                "**/compare/**",
                "**/transactions/**",
                "**/dashboard/**",
                "**/bridges/**",
                "**/network/**",
                "**/globe/**",
                "**/api/client",
                "**/api/useApiQuery",
                "**/api/types",
                "**/preview/**",
              ],
              message: "Observation code must not import routing, transaction, compare or API-client code (AD-6 B-8).",
            },
            {
              // The whole module, so `import * as auth` and re-exports are rejected too; observationSession is the way in.
              group: ["**/auth/AuthContext"],
              message: "Observation code must import useObservationSession from auth/observationSession, not AuthContext: it exposes the API client (AD-6 B-8).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/features/observations/**", "src/pages/DashboardDesktop.tsx", "src/main.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/observations/**"],
              message: "Only the dashboard (ObservationsSection) and main.tsx may import observation code (AD-6 B-8).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["*.config.{js,ts}"],
    languageOptions: { globals: { ...globals.node } },
  },
);
