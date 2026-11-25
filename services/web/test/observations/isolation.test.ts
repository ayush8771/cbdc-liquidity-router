import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/*
 * AD-6 B-8 / T-4: observation state is separate from form and request state, "checked by lint". These
 * tests lint synthetic source text in place of real files, so a deliberate violation must fail.
 */
const eslint = new ESLint({ cwd: process.cwd() });

async function problems(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.message);
}

describe("observation module isolation (lint)", () => {
  it.each([
    "../newTransaction/NewTransactionForm",
    "../compare/compareApi",
    "../transactions/historyApi",
    "../dashboard/dashboardApi",
    "../../api/client",
    "../../api/useApiQuery",
    "../../preview/previewData",
    "../../features/compare/compareApi",
  ])("rejects an import of %s from the observations module", async (path) => {
    expect(await problems("src/features/observations/probe.ts", `import "${path}";\n`)).toHaveLength(1);
  });

  it("rejects the reverse: other features, API code and pages importing observation code", async () => {
    const code = `import "../observations/flags";\n`;
    expect(await problems("src/features/newTransaction/probe.ts", code)).toHaveLength(1);
    expect(await problems("src/features/dashboard/probe.ts", code)).toHaveLength(1);
    expect(await problems("src/api/probe.ts", `import "../features/observations/flags";\n`)).toHaveLength(1);
    expect(await problems("src/pages/ComparePage.tsx", `import "../features/observations/flags";\n`)).toHaveLength(1);
  });

  it("allows what the slice needs: the session, the data mode and the shared UI primitives", async () => {
    const code = `import "../../auth/AuthContext";\nimport "../../api/dataMode";\nimport "../../components/ui/Card";\nimport "./flags";\n`;
    expect(await problems("src/features/observations/probe.ts", code)).toEqual([]);
  });

  it("allows the dashboard and main.tsx to import the panel and the flag", async () => {
    expect(await problems("src/pages/DashboardDesktop.tsx", `import "../features/observations/ObservationPanel";\n`)).toEqual([]);
    expect(await problems("src/main.tsx", `import "./features/observations/flags";\n`)).toEqual([]);
  });
});
