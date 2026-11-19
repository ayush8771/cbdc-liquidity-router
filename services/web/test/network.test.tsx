import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatUsd } from "../src/lib/format";
import { PREVIEW_NETWORK } from "../src/preview/previewNetwork";
import { renderRoute } from "./renderRoute";

const original = window.matchMedia;

function mockWidth(width: number) {
  const impl = (query: string) =>
    ({
      matches: query === "(min-width: 1024px)" ? width >= 1024 : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
  window.matchMedia = vi.fn(impl) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  window.matchMedia = original;
});

const PREVIEW_NOTICE = "Preview data — illustrative, not from the API";
const corridorCard = (name: string) => screen.getByRole("region", { name: `Corridor ${name}` });
const allVenues = PREVIEW_NETWORK.corridors.flatMap((c) => c.venues);

describe("NetworkPage at 1024px and above", () => {
  it.each([1024, 1280, 1440])("shows the network at %ipx", (width) => {
    mockWidth(width);
    renderRoute("/network");
    expect(screen.getByRole("heading", { level: 1, name: "Network" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.queryByText("This screen isn't connected yet")).not.toBeInTheDocument();
    expect(screen.getAllByRole("table")).toHaveLength(PREVIEW_NETWORK.corridors.length);
  });

  it("labels the page as preview data", () => {
    mockWidth(1280);
    renderRoute("/network");
    expect(screen.getByText(PREVIEW_NOTICE)).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
  });

  it("explains that baseline capacity is reference data, and links to the Bridge monitor", () => {
    mockWidth(1280);
    renderRoute("/network");
    expect(screen.getByText("Baseline capacity is reference data")).toBeInTheDocument();
    expect(screen.getByText(/static reference metadata/)).toBeInTheDocument();
    expect(screen.getByText(/not live liquidity or current availability/)).toBeInTheDocument();
    expect(screen.getByText(/dynamic liquidity of the state/)).toBeInTheDocument();
    // Scoped to the page content: the sidebar has its own Bridge monitor links.
    expect(within(screen.getByRole("main")).getByRole("link", { name: "Bridge monitor" })).toHaveAttribute("href", "/bridges");
  });

  it("shows the single-transfer limit with its provenance as a project assumption", () => {
    mockWidth(1280);
    renderRoute("/network");
    const card = screen.getByRole("region", { name: "Single-transfer limit" });
    expect(card).toHaveTextContent(formatUsd(500000));
    expect(card).toHaveTextContent("Provenance: Project assumption");
    expect(card).toHaveTextContent("not a real regulation");
  });

  it("shows one card per corridor, with the countries and venue count", () => {
    mockWidth(1280);
    renderRoute("/network");
    for (const corridor of PREVIEW_NETWORK.corridors) {
      const name = corridor.corridor.replace("->", " → ");
      const card = corridorCard(name);
      expect(within(card).getByRole("heading", { name })).toBeInTheDocument();
      expect(card).toHaveTextContent(`${corridor.senderCountry} to ${corridor.receiverCountry}`);
      expect(card).toHaveTextContent(`${corridor.venues.length} venues`);
    }
  });

  it("gives each venue table the five columns, and no liquidity, congestion or status column", () => {
    mockWidth(1280);
    renderRoute("/network");
    for (const table of screen.getAllByRole("table")) {
      const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
      expect(headers).toEqual(["Venue", "Slot", "Fee", "Baseline capacity", "Data source"]);
    }
    expect(screen.queryByRole("columnheader", { name: /congestion|liquidity|status|health|available/i })).not.toBeInTheDocument();
  });

  it("lists every venue with its slot, fee as a percentage, baseline capacity and data source", () => {
    mockWidth(1280);
    renderRoute("/network");
    const gbr = within(corridorCard("GBR → PHL"));
    const rows = gbr.getAllByRole("row").slice(1); // without the header
    expect(rows).toHaveLength(3);

    // GBR->PHL#0 in the preview data: fee 0.019, baseline capacity 450,000, a real static bridge.
    const first = within(rows[0]!);
    expect(first.getByText("GBR->PHL#0")).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent("1.90%");
    expect(rows[0]).toHaveTextContent("$450,000");
    expect(rows[0]).toHaveTextContent("Real static bridge");
    // GBR->PHL#1: fee 0.013 shows as 1.30%.
    expect(rows[1]).toHaveTextContent("1.30%");
    expect(rows[1]).toHaveTextContent("Synthetic expansion");
  });

  it("shows each fee as a percentage and never as the raw fraction", () => {
    mockWidth(1280);
    renderRoute("/network");
    for (const table of screen.getAllByRole("table")) {
      for (const row of within(table).getAllByRole("row").slice(1)) {
        const feeCell = within(row).getAllByRole("cell")[2]!; // Venue, Slot, Fee, ...
        // "1.90%" or "0.80%", always two decimals and a percent sign, never a raw fraction like "0.019".
        expect(feeCell.textContent).toMatch(/^\d\.\d{2}%$/);
      }
    }
  });

  it("uses the approved data-source labels, and the mandatory Synthetic venue label on synthetic expansion venues", () => {
    mockWidth(1280);
    renderRoute("/network");
    const count = (tag: string) => allVenues.filter((v) => v.dataSourceTag === tag).length;
    expect(screen.getAllByText("Real static bridge")).toHaveLength(count("real_static_bridge"));
    expect(screen.getAllByText("Synthetic expansion")).toHaveLength(count("synthetic_bridge_expansion"));
    expect(screen.getAllByText("Synthetic — no real anchor")).toHaveLength(count("synthetic_no_real_anchor"));
    expect(screen.getAllByText("Synthetic venue")).toHaveLength(count("synthetic_bridge_expansion"));
  });

  it("shows no congestion, live liquidity, health or availability indicator", () => {
    mockWidth(1280);
    renderRoute("/network");
    const main = screen.getByRole("main");
    expect(within(main).queryByText(/congestion/i, { selector: "th, td, dt, dd" })).not.toBeInTheDocument();
    expect(within(main).queryByText(/healthy|degraded|online|offline|operational/i)).not.toBeInTheDocument();
    expect(within(main).queryByRole("progressbar")).not.toBeInTheDocument();
    // The one status pill is the page-level "Not connected", not a venue status.
    expect(within(main).getAllByText("Not connected")).toHaveLength(1);
  });

  it("does not change the preview reference data", () => {
    mockWidth(1280);
    const before = JSON.stringify(PREVIEW_NETWORK);
    renderRoute("/network");
    expect(JSON.stringify(PREVIEW_NETWORK)).toBe(before);
  });
});

describe("NetworkPage states at 1024px and above", () => {
  it("shows the loading state", () => {
    mockWidth(1280);
    renderRoute("/network?state=loading");
    expect(screen.getByRole("status")).toHaveTextContent("Loading the network");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows the empty state", () => {
    mockWidth(1280);
    renderRoute("/network?state=empty");
    expect(screen.getByText("No corridors")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows the error state and recovers with Try again", async () => {
    mockWidth(1280);
    renderRoute("/network?state=error");
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load the network");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getAllByRole("table")).toHaveLength(3);
  });

  it("keeps the preview notice and the baseline explanation in every state", () => {
    mockWidth(1280);
    renderRoute("/network?state=error");
    expect(screen.getByText(PREVIEW_NOTICE)).toBeInTheDocument();
    expect(screen.getByText("Baseline capacity is reference data")).toBeInTheDocument();
  });
});

describe("NetworkPage below 1024px", () => {
  it.each([1023, 768, 375])("keeps the existing placeholder at %ipx", (width) => {
    mockWidth(width);
    renderRoute("/network");
    expect(screen.getByRole("heading", { level: 1, name: "Network" })).toBeInTheDocument();
    expect(screen.getByText("This screen isn't connected yet")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Endpoints" })).toHaveTextContent("GET /api/v1/network");
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText(PREVIEW_NOTICE)).not.toBeInTheDocument();
    expect(screen.queryByText("Baseline capacity is reference data")).not.toBeInTheDocument();
  });
});
