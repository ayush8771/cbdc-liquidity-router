/*
 * GET /api/v1/network (contract §2.3, §3.1) for the desktop Network page. The
 * body becomes the display model the page already renders (types.ts). The two
 * have the same field names, so this is a copy with a check in front: nothing
 * is converted. In particular `feePct` stays a fraction (0.015, never 1.5), and
 * an unknown `dataSourceTag` is kept as written.
 */
import { ApiError, INVALID_RESPONSE, type ApiClient } from "../../api/client";
import { isApiNetwork, type ApiNetwork } from "../../api/types";
import type { DataSourceTag } from "../transactions/detailTypes";
import type { NetworkView } from "./types";

export function mapNetwork(network: ApiNetwork): NetworkView {
  return {
    corridors: network.corridors.map((corridor) => ({
      corridor: corridor.corridor,
      senderCountry: corridor.senderCountry,
      receiverCountry: corridor.receiverCountry,
      venues: corridor.venues.map((venue) => ({
        slot: venue.slot,
        bridgeUid: venue.bridgeUid,
        feePct: venue.feePct,
        baselineCapacityUsd: venue.baselineCapacityUsd,
        // Passed through as it came; dataSourceName() prints an unknown tag as written.
        dataSourceTag: venue.dataSourceTag as DataSourceTag,
      })),
    })),
    maxSingleTransferUsd: network.maxSingleTransferUsd,
    maxSingleTransferProvenance: network.maxSingleTransferProvenance,
  };
}

/** One request. A body that isn't the documented shape is an INVALID_RESPONSE error. */
export async function fetchNetwork(api: ApiClient): Promise<NetworkView> {
  const raw = await api.get<unknown>("/network");
  if (!isApiNetwork(raw)) {
    throw new ApiError({ status: 200, code: INVALID_RESPONSE, message: "The server's response could not be read." });
  }
  return mapNetwork(raw);
}

export type NetworkErrorView = {
  message: string;
  /** The request ID, for the user to quote. */
  reference: string | undefined;
  /** Whether asking again can help. */
  canRetry: boolean;
};

/**
 * What to tell the user. The wording is this UI's own, chosen by `code`,
 * `status` and `details.cause`, never by the backend's `message`. The endpoint
 * reads the inference service's cached reference data, so its failures are the
 * inference ones (contract §4): unavailable, still starting up, timed out, or
 * an invalid answer.
 */
export function describeNetworkError(error: unknown): NetworkErrorView {
  if (!(error instanceof ApiError)) {
    return { message: "Something went wrong while loading the network.", reference: undefined, canRetry: true };
  }
  const reference = error.requestId ?? undefined;
  const view = (message: string, canRetry = true): NetworkErrorView => ({ message, reference, canRetry });

  if (error.code === "NETWORK_ERROR") return view("The server could not be reached. Check your connection, then try again.");
  if (error.code === INVALID_RESPONSE) return view("The server sent a response this page couldn't read.");
  if (error.code === "INFERENCE_UNAVAILABLE") {
    return error.details.cause === "NOT_READY"
      ? view("The routing engine is starting up, so the network isn't available yet. Try again in a moment.")
      : view("The routing engine is unavailable, so the network can't be loaded. Try again in a moment.");
  }
  if (error.code === "ENGINE_BUSY") return view("The routing engine is busy. Try again in a moment.");
  if (error.code === "ENGINE_TIMEOUT") return view("The routing engine did not answer in time. Try again.");
  if (error.status === 403) return view("You don't have access to the network.", false);
  if (error.status >= 500) return view("The server hit an unexpected error. Try again in a moment.");
  return view(`The request failed (${error.code}).`);
}
