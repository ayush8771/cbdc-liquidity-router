// Pure geometry for the globe. No `three` import, so it is cheap to test and
// can never pull the 3D library into the main bundle.

export type Vec3 = [number, number, number];

const RAD = Math.PI / 180;

/**
 * A latitude/longitude as a point on a sphere, in the orientation of three's
 * SphereGeometry with an equirectangular texture: longitude 0 is +x, 90°E is
 * -z, 90°W is +z and the north pole is +y.
 */
export function latLonToVec3(lat: number, lon: number, radius = 1): Vec3 {
  const la = lat * RAD;
  const lo = lon * RAD;
  return [radius * Math.cos(la) * Math.cos(lo), radius * Math.sin(la), -radius * Math.cos(la) * Math.sin(lo)];
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The angle between two unit vectors, in radians. */
export function angleBetween(a: Vec3, b: Vec3): number {
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b))));
}

/** Spherical interpolation between two unit vectors (the great-circle path). */
export function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const theta = angleBetween(a, b);
  const s = Math.sin(theta);
  if (s < 1e-6) return a;
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return [wa * a[0] + wb * b[0], wa * a[1] + wb * b[1], wa * a[2] + wb * b[2]];
}

/** How high an arc rises above the surface: longer routes rise more, within limits. */
export function arcPeak(angle: number): number {
  return Math.min(0.26, Math.max(0.06, 0.06 + 0.2 * (angle / Math.PI)));
}

/**
 * Points along a raised great-circle arc between two [lat, lon] locations.
 * The arc starts and ends just above the surface (`ground`) and rises to its
 * peak halfway, so it meets the markers and never cuts through the globe.
 */
export function arcPoints(from: [number, number], to: [number, number], segments = 96, ground = 1.004): Vec3[] {
  const a = latLonToVec3(from[0], from[1]);
  const b = latLonToVec3(to[0], to[1]);
  const peak = arcPeak(angleBetween(a, b));
  const points: Vec3[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const p = slerp(a, b, t);
    const r = ground + peak * Math.sin(Math.PI * t);
    points.push([p[0] * r, p[1] * r, p[2] * r]);
  }
  return points;
}
