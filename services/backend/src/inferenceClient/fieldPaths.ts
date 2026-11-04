// Engine request paths -> Application API request paths (API contract §4,
// owner decision): an explicit table, not a generic camelCase conversion.
//
// The table is the inverse of mappers/routeRequest.ts, field for field: the
// engine's `transaction` object is flattened to top-level app fields, and
// state keys become camelCase. Venue and history indexes are kept, because
// the backend sends venues in the order received (§2.11: venue sorting is for
// hashing only).
//
// A path the table can't map returns undefined, and the caller drops it, so
// the item becomes a form-level error with no field. A raw engine path never
// reaches the app. Examples that are dropped: "transaction" (the corridor as
// a whole has no single app field), "state.venues[0].risk" (no such field),
// and anything malformed.

/** An array index as the engine writes it: a whole number, no leading zeros. */
const INDEX = "(0|[1-9][0-9]{0,8})";

const TABLE: ReadonlyArray<readonly [RegExp, (m: RegExpExecArray) => string]> = [
  [/^transaction\.sender_country$/, () => "senderCountry"],
  [/^transaction\.receiver_country$/, () => "receiverCountry"],
  [/^transaction\.amount_usd$/, () => "amountUsd"],
  [/^transaction\.client_reference$/, () => "clientReference"],
  [/^policy$/, () => "policy"],
  [/^state$/, () => "state"],
  [/^state\.mode$/, () => "state.mode"],
  [/^state\.date$/, () => "state.date"],
  [/^state\.scenario_id$/, () => "state.scenarioId"],
  [/^state\.reference_date$/, () => "state.referenceDate"],
  [/^state\.venues$/, () => "state.venues"],
  [new RegExp(`^state\\.venues\\[${INDEX}\\]$`), (m) => `state.venues[${m[1]}]`],
  [new RegExp(`^state\\.venues\\[${INDEX}\\]\\.bridge_uid$`), (m) => `state.venues[${m[1]}].bridgeUid`],
  [new RegExp(`^state\\.venues\\[${INDEX}\\]\\.liquidity_usd$`), (m) => `state.venues[${m[1]}].liquidityUsd`],
  [new RegExp(`^state\\.venues\\[${INDEX}\\]\\.congestion$`), (m) => `state.venues[${m[1]}].congestion`],
  [new RegExp(`^state\\.venues\\[${INDEX}\\]\\.history$`), (m) => `state.venues[${m[1]}].history`],
  [
    new RegExp(`^state\\.venues\\[${INDEX}\\]\\.history\\.liquidity_usd(?:\\[${INDEX}\\])?$`),
    (m) => `state.venues[${m[1]}].history.liquidityUsd${m[2] === undefined ? "" : `[${m[2]}]`}`,
  ],
  [
    new RegExp(`^state\\.venues\\[${INDEX}\\]\\.history\\.congestion(?:\\[${INDEX}\\])?$`),
    (m) => `state.venues[${m[1]}].history.congestion${m[2] === undefined ? "" : `[${m[2]}]`}`,
  ],
];

/** The app path for an engine path, or undefined when the table has none. */
export function mapEngineFieldPath(path: unknown): string | undefined {
  if (typeof path !== "string" || path.length > 200) return undefined;
  for (const [pattern, toApp] of TABLE) {
    const match = pattern.exec(path);
    if (match !== null) return toApp(match);
  }
  return undefined;
}
