import { describe, expect, it } from "vitest";
import { angleBetween, arcPeak, arcPoints, latLonToVec3, slerp, type Vec3 } from "../src/features/globe/geo";

const length = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const expectVec = (actual: Vec3, expected: Vec3) => {
  expect(actual[0]).toBeCloseTo(expected[0], 9);
  expect(actual[1]).toBeCloseTo(expected[1], 9);
  expect(actual[2]).toBeCloseTo(expected[2], 9);
};

describe("latLonToVec3", () => {
  // Convention from geo.ts: longitude 0 is +x, 90°E is -z, 90°W is +z, north pole is +y.
  it("maps the axis points to the documented orientation", () => {
    expectVec(latLonToVec3(0, 0), [1, 0, 0]);
    expectVec(latLonToVec3(0, 90), [0, 0, -1]);
    expectVec(latLonToVec3(0, -90), [0, 0, 1]);
    expectVec(latLonToVec3(0, 180), [-1, 0, 0]);
    expectVec(latLonToVec3(90, 0), [0, 1, 0]);
    expectVec(latLonToVec3(-90, 0), [0, -1, 0]);
  });

  it("puts the poles at the same point whatever the longitude", () => {
    expectVec(latLonToVec3(90, 123), [0, 1, 0]);
    expectVec(latLonToVec3(-90, -47), [0, -1, 0]);
  });

  it("treats -180 and 180 degrees of longitude as the same meridian", () => {
    expectVec(latLonToVec3(25, -180), latLonToVec3(25, 180));
  });

  it("scales by the radius and defaults to a unit sphere", () => {
    expect(length(latLonToVec3(38.9, -77.04))).toBeCloseTo(1, 12);
    expect(length(latLonToVec3(38.9, -77.04, 2.5))).toBeCloseTo(2.5, 12);
    expectVec(latLonToVec3(0, 0, 3), [3, 0, 0]);
    expectVec(latLonToVec3(0, 0, 0), [0, 0, 0]);
  });

  it("stays on the sphere for every project location", () => {
    const places: Array<[number, number]> = [
      [38.9, -77.04], // Washington, D.C.
      [28.61, 77.21], // New Delhi
      [51.51, -0.13], // London
      [14.6, 120.98], // Manila
      [24.45, 54.38], // Abu Dhabi
      [19.43, -99.13], // Mexico City
    ];
    for (const [lat, lon] of places) expect(length(latLonToVec3(lat, lon))).toBeCloseTo(1, 12);
  });

  it("puts western longitudes on +z and eastern ones on -z, northern latitudes above the equator", () => {
    const washington = latLonToVec3(38.9, -77.04);
    const delhi = latLonToVec3(28.61, 77.21);
    expect(washington[2]).toBeGreaterThan(0);
    expect(delhi[2]).toBeLessThan(0);
    expect(washington[1]).toBeGreaterThan(0);
    expect(delhi[1]).toBeGreaterThan(0);
  });
});

describe("slerp", () => {
  const x: Vec3 = [1, 0, 0];
  const y: Vec3 = [0, 1, 0];

  it("returns the endpoints at t = 0 and t = 1", () => {
    expectVec(slerp(x, y, 0), x);
    expectVec(slerp(x, y, 1), y);
  });

  it("returns the great-circle midpoint at t = 0.5", () => {
    expectVec(slerp(x, y, 0.5), [Math.SQRT1_2, Math.SQRT1_2, 0]);
  });

  it("stays on the unit sphere for every t", () => {
    const a = latLonToVec3(38.9, -77.04);
    const b = latLonToVec3(28.61, 77.21);
    for (let t = 0; t <= 1; t += 0.1) expect(length(slerp(a, b, t))).toBeCloseTo(1, 9);
  });

  it("moves at a constant angular speed", () => {
    const a = latLonToVec3(51.51, -0.13);
    const b = latLonToVec3(14.6, 120.98);
    const total = angleBetween(a, b);
    for (const t of [0.1, 0.25, 0.5, 0.9]) {
      expect(angleBetween(a, slerp(a, b, t))).toBeCloseTo(t * total, 9);
    }
  });

  it("returns the first point when the two points are the same", () => {
    const a = latLonToVec3(10, 20);
    expectVec(slerp(a, a, 0.5), a);
  });

  // Characterises the current behaviour, not an endorsement of it: for antipodal
  // points every great circle is equally valid and sin(theta) is ~0, so the
  // function falls back to its first argument for every t.
  it("falls back to the first point for antipodal points", () => {
    const a: Vec3 = [1, 0, 0];
    const b: Vec3 = [-1, 0, 0];
    expectVec(slerp(a, b, 0.5), a);
    expectVec(slerp(a, b, 1), a);
  });
});

describe("arcPeak", () => {
  it("is 0.06 for a zero-length route", () => {
    expect(arcPeak(0)).toBeCloseTo(0.06, 12);
  });

  it("grows linearly with the angle between the endpoints", () => {
    expect(arcPeak(Math.PI / 2)).toBeCloseTo(0.16, 12);
    expect(arcPeak(Math.PI / 4)).toBeCloseTo(0.11, 12);
  });

  it("is 0.26 for antipodal endpoints", () => {
    expect(arcPeak(Math.PI)).toBeCloseTo(0.26, 12);
  });

  it("clamps to the 0.06 to 0.26 range for out-of-range angles", () => {
    expect(arcPeak(-1)).toBe(0.06);
    expect(arcPeak(-Math.PI)).toBe(0.06);
    expect(arcPeak(2 * Math.PI)).toBe(0.26);
    expect(arcPeak(100)).toBe(0.26);
  });

  it("never decreases as the angle increases", () => {
    let previous = arcPeak(0);
    for (let angle = 0.1; angle <= Math.PI; angle += 0.1) {
      const current = arcPeak(angle);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});

describe("arcPoints", () => {
  const usa: [number, number] = [38.9, -77.04];
  const ind: [number, number] = [28.61, 77.21];
  const radius = (p: Vec3) => length(p);

  it("returns segments + 1 points, 97 by default", () => {
    expect(arcPoints(usa, ind)).toHaveLength(97);
    expect(arcPoints(usa, ind, 10)).toHaveLength(11);
    expect(arcPoints(usa, ind, 1)).toHaveLength(2);
  });

  it("starts and ends just above the surface, on the two locations", () => {
    const points = arcPoints(usa, ind);
    const first = points[0]!;
    const last = points[points.length - 1]!;
    expectVec(first, latLonToVec3(usa[0], usa[1], 1.004));
    expectVec(last, latLonToVec3(ind[0], ind[1], 1.004));
  });

  it("peaks halfway at the ground radius plus arcPeak", () => {
    const points = arcPoints(usa, ind, 96);
    const angle = angleBetween(latLonToVec3(usa[0], usa[1]), latLonToVec3(ind[0], ind[1]));
    expect(radius(points[48]!)).toBeCloseTo(1.004 + arcPeak(angle), 9);
  });

  it("never dips below the ground radius, so it never cuts through the globe", () => {
    for (const p of arcPoints(usa, ind)) expect(radius(p)).toBeGreaterThanOrEqual(1.004 - 1e-9);
  });

  it("rises to the middle and falls symmetrically", () => {
    const points = arcPoints(usa, ind, 20);
    for (let i = 0; i <= 10; i += 1) {
      expect(radius(points[i]!)).toBeCloseTo(radius(points[20 - i]!), 9);
    }
    expect(radius(points[10]!)).toBeGreaterThan(radius(points[5]!));
    expect(radius(points[5]!)).toBeGreaterThan(radius(points[0]!));
  });

  it("follows the great circle: every point lies at a constant angular step", () => {
    const points = arcPoints(usa, ind, 8);
    const unit = points.map((p) => [p[0] / radius(p), p[1] / radius(p), p[2] / radius(p)] as Vec3);
    const step = angleBetween(unit[0]!, unit[1]!);
    for (let i = 1; i < unit.length; i += 1) expect(angleBetween(unit[i - 1]!, unit[i]!)).toBeCloseTo(step, 9);
  });

  it("honours a custom ground radius", () => {
    const points = arcPoints(usa, ind, 10, 1.02);
    expect(radius(points[0]!)).toBeCloseTo(1.02, 9);
    expect(radius(points[10]!)).toBeCloseTo(1.02, 9);
  });

  it("is direction-reversible: the reverse route has the same points in reverse order", () => {
    const forward = arcPoints(usa, ind, 12);
    const backward = arcPoints(ind, usa, 12).reverse();
    forward.forEach((p, i) => expectVec(p, backward[i]!));
  });

  it("produces only finite numbers for identical endpoints, rising and falling in place", () => {
    const points = arcPoints(usa, usa, 10);
    for (const p of points) for (const c of p) expect(Number.isFinite(c)).toBe(true);
    expect(radius(points[0]!)).toBeCloseTo(1.004, 9);
    // 6 places, not 9: acos of a dot product that rounds just above 1 gives an angle of ~1e-8, not 0.
    expect(radius(points[5]!)).toBeCloseTo(1.004 + 0.06, 6);
  });

  it("produces only finite numbers for antipodal endpoints", () => {
    const points = arcPoints([0, 0], [0, 180], 10);
    for (const p of points) for (const c of p) expect(Number.isFinite(c)).toBe(true);
  });
});
