import { describe, expect, it } from "vitest";
import {
  RANGE_MESSAGE,
  describeWindow,
  hasDashboardFilters,
  isIsoDate,
  readDashboardParams,
  toWindow,
  validateRange,
  writeDashboardParams,
} from "../src/features/dashboard/dashboardQuery";

const read = (query: string) => readDashboardParams(new URLSearchParams(query));

describe("isIsoDate", () => {
  it.each(["2026-11-01", "2024-02-29", "1990-01-01"])("accepts %s", (v) => expect(isIsoDate(v)).toBe(true));
  it.each(["", "2026-1-1", "01/11/2026", "2026-02-30", "2025-02-29", "2026-13-01", "2026-11-01T00:00"])("rejects %j", (v) =>
    expect(isIsoDate(v)).toBe(false),
  );
});

describe("readDashboardParams", () => {
  it("reads no filters from an empty URL", () => {
    expect(read("")).toEqual({ filters: {}, problems: {} });
  });

  it("reads all four filters", () => {
    const { filters, problems } = read("corridor=GBR-%3EPHL&policy=cheapestFeasible&from=2026-11-01&to=2026-11-03");
    expect(filters).toEqual({ corridor: "GBR->PHL", policy: "cheapestFeasible", from: "2026-11-01", to: "2026-11-03" });
    expect(problems).toEqual({});
  });

  it("reads the filters one at a time", () => {
    expect(read("from=2026-11-01").filters).toEqual({ from: "2026-11-01" });
    expect(read("to=2026-11-01").filters).toEqual({ to: "2026-11-01" });
    expect(read("policy=ppoProjected").filters).toEqual({ policy: "ppoProjected" });
  });

  it("reports an unknown corridor or policy instead of dropping it silently", () => {
    const { filters, problems } = read("corridor=XXX-%3EYYY&policy=best");
    expect(filters).toEqual({});
    expect(problems.corridor).toBe("Choose one of the listed corridors.");
    expect(problems.policy).toBe("Choose one of the listed policies.");
  });

  it.each(["banana", "2026-02-30", "2026-1-5", "01/11/2026"])("reports the malformed date %j", (value) => {
    const { filters, problems } = read(`from=${encodeURIComponent(value)}`);
    expect(filters.from).toBeUndefined();
    expect(problems.from).toBe("Use the format YYYY-MM-DD.");
  });

  it("ignores parameters that aren't dashboard filters, such as the preview state", () => {
    expect(read("state=error&page=2&mock=busy")).toEqual({ filters: {}, problems: {} });
  });

  describe("date range", () => {
    it("reports from later than to, keeping both values exactly as given", () => {
      const { filters, problems } = read("from=2026-11-05&to=2026-11-01");
      expect(problems.to).toBe(RANGE_MESSAGE);
      expect(filters).toEqual({ from: "2026-11-05", to: "2026-11-01" }); // not swapped, not cleared
    });

    it("accepts from equal to to: a valid window that is empty", () => {
      expect(read("from=2026-11-01&to=2026-11-01").problems).toEqual({});
    });

    it("accepts from earlier than to", () => {
      expect(read("from=2026-11-01&to=2026-11-02").problems).toEqual({});
    });

    it("has no range problem with only one bound", () => {
      expect(read("from=2026-11-05").problems).toEqual({});
      expect(read("to=2026-11-01").problems).toEqual({});
    });
  });
});

describe("validateRange", () => {
  it("is null when the range is fine or open", () => {
    expect(validateRange({})).toBeNull();
    expect(validateRange({ from: "2026-11-01" })).toBeNull();
    expect(validateRange({ from: "2026-11-01", to: "2026-11-01" })).toBeNull();
    expect(validateRange({ from: "2026-11-01", to: "2026-12-01" })).toBeNull();
  });

  it("says so when from is later than to", () => {
    expect(validateRange({ from: "2026-11-02", to: "2026-11-01" })).toBe(RANGE_MESSAGE);
    expect(validateRange({ from: "2027-01-01", to: "2026-12-31" })).toBe(RANGE_MESSAGE);
  });
});

describe("toWindow (UTC)", () => {
  it("turns a date into UTC midnight", () => {
    expect(toWindow({ from: "2026-11-01", to: "2026-11-03" })).toEqual({
      from: "2026-11-01T00:00:00.000Z",
      to: "2026-11-03T00:00:00.000Z",
    });
  });

  it("is exactly UTC midnight whatever the machine's time zone", () => {
    const { from, to } = toWindow({ from: "2026-11-01", to: "2026-11-03" });
    expect(Date.parse(from!)).toBe(Date.UTC(2026, 10, 1));
    expect(Date.parse(to!)).toBe(Date.UTC(2026, 10, 3));
    expect(from!.endsWith("T00:00:00.000Z")).toBe(true);
  });

  it("leaves a missing bound null, which means unbounded", () => {
    expect(toWindow({})).toEqual({ from: null, to: null });
    expect(toWindow({ from: "2026-11-01" })).toEqual({ from: "2026-11-01T00:00:00.000Z", to: null });
    expect(toWindow({ to: "2026-11-01" })).toEqual({ from: null, to: "2026-11-01T00:00:00.000Z" });
  });

  it("handles a leap day and a year boundary", () => {
    expect(toWindow({ from: "2024-02-29" }).from).toBe("2024-02-29T00:00:00.000Z");
    expect(toWindow({ to: "2027-01-01" }).to).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("describeWindow", () => {
  it("says All time when both bounds are null", () => {
    expect(describeWindow({ from: null, to: null })).toBe("All time");
  });

  it("describes a bounded window in UTC, with the end not included", () => {
    const text = describeWindow(toWindow({ from: "2026-11-01", to: "2026-11-03" }));
    expect(text).toBe("1 Nov 2026, 00:00 UTC to 3 Nov 2026, 00:00 UTC (end not included)");
  });

  it("describes a window with one bound", () => {
    expect(describeWindow(toWindow({ from: "2026-11-01" }))).toBe("From 1 Nov 2026, 00:00 UTC");
    expect(describeWindow(toWindow({ to: "2026-11-03" }))).toBe("Until 3 Nov 2026, 00:00 UTC (not included)");
  });
});

describe("writeDashboardParams", () => {
  it("writes only the filters that are set", () => {
    expect(writeDashboardParams({}).toString()).toBe("");
    expect(writeDashboardParams({ policy: "waterfall", from: "2026-11-01" }).toString()).toBe("policy=waterfall&from=2026-11-01");
  });

  it("round-trips through the URL", () => {
    const filters = { corridor: "ARE->MEX", policy: "ppoProjected" as const, from: "2026-10-01", to: "2026-11-01" };
    expect(readDashboardParams(writeDashboardParams(filters))).toEqual({ filters, problems: {} });
  });
});

describe("hasDashboardFilters", () => {
  it("is true only when a filter is set", () => {
    expect(hasDashboardFilters({})).toBe(false);
    expect(hasDashboardFilters({ corridor: undefined })).toBe(false);
    expect(hasDashboardFilters({ to: "2026-11-01" })).toBe(true);
  });
});
