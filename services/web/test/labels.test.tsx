import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MandatoryLabel } from "../src/components/labels/MandatoryLabel";
import { MANDATORY_LABELS } from "../src/lib/labels";

// Vitest runs from services/web; the doc is at the repository root.
const archPath = resolve(process.cwd(), "../../docs/PHASE2_ARCHITECTURE.md");

describe("mandatory labels (arch §5.3)", () => {
  it("match the expected strings exactly", () => {
    expect(MANDATORY_LABELS).toEqual({
      simulated: "Simulated",
      userSuppliedState: "User-supplied synthetic state",
      experimental: "Experimental",
      placeholderWeights: "Placeholder weights",
      defaultWaterfall: "Default (waterfall)",
      syntheticVenue: "Synthetic venue",
      devAuthBanner: "Development authentication — not secure",
    });
  });

  it("appear verbatim, in bold, in docs/PHASE2_ARCHITECTURE.md", () => {
    const arch = readFileSync(archPath, "utf8");
    for (const label of Object.values(MANDATORY_LABELS)) {
      expect(arch).toContain(`**${label}**`);
    }
  });

  it("renders the label text unchanged", () => {
    render(<MandatoryLabel kind="defaultWaterfall" />);
    expect(screen.getByText("Default (waterfall)")).toBeInTheDocument();
  });
});
