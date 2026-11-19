import { describe, expect, it } from "vitest";
import {
  DATA_SOURCE_NAMES,
  dataSourceName,
  formatFeeFraction,
  provenanceName,
} from "../src/features/network/types";
import { PREVIEW_NETWORK } from "../src/preview/previewNetwork";
import { PREVIEW_ENGINE_MODEL, PREVIEW_REFERENCE } from "../src/preview/previewReference";

describe("formatFeeFraction", () => {
  // The contract defines feePct as a fraction: 0.015 is 1.5%.
  it.each([
    [0.015, "1.50%"],
    [0.0105, "1.05%"],
    [0.0225, "2.25%"],
    [0.02, "2.00%"],
    [0.014, "1.40%"],
    [0.008, "0.80%"],
    [0.03, "3.00%"],
    [0.0084, "0.84%"],
    [0, "0.00%"],
    [1, "100.00%"],
  ])("shows %d as %s", (fraction, text) => expect(formatFeeFraction(fraction)).toBe(text));

  it("rounds to two decimals of a percent", () => {
    expect(formatFeeFraction(0.01234)).toBe("1.23%");
    expect(formatFeeFraction(0.01236)).toBe("1.24%");
  });

  it("does not treat the value as already being a percentage", () => {
    expect(formatFeeFraction(1.5)).toBe("150.00%");
  });

  it("does not change the number it is given", () => {
    const fee = 0.0105;
    formatFeeFraction(fee);
    expect(fee).toBe(0.0105);
  });
});

describe("data-source and provenance names", () => {
  it("uses the approved descriptions", () => {
    expect(DATA_SOURCE_NAMES).toEqual({
      real_static_bridge: "Real static bridge",
      synthetic_bridge_expansion: "Synthetic expansion",
      synthetic_no_real_anchor: "Synthetic — no real anchor",
    });
  });

  it("shows an unknown tag or provenance as written", () => {
    expect(dataSourceName("something_new")).toBe("something_new");
    expect(provenanceName("something_new")).toBe("something_new");
  });

  it("names the one known provenance", () => {
    expect(provenanceName("project_assumption")).toBe("Project assumption");
  });
});

describe("PREVIEW_NETWORK", () => {
  it("is built from the New Transaction reference data, with nothing copied or reordered", () => {
    expect(PREVIEW_NETWORK.corridors.map((c) => c.corridor)).toEqual(PREVIEW_REFERENCE.corridors.map((c) => c.corridor));
    PREVIEW_NETWORK.corridors.forEach((corridor, ci) => {
      const source = PREVIEW_REFERENCE.corridors[ci]!;
      expect(corridor.senderCountry).toBe(source.senderCountry);
      expect(corridor.receiverCountry).toBe(source.receiverCountry);
      expect(corridor.venues.map((v) => v.bridgeUid)).toEqual(source.venues.map((v) => v.bridgeUid));
      corridor.venues.forEach((venue, vi) => {
        expect(venue.slot).toBe(vi);
        expect(venue.feePct).toBe(source.venues[vi]!.feePct);
        expect(venue.dataSourceTag).toBe(source.venues[vi]!.dataSourceTag);
        expect(venue.baselineCapacityUsd).toBe(PREVIEW_ENGINE_MODEL.baselineCapacityUsd[venue.bridgeUid]);
      });
    });
    expect(PREVIEW_NETWORK.maxSingleTransferUsd).toBe(PREVIEW_REFERENCE.maxSingleTransferUsd);
  });

  it("keeps fees as fractions, not percentages", () => {
    for (const corridor of PREVIEW_NETWORK.corridors) {
      for (const venue of corridor.venues) {
        expect(venue.feePct).toBeGreaterThan(0);
        expect(venue.feePct).toBeLessThan(0.1);
      }
    }
  });

  it("builds new objects, so the source values can't be changed through it", () => {
    PREVIEW_NETWORK.corridors.forEach((corridor, ci) => {
      const source = PREVIEW_REFERENCE.corridors[ci]!;
      expect(corridor).not.toBe(source);
      expect(corridor.venues).not.toBe(source.venues);
      corridor.venues.forEach((venue, vi) => expect(venue).not.toBe(source.venues[vi]));
    });
    expect(PREVIEW_REFERENCE.corridors[1]!.venues[0]!.feePct).toBe(0.019); // untouched
  });

  it("lists three corridors with positive baseline capacity and known data-source tags", () => {
    expect(PREVIEW_NETWORK.corridors).toHaveLength(3);
    for (const corridor of PREVIEW_NETWORK.corridors) {
      expect(corridor.venues.length).toBeGreaterThan(0);
      for (const venue of corridor.venues) {
        expect(venue.baselineCapacityUsd).toBeGreaterThan(0);
        expect(Object.keys(DATA_SOURCE_NAMES)).toContain(venue.dataSourceTag);
        expect(venue.bridgeUid.startsWith(`${corridor.corridor}#`)).toBe(true);
      }
    }
  });

  it("carries the single-transfer limit with its provenance", () => {
    expect(PREVIEW_NETWORK.maxSingleTransferUsd).toBe(500000);
    expect(PREVIEW_NETWORK.maxSingleTransferProvenance).toBe("project_assumption");
  });

  it("has no liquidity, congestion or status fields", () => {
    const keys = new Set<string>();
    for (const corridor of PREVIEW_NETWORK.corridors) {
      Object.keys(corridor).forEach((k) => keys.add(k));
      for (const venue of corridor.venues) Object.keys(venue).forEach((k) => keys.add(k));
    }
    expect([...keys].sort()).toEqual(
      ["baselineCapacityUsd", "bridgeUid", "corridor", "dataSourceTag", "feePct", "receiverCountry", "senderCountry", "slot", "venues"].sort(),
    );
  });
});
