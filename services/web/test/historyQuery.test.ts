import { describe, expect, it } from "vitest";
import {
  DUPLICATE_MESSAGE,
  RANGE_MESSAGE,
  clearHistoryFilters,
  hasHistoryFilters,
  isIsoDate,
  lastPageOf,
  listProblems,
  readHistoryQuery,
  toHistoryWindow,
  updateHistoryParams,
} from "../src/features/transactions/historyQuery";

const read = (query: string) => readHistoryQuery(new URLSearchParams(query));
const update = (current: string, patch: Parameters<typeof updateHistoryParams>[1]) =>
  updateHistoryParams(new URLSearchParams(current), patch).toString();

describe("isIsoDate", () => {
  it.each(["2026-11-01", "2024-02-29", "1990-01-01"])("accepts %s", (v) => expect(isIsoDate(v)).toBe(true));
  it.each(["", "2026-1-1", "01/11/2026", "2026-02-30", "2025-02-29", "2026-13-01", "2026-11-01T00:00:00Z"])("rejects %j", (v) =>
    expect(isIsoDate(v)).toBe(false),
  );
});

describe("readHistoryQuery: defaults and valid values", () => {
  it("defaults to page 1 and 20 rows, with no filters and no problems", () => {
    expect(read("")).toEqual({ query: { page: 1, pageSize: 20 }, problems: {} });
  });

  it("reads every parameter", () => {
    const { query, problems } = read(
      "corridor=GBR-%3EPHL&policy=cheapestFeasible&stateMode=explicit&completed=false&from=2026-11-01&to=2026-11-03&pageSize=50&page=2",
    );
    expect(problems).toEqual({});
    expect(query).toEqual({
      corridor: "GBR->PHL",
      policy: "cheapestFeasible",
      stateMode: "explicit",
      completed: false,
      from: "2026-11-01",
      to: "2026-11-03",
      pageSize: 50,
      page: 2,
    });
  });

  it("reads completed=true as true and completed=false as false, not as unset", () => {
    expect(read("completed=true").query.completed).toBe(true);
    expect(read("completed=false").query.completed).toBe(false);
    expect(read("").query.completed).toBeUndefined();
  });

  it.each([1, 20, 50, 100, 30])("accepts pageSize %i (the contract allows 1 to 100)", (n) => {
    expect(read(`pageSize=${n}`)).toEqual({ query: { page: 1, pageSize: n }, problems: {} });
  });

  it("ignores parameters that aren't History parameters", () => {
    expect(read("state=error&foo=bar&mock=busy&sort=createdAt%3Adesc")).toEqual({ query: { page: 1, pageSize: 20 }, problems: {} });
  });

  it("treats an empty value as not given", () => {
    expect(read("corridor=&policy=&from=&page=&pageSize=")).toEqual({ query: { page: 1, pageSize: 20 }, problems: {} });
  });
});

describe("readHistoryQuery: invalid values", () => {
  it.each([
    ["corridor=XXX-%3EYYY", "corridor", "Choose one of the listed corridors."],
    ["policy=best", "policy", "Choose one of the listed policies."],
    ["stateMode=zzz", "stateMode", "Choose one of the listed state modes."],
    ["completed=maybe", "completed", "Choose Completed or Not completed."],
    ["completed=TRUE", "completed", "Choose Completed or Not completed."],
    ["from=banana", "from", "Use the format YYYY-MM-DD."],
    ["to=2026-02-30", "to", "Use the format YYYY-MM-DD."],
    ["from=2026-1-5", "from", "Use the format YYYY-MM-DD."],
    ["from=2026-11-01T00%3A00%3A00Z", "from", "Use the format YYYY-MM-DD."],
  ])("reports %s", (query, key, message) => {
    const result = read(query);
    expect(result.problems[key as keyof typeof result.problems]).toBe(message);
    expect(result.query[key as keyof typeof result.query]).toBeUndefined(); // not applied, not corrected
  });

  it.each(["0", "-2", "abc", "1.5", "01", "1e2", "99999999999999999999"])("reports the page %j", (page) => {
    const { query, problems } = read(`page=${page}`);
    expect(problems.page).toBe("Use a whole number from 1.");
    expect(query.page).toBe(1); // the default is not a stand-in for the bad value: the problem blocks the list
  });

  it.each(["0", "101", "500", "-20", "abc", "20.5", "020"])("reports the pageSize %j", (pageSize) => {
    const { query, problems } = read(`pageSize=${pageSize}`);
    expect(problems.pageSize).toBe("Use a whole number from 1 to 100.");
    expect(query.pageSize).toBe(20);
  });
});

describe("readHistoryQuery: duplicate parameters", () => {
  it.each(["corridor", "policy", "stateMode", "completed", "from", "to", "pageSize", "page"])("reports %s given twice", (key) => {
    const value = { corridor: "GBR-%3EPHL", policy: "waterfall", stateMode: "explicit", completed: "true", from: "2026-11-01", to: "2026-11-02", pageSize: "20", page: "2" }[key]!;
    const { problems } = read(`${key}=${value}&${key}=${value}`);
    expect(problems[key as keyof typeof problems]).toBe(DUPLICATE_MESSAGE);
  });

  it("reports a duplicate even when the two values differ, and uses neither", () => {
    const { query, problems } = read("corridor=GBR-%3EPHL&corridor=USA-%3EIND");
    expect(problems.corridor).toBe(DUPLICATE_MESSAGE);
    expect(query.corridor).toBeUndefined();
  });

  it("does not count an empty copy as a duplicate", () => {
    expect(read("corridor=GBR-%3EPHL&corridor=")).toEqual({ query: { page: 1, pageSize: 20, corridor: "GBR->PHL" }, problems: {} });
  });
});

describe("readHistoryQuery: date range", () => {
  it("reports from later than to, keeping both dates as given", () => {
    const { query, problems } = read("from=2026-11-05&to=2026-11-01");
    expect(problems.to).toBe(RANGE_MESSAGE);
    expect(query.from).toBe("2026-11-05"); // not swapped or cleared
    expect(query.to).toBe("2026-11-01");
  });

  it("accepts from equal to to as a valid, empty window", () => {
    expect(read("from=2026-11-01&to=2026-11-01").problems).toEqual({});
  });

  it("accepts from earlier than to, and a single bound", () => {
    expect(read("from=2026-11-01&to=2026-11-02").problems).toEqual({});
    expect(read("from=2026-11-05").problems).toEqual({});
    expect(read("to=2026-11-01").problems).toEqual({});
  });

  it("does not guess a range when one of the dates is unusable", () => {
    expect(read("from=banana&to=2026-11-01").problems).toEqual({ from: "Use the format YYYY-MM-DD." });
    expect(read("from=2026-11-05&from=2026-11-06&to=2026-11-01").problems).toEqual({ from: DUPLICATE_MESSAGE });
  });
});

describe("readHistoryQuery: every problem together", () => {
  const url =
    "corridor=XXX&policy=best&stateMode=zzz&completed=maybe&from=2026-11-05&to=2026-11-01&pageSize=500&page=0";

  it("reports every bad parameter in one pass", () => {
    const { problems } = read(url);
    // `from` is a valid date on its own; the range problem is reported on `to`.
    expect(Object.keys(problems).sort()).toEqual(["completed", "corridor", "page", "pageSize", "policy", "stateMode", "to"]);
    expect(problems.to).toBe(RANGE_MESSAGE);
  });

  it("lists them in parameter order as name: message", () => {
    expect(listProblems(read(url).problems)).toEqual([
      "corridor: Choose one of the listed corridors.",
      "policy: Choose one of the listed policies.",
      "stateMode: Choose one of the listed state modes.",
      "completed: Choose Completed or Not completed.",
      `to: ${RANGE_MESSAGE}`,
      "pageSize: Use a whole number from 1 to 100.",
      "page: Use a whole number from 1.",
    ]);
  });

  it("has no problems for a clean URL", () => {
    expect(listProblems(read("corridor=GBR-%3EPHL&page=2").problems)).toEqual([]);
  });
});

describe("toHistoryWindow (UTC)", () => {
  it("turns a date into UTC midnight, from included and to not included", () => {
    expect(toHistoryWindow({ from: "2026-11-01", to: "2026-11-03" })).toEqual({
      from: "2026-11-01T00:00:00.000Z",
      to: "2026-11-03T00:00:00.000Z",
    });
    expect(Date.parse(toHistoryWindow({ from: "2026-11-01" }).from!)).toBe(Date.UTC(2026, 10, 1));
  });

  it("leaves a missing bound null, meaning unbounded", () => {
    expect(toHistoryWindow({})).toEqual({ from: null, to: null });
  });
});

describe("updateHistoryParams", () => {
  it("sets a filter and resets the page", () => {
    expect(update("page=2", { corridor: "GBR->PHL" })).toBe("corridor=GBR-%3EPHL");
  });

  it("resets the page when the page size changes", () => {
    expect(update("page=3", { pageSize: "50" })).toBe("pageSize=50");
  });

  it("keeps the page only when the page itself changes", () => {
    expect(update("corridor=GBR-%3EPHL", { page: "2" })).toBe("corridor=GBR-%3EPHL&page=2");
    expect(update("page=2", { page: "3" })).toBe("page=3");
  });

  it("does not write the defaults", () => {
    expect(update("page=2", { page: "1" })).toBe("");
    expect(update("pageSize=50", { pageSize: "20" })).toBe("");
  });

  it("removes a filter when its value is cleared", () => {
    expect(update("corridor=GBR-%3EPHL&policy=waterfall", { corridor: undefined })).toBe("policy=waterfall");
    expect(update("policy=waterfall", { policy: "" })).toBe("");
  });

  it("replaces every copy of a duplicated parameter", () => {
    expect(update("corridor=GBR-%3EPHL&corridor=USA-%3EIND", { corridor: "ARE->MEX" })).toBe("corridor=ARE-%3EMEX");
  });

  it("leaves untouched parameters exactly as they were, including invalid ones, so an error never goes away by itself", () => {
    expect(update("corridor=XXX&from=banana", { policy: "waterfall" })).toBe("corridor=XXX&from=banana&policy=waterfall");
  });

  it("preserves unrelated parameters", () => {
    expect(update("state=loading&foo=bar", { corridor: "GBR->PHL" })).toBe("state=loading&foo=bar&corridor=GBR-%3EPHL");
    expect(update("foo=bar&page=2", { page: "3" })).toBe("foo=bar&page=3");
  });

  it("does not change the object it is given", () => {
    const current = new URLSearchParams("page=2");
    updateHistoryParams(current, { corridor: "GBR->PHL" });
    expect(current.toString()).toBe("page=2");
  });
});

describe("clearHistoryFilters and hasHistoryFilters", () => {
  it("removes the six filters and the page, and keeps the page size and unrelated parameters", () => {
    const next = clearHistoryFilters(
      new URLSearchParams("corridor=XXX&policy=waterfall&stateMode=explicit&completed=true&from=2026-11-01&to=2026-11-02&page=2&pageSize=50&state=loading"),
    );
    expect(next.toString()).toBe("pageSize=50&state=loading");
  });

  it("detects a filter, valid or not, but not the page size or the page", () => {
    expect(hasHistoryFilters(new URLSearchParams(""))).toBe(false);
    expect(hasHistoryFilters(new URLSearchParams("page=2&pageSize=50&state=loading"))).toBe(false);
    expect(hasHistoryFilters(new URLSearchParams("corridor=XXX"))).toBe(true);
    expect(hasHistoryFilters(new URLSearchParams("to=2026-11-01"))).toBe(true);
    expect(hasHistoryFilters(new URLSearchParams("corridor="))).toBe(false);
  });
});

describe("lastPageOf", () => {
  it.each([
    [57, 20, 3],
    [57, 50, 2],
    [57, 100, 1],
    [40, 20, 2],
    [41, 20, 3],
    [1, 20, 1],
    [0, 20, 1], // there is always a page 1
  ])("%i results at %i per page have %i page(s)", (total, size, pages) => expect(lastPageOf(total, size)).toBe(pages));
});
