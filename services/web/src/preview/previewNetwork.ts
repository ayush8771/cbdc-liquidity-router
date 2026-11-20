/*
 * PREVIEW DATA — the Network page's view of the network, built from the
 * reference data the New Transaction preview already holds, so there is one
 * source and no second copy to disagree with it. Illustrative, not from the
 * API, and not used once integration starts: replace `PREVIEW_NETWORK` with the
 * result of GET /api/v1/network, mapped to `NetworkView`, and delete this file
 * together with ./previewReference.ts.
 *
 * Nothing here is copied or changed: values are read from the other file, and
 * new objects are built, so the source values are never mutated. The slot is
 * the venue's position, because the source lists venues in slot order.
 */
import type { NetworkView } from "../features/network/types";
import { PREVIEW_ENGINE_MODEL, PREVIEW_REFERENCE } from "./previewReference";

export const PREVIEW_NETWORK: NetworkView = {
  corridors: PREVIEW_REFERENCE.corridors.map((corridor) => ({
    corridor: corridor.corridor,
    senderCountry: corridor.senderCountry,
    receiverCountry: corridor.receiverCountry,
    venues: corridor.venues.map((venue, slot) => {
      const baselineCapacityUsd = PREVIEW_ENGINE_MODEL.baselineCapacityUsd[venue.bridgeUid];
      if (baselineCapacityUsd === undefined) {
        // A gap in the preview data must be loud, not filled with an invented number.
        throw new Error(`The preview data has no baseline capacity for ${venue.bridgeUid}.`);
      }
      return {
        slot,
        bridgeUid: venue.bridgeUid,
        feePct: venue.feePct,
        baselineCapacityUsd,
        dataSourceTag: venue.dataSourceTag,
      };
    }),
  })),
  maxSingleTransferUsd: PREVIEW_REFERENCE.maxSingleTransferUsd,
  // The provenance the contract's network fixture carries for this limit.
  maxSingleTransferProvenance: "project_assumption",
};
