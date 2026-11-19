/*
 * Reads the shared contract fixtures (contracts/fixtures/app/) straight from
 * disk, never copied. The path is built from plain strings on purpose: Vite
 * would treat `new URL("<literal>", import.meta.url)` as an asset import.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ContractFixture = { response: { status: number; body: unknown } };

export function contractFixture(path: string): ContractFixture {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(resolve(here, "../../../../contracts/fixtures/app", path), "utf8")) as ContractFixture;
}

/** The file names (e.g. "200_get_routed.json") in a fixture folder such as "transactions". */
export function contractFixtureNames(dir: string): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return readdirSync(resolve(here, "../../../../contracts/fixtures/app", dir)).filter((name) => name.endsWith(".json"));
}
