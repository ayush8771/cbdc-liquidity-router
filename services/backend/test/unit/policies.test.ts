import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import express from "express";
import { authorizePolicies, canUseExperimentalPolicies } from "../../src/auth/policies.js";
import type { Role } from "../../src/config/devTokens.js";
import { ApiError, errorHandler } from "../../src/middleware/errors.js";
import { requestId } from "../../src/middleware/requestId.js";
import { captureLogger, startServer } from "../helpers/server.js";

const analyst = { role: "analyst" as Role };
const viewer = { role: "viewer" as Role };

function forbidden(fn: () => void): ApiError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ApiError);
    return error;
  }
  assert.fail("expected a 403 ApiError");
}

describe("canUseExperimentalPolicies", () => {
  it("is true for analysts and false for viewers", () => {
    assert.equal(canUseExperimentalPolicies("analyst"), true);
    assert.equal(canUseExperimentalPolicies("viewer"), false);
  });
});

describe("authorizePolicies", () => {
  for (const policies of [[], ["waterfall"], ["ppoProjected"], ["waterfall", "cheapestFeasible", "ppoProjected"]]) {
    it(`allows an analyst to request ${JSON.stringify(policies)}`, () => {
      assert.doesNotThrow(() => authorizePolicies(analyst, policies));
    });
  }

  for (const policies of [[], ["waterfall"], ["cheapestFeasible"], ["waterfall", "cheapestFeasible"]]) {
    it(`allows a viewer to request ${JSON.stringify(policies)}`, () => {
      assert.doesNotThrow(() => authorizePolicies(viewer, policies));
    });
  }

  for (const policies of [["ppoProjected"], ["waterfall", "ppoProjected"], ["ppoProjected", "ppoProjected"]]) {
    it(`denies a viewer ${JSON.stringify(policies)} with 403 FORBIDDEN_POLICY`, () => {
      const error = forbidden(() => authorizePolicies(viewer, policies));
      assert.equal(error.status, 403);
      assert.equal(error.code, "FORBIDDEN_POLICY");
      assert.equal(error.message, "Only analysts may request ppoProjected.");
      assert.deepEqual(error.details, {});
    });
  }

  it("matches the Application API name only (engine names are not app input)", () => {
    assert.doesNotThrow(() => authorizePolicies(viewer, ["ppo_projected"]));
  });
});

describe("authorizePolicies inside a route", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  before(async () => {
    const app = express();
    app.use(requestId);
    app.get("/check/:role", (req, res) => {
      authorizePolicies({ role: req.params.role as Role }, ["waterfall", "ppoProjected"]);
      res.json({ ok: true });
    });
    app.use(errorHandler(captureLogger().logger));
    server = await startServer(app);
  });
  after(() => server.close());

  it("produces the 403 FORBIDDEN_POLICY envelope for a viewer", async () => {
    const res = await fetch(`${server.baseUrl}/check/viewer`, { headers: { "X-Request-Id": "pol-1" } });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), {
      error: {
        code: "FORBIDDEN_POLICY",
        message: "Only analysts may request ppoProjected.",
        details: {},
        requestId: "pol-1",
      },
    });
  });

  it("lets an analyst through", async () => {
    const res = await fetch(`${server.baseUrl}/check/analyst`);
    assert.equal(res.status, 200);
  });
});
