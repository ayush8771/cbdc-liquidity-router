import { describe, expect, it } from "vitest";
import type { FormValues, ServerError } from "../src/features/newTransaction/types";
import {
  describeFailure,
  fieldKeyForPath,
  initialValues,
  isIsoDate,
  isNotReady,
  parseNumber,
  validateForm,
} from "../src/features/newTransaction/validate";
import { PREVIEW_REFERENCE } from "../src/preview/previewReference";

const valid = (patch: Partial<FormValues> = {}): FormValues => ({
  ...initialValues(),
  corridor: "GBR->PHL",
  amountUsd: "300000",
  date: "2024-06-14",
  ...patch,
});
const check = (patch: Partial<FormValues> = {}) => validateForm(valid(patch), PREVIEW_REFERENCE);

describe("parseNumber", () => {
  it.each([
    ["300000", 300000],
    ["  12.5  ", 12.5],
    [".5", 0.5],
    ["1e3", 1000],
    ["-4", -4],
    ["+7", 7],
  ])("reads %j as %d", (text, expected) => expect(parseNumber(text)).toBe(expected));

  it.each(["", "   ", "abc", "1,000", "0x10", "Infinity", "NaN", "1e999", "--1", "1.2.3", "12abc"])(
    "rejects %j",
    (text) => expect(parseNumber(text)).toBeNull(),
  );
});

describe("isIsoDate", () => {
  it.each(["2024-06-14", "2025-09-30", "2024-02-29", "1990-01-01", "2099-12-31"])("accepts %s", (v) =>
    expect(isIsoDate(v)).toBe(true),
  );
  it.each(["", "2024-6-14", "14/06/2024", "2024-02-30", "2023-02-29", "2024-13-01", "2024-00-10", "2024-06-14T00:00"])(
    "rejects %j",
    (v) => expect(isIsoDate(v)).toBe(false),
  );
});

describe("validateForm: required fields and formats", () => {
  it("asks for the corridor and the amount on an empty form, and nothing else", () => {
    const { errors, payload } = validateForm(initialValues(), PREVIEW_REFERENCE);
    expect(payload).toBeNull();
    expect(errors.corridor).toBe("Choose a corridor.");
    expect(errors.amountUsd).toBe("Enter an amount.");
    expect(errors.date).toBe("Enter a date.");
    expect(Object.keys(errors).sort()).toEqual(["amountUsd", "corridor", "date"]);
  });

  it("builds the payload with sender and receiver taken from the chosen corridor", () => {
    const { errors, payload } = check();
    expect(errors).toEqual({});
    expect(payload).toEqual({
      senderCountry: "GBR",
      receiverCountry: "PHL",
      amountUsd: 300000,
      state: { mode: "historicalReplay", date: "2024-06-14" },
      policy: "waterfall",
    });
  });

  it.each([
    ["USA->IND", "USA", "IND"],
    ["GBR->PHL", "GBR", "PHL"],
    ["ARE->MEX", "ARE", "MEX"],
  ])("maps corridor %s to %s and %s", (corridor, sender, receiver) => {
    expect(check({ corridor }).payload).toMatchObject({ senderCountry: sender, receiverCountry: receiver });
  });

  it("rejects a corridor that isn't listed", () => {
    expect(check({ corridor: "XXX->YYY" }).errors.corridor).toBe("Choose one of the listed corridors.");
  });

  it.each([
    ["0", "The amount must be greater than 0 and finite."],
    ["-5", "The amount must be greater than 0 and finite."],
    ["abc", "Enter a valid number."],
    ["Infinity", "Enter a valid number."],
    ["", "Enter an amount."],
  ])("rejects the amount %j", (amountUsd, message) => {
    expect(check({ amountUsd }).errors.amountUsd).toBe(message);
  });

  it("does not block an amount above the single-transfer cap: rejection is a result", () => {
    const { errors, payload } = check({ amountUsd: "600000" });
    expect(errors).toEqual({});
    expect(payload?.amountUsd).toBe(600000);
  });

  it("checks the date format and that it is a real date, not whether the engine accepts it", () => {
    expect(check({ date: "" }).errors.date).toBe("Enter a date.");
    expect(check({ date: "2024-02-30" }).errors.date).toBe("Use the format YYYY-MM-DD.");
    expect(check({ date: "1990-01-01" }).errors).toEqual({}); // outside the data: the engine decides
    expect(check({ date: "2099-12-31" }).errors).toEqual({});
  });

  it("requires a scenario in scenario mode and includes it in the payload", () => {
    expect(check({ mode: "scenario" }).errors.scenarioId).toBe("Choose a scenario.");
    expect(check({ mode: "scenario", scenarioId: "baseline" }).payload?.state).toEqual({
      mode: "scenario",
      date: "2024-06-14",
      scenarioId: "baseline",
    });
  });

  it("does not ask for a scenario or date it doesn't use", () => {
    expect(check({ mode: "historicalReplay", scenarioId: "" }).errors).toEqual({});
    const explicit = check({ mode: "explicit", date: "", referenceDate: "2024-06-14" });
    expect(explicit.errors.date).toBeUndefined();
  });
});

describe("validateForm: policy and client reference", () => {
  it("keeps waterfall the default and accepts cheapestFeasible", () => {
    expect(initialValues().policy).toBe("waterfall");
    expect(check({ policy: "cheapestFeasible" }).payload?.policy).toBe("cheapestFeasible");
  });

  it("refuses ppoProjected while it is disabled, with the reason", () => {
    const { errors, payload } = check({ policy: "ppoProjected" });
    expect(payload).toBeNull();
    expect(errors.policy).toBe("PPO (projected) is unavailable: no approved checkpoint configured.");
  });

  it("omits a blank client reference and trims a given one", () => {
    expect(check({ clientReference: "   " }).payload).not.toHaveProperty("clientReference");
    expect(check({ clientReference: "  PO-1  " }).payload?.clientReference).toBe("PO-1");
  });

  it("allows 200 characters and refuses 201, counting characters not UTF-16 units", () => {
    expect(check({ clientReference: "a".repeat(200) }).errors).toEqual({});
    expect(check({ clientReference: "a".repeat(201) }).errors.clientReference).toBe("Use at most 200 characters.");
    expect(check({ clientReference: "😀".repeat(200) }).errors).toEqual({}); // 400 UTF-16 units, 200 characters
    expect(check({ clientReference: "😀".repeat(201) }).errors.clientReference).toBeDefined();
  });
});

describe("validateForm: explicit state", () => {
  const venues = (liquidityUsd: string, congestion: string) =>
    ["GBR->PHL#0", "GBR->PHL#1", "GBR->PHL#2"].map((bridgeUid) => ({ bridgeUid, liquidityUsd, congestion }));
  const explicit = (patch: Partial<FormValues> = {}) =>
    check({ mode: "explicit", referenceDate: "2024-06-14", venues: venues("210000", "0.35"), ...patch });

  it("builds numeric venues", () => {
    expect(explicit().payload?.state).toEqual({
      mode: "explicit",
      referenceDate: "2024-06-14",
      venues: [
        { bridgeUid: "GBR->PHL#0", liquidityUsd: 210000, congestion: 0.35 },
        { bridgeUid: "GBR->PHL#1", liquidityUsd: 210000, congestion: 0.35 },
        { bridgeUid: "GBR->PHL#2", liquidityUsd: 210000, congestion: 0.35 },
      ],
    });
  });

  it("requires a reference date and each venue's liquidity and congestion", () => {
    const { errors, payload } = explicit({ referenceDate: "", venues: venues("", "") });
    expect(payload).toBeNull();
    expect(errors.referenceDate).toBe("Enter a date.");
    for (let i = 0; i < 3; i += 1) {
      expect(errors[`venues.${i}.liquidityUsd`]).toBe("Enter the liquidity.");
      expect(errors[`venues.${i}.congestion`]).toBe("Enter the congestion.");
    }
  });

  it("requires finite numbers", () => {
    const { errors } = explicit({ venues: venues("lots", "Infinity") });
    expect(errors["venues.0.liquidityUsd"]).toBe("Enter a valid number.");
    expect(errors["venues.0.congestion"]).toBe("Enter a valid number.");
  });

  it("does not impose a non-negative rule the contract doesn't have", () => {
    const { errors, payload } = explicit({ venues: venues("-1", "-0.5") });
    expect(errors).toEqual({});
    expect(payload?.state).toMatchObject({ venues: [{ liquidityUsd: -1, congestion: -0.5 }, expect.anything(), expect.anything()] });
  });

  it("reports a missing venue identifier", () => {
    const { errors } = explicit({ venues: [{ bridgeUid: " ", liquidityUsd: "1", congestion: "1" }] });
    expect(errors["venues.0.bridgeUid"]).toBe("Enter the venue.");
  });
});

describe("fieldKeyForPath", () => {
  it.each([
    ["senderCountry", "corridor"],
    ["receiverCountry", "corridor"],
    ["amountUsd", "amountUsd"],
    ["policy", "policy"],
    ["clientReference", "clientReference"],
    ["state.mode", "mode"],
    ["state.date", "date"],
    ["state.scenarioId", "scenarioId"],
    ["state.referenceDate", "referenceDate"],
    ["state.venues[1].liquidityUsd", "venues.1.liquidityUsd"],
    ["state.venues[0].congestion", "venues.0.congestion"],
    ["state.venues[2].bridgeUid", "venues.2.bridgeUid"],
  ])("maps %s to %s", (path, key) => expect(fieldKeyForPath(path)).toBe(key));

  it.each(["state.venues", "state.venues[1].history.liquidityUsd", "state", "unknown", ""])(
    "leaves %j as form-level",
    (path) => expect(fieldKeyForPath(path)).toBeNull(),
  );
});

describe("describeFailure", () => {
  const base: ServerError = { status: 422, code: "VALIDATION_ERROR", message: "Request failed validation.", details: {}, requestId: "req-1" };

  it("maps VALIDATION_ERROR details.errors[] to fields, keeping unmapped ones form-level", () => {
    const { fields, form } = describeFailure({
      ...base,
      details: {
        errors: [
          { field: "amountUsd", message: "Bad amount." },
          { field: "state.venues[1].liquidityUsd", message: "Bad liquidity." },
          { field: "state.venues[1].history.liquidityUsd", message: "Bad history." },
          { message: "Form-level problem." },
        ],
      },
    });
    expect(fields).toEqual({ amountUsd: "Bad amount.", "venues.1.liquidityUsd": "Bad liquidity." });
    expect(form.messages).toEqual(["state.venues[1].history.liquidityUsd: Bad history.", "Form-level problem."]);
    expect(form.title).toBe("The request failed validation");
    expect(form.code).toBe("VALIDATION_ERROR");
    expect(form.requestId).toBe("req-1");
  });

  it("falls back to the backend message when a VALIDATION_ERROR has no details", () => {
    const { fields, form } = describeFailure(base);
    expect(fields).toEqual({});
    expect(form.messages).toEqual(["Request failed validation."]);
  });

  it("shows any other error as a form-level message with the backend's own message and request ID", () => {
    const { fields, form } = describeFailure({ ...base, status: 422, code: "DATE_OUT_OF_RANGE", message: "Outside the data.", details: {} });
    expect(fields).toEqual({});
    expect(form.messages).toEqual(["Outside the data."]);
    expect(form.title).toBe("The request wasn't accepted");
    expect(form.requestId).toBe("req-1");
  });

  it("uses details.field when present, without depending on it", () => {
    const withField = describeFailure({ ...base, code: "INVALID_AMOUNT", message: "Amount.", details: { field: "amountUsd" } });
    expect(withField.fields).toEqual({ amountUsd: "Amount." });
    expect(withField.form.messages).toEqual(["Amount."]); // still form-level too
    const withoutField = describeFailure({ ...base, code: "INVALID_AMOUNT", message: "Amount.", details: {} });
    expect(withoutField.fields).toEqual({});
    expect(withoutField.form.messages).toEqual(["Amount."]);
  });

  it("titles a 5xx failure as a routing failure", () => {
    const { form } = describeFailure({ ...base, status: 503, code: "ENGINE_BUSY", message: "Busy.", details: { transactionId: "t" } });
    expect(form.title).toBe("Routing failed");
  });
});

describe("NOT_READY: the engine was still starting up", () => {
  const unavailable: ServerError = {
    status: 503,
    code: "INFERENCE_UNAVAILABLE",
    message: "The inference service is unavailable.",
    details: { transactionId: "t-1", cause: "NOT_READY" },
    requestId: "req-9",
  };

  describe("isNotReady", () => {
    it("is true for a 503 INFERENCE_UNAVAILABLE with details.cause NOT_READY", () => {
      expect(isNotReady(unavailable)).toBe(true);
    });

    it("is false for the same code with no cause: an ordinary unavailable inference service", () => {
      expect(isNotReady({ ...unavailable, details: { transactionId: "t-1" } })).toBe(false);
    });

    it("is false for any other cause", () => {
      expect(isNotReady({ ...unavailable, details: { cause: "SOMETHING_ELSE" } })).toBe(false);
      expect(isNotReady({ ...unavailable, details: { cause: "not_ready" } })).toBe(false);
      expect(isNotReady({ ...unavailable, details: { cause: "" } })).toBe(false);
    });

    it.each(["ENGINE_BUSY", "ENGINE_TIMEOUT", "INFERENCE_ERROR", "VALIDATION_ERROR", "POLICY_DISABLED"])(
      "is false when the cause is on %s: the cause only counts on INFERENCE_UNAVAILABLE",
      (code) => {
        expect(isNotReady({ ...unavailable, code })).toBe(false);
      },
    );
  });

  describe("describeFailure", () => {
    it("says the engine is starting up, and keeps the backend's message, code and request ID", () => {
      const { fields, form } = describeFailure(unavailable);
      expect(form.title).toBe("The routing engine is starting up");
      expect(form.messages).toEqual(["The inference service is unavailable."]);
      expect(form.code).toBe("INFERENCE_UNAVAILABLE");
      expect(form.requestId).toBe("req-9");
      expect(fields).toEqual({});
    });

    it("leaves an ordinary INFERENCE_UNAVAILABLE as a routing failure", () => {
      const { form } = describeFailure({ ...unavailable, details: { transactionId: "t-1" } });
      expect(form.title).toBe("Routing failed");
      expect(form.title).not.toMatch(/starting up/i);
    });

    it.each([
      ["ENGINE_BUSY", 503],
      ["ENGINE_TIMEOUT", 504],
      ["INFERENCE_ERROR", 502],
    ] as const)("leaves %s as a routing failure, even with a stray cause", (code, status) => {
      const { form } = describeFailure({ ...unavailable, code, status });
      expect(form.title).toBe("Routing failed");
    });

    it("does not change how a validation error is worded", () => {
      const { form } = describeFailure({
        status: 422,
        code: "VALIDATION_ERROR",
        message: "Request failed validation.",
        details: { cause: "NOT_READY" },
        requestId: "r",
      });
      expect(form.title).toBe("The request failed validation");
    });
  });

  it("adds nothing about retrying or waiting: no Retry-After is modelled", () => {
    const { form } = describeFailure(unavailable);
    expect(JSON.stringify(form)).not.toMatch(/retry|seconds|wait/i);
    expect(JSON.stringify(unavailable)).not.toMatch(/retry/i);
  });
});
