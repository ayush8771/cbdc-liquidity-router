// Engine (snake_case) to Application (camelCase) key mapping (API contract
// §1; arch §5.2: field for field, never computing anything).
//
// - Only object keys change, recursively, including objects inside arrays.
//   Values are never changed: "historical_replay" or "2011-01-01" stay as they
//   are. Mapping enum values is left to endpoint-specific mappers.
// - Unknown fields are kept and mapped like any other.
// - An underscore run followed by a letter or digit, after the first
//   character, becomes that character in upper case: gap_buffer_days ->
//   gapBufferDays, daily_state_sha256 -> dailyStateSha256. Leading and
//   trailing underscores are kept; camelCase keys are unchanged.
// - Two keys of one object that map to the same name (a_b and aB) throw
//   KeyCollisionError rather than silently dropping one.
// - The input is never mutated. Objects are built with Object.fromEntries, so
//   a "__proto__" key stays an ordinary property.

export class KeyCollisionError extends Error {
  constructor() {
    // The key names come from the inference response, so they aren't included.
    super("Two keys of one object map to the same camelCase name");
    this.name = "KeyCollisionError";
  }
}

export function camelCaseKey(key: string): string {
  return key.replace(/(?<=[A-Za-z0-9])_+([A-Za-z0-9])/g, (_match, next: string) => next.toUpperCase());
}

export function toCamelCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCamelCase);
  if (typeof value !== "object" || value === null) return value;
  const entries: Array<[string, unknown]> = [];
  const seen = new Set<string>();
  for (const [key, child] of Object.entries(value)) {
    const mapped = camelCaseKey(key);
    if (seen.has(mapped)) throw new KeyCollisionError();
    seen.add(mapped);
    entries.push([mapped, toCamelCase(child)]);
  }
  return Object.fromEntries(entries);
}
