import { render as renderUi, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataModeContext } from "../src/api/dataMode";
import { ILLUSTRATIVE_CORRIDORS, ILLUSTRATIVE_LOCATIONS } from "../src/features/globe/illustrativeData";
import { BridgeMonitorPage } from "../src/pages/BridgeMonitorPage";

// The real Globe imports three, which needs WebGL. The mock records the props
// the page passes, and renders nothing else.
const globeRenders = vi.fn();
vi.mock("../src/features/globe/Globe", () => ({
  Globe: (props: {
    locations: unknown[];
    connections: unknown[];
    paused: boolean;
    reducedMotion?: boolean;
    label: string;
  }) => {
    globeRenders(props);
    return (
      <div
        data-testid="globe"
        data-paused={String(props.paused)}
        data-reduced-motion={String(Boolean(props.reducedMotion))}
        data-locations={props.locations.length}
        data-connections={props.connections.length}
        role="img"
        aria-label={props.label}
      />
    );
  },
}));

// These tests are about the preview page (no data, no requests), so it renders in preview mode, where it
// needs no session and no router. The live page is tested in bridgeMonitorLive.test.tsx.
const render = (ui: ReactElement) => renderUi(<DataModeContext.Provider value="preview">{ui}</DataModeContext.Provider>);

type Environment = { width: number; reducedMotion: boolean };
const original = window.matchMedia;

/** A matchMedia that answers the two queries the page uses. */
function mockMatchMedia({ width, reducedMotion }: Environment) {
  const matches = (query: string) => {
    if (query === "(min-width: 1024px)") return width >= 1024;
    if (query === "(prefers-reduced-motion: reduce)") return reducedMotion;
    return false;
  };
  const impl = (query: string) =>
    ({
      matches: matches(query),
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

const pauseButton = () => screen.getByRole("button", { name: /rotation/i });

beforeEach(() => {
  globeRenders.mockClear();
});

afterEach(() => {
  window.matchMedia = original;
});

describe("BridgeMonitorPage at 1024px and above", () => {
  it.each([1024, 1280, 1920])("shows the globe at %ipx", (width) => {
    mockMatchMedia({ width, reducedMotion: false });
    render(<BridgeMonitorPage />);
    expect(screen.getByTestId("globe")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Bridge monitor" })).toBeInTheDocument();
  });

  it("asks for the desktop breakpoint, 1024px", () => {
    mockMatchMedia({ width: 1280, reducedMotion: false });
    render(<BridgeMonitorPage />);
    expect(window.matchMedia).toHaveBeenCalledWith("(min-width: 1024px)");
  });

  it("gives the globe the six illustrative locations and three corridors", () => {
    mockMatchMedia({ width: 1280, reducedMotion: false });
    render(<BridgeMonitorPage />);
    const props = globeRenders.mock.calls[0]![0];
    expect(props.locations).toBe(ILLUSTRATIVE_LOCATIONS);
    expect(props.connections).toBe(ILLUSTRATIVE_CORRIDORS);
    expect(screen.getByTestId("globe")).toHaveAttribute("data-locations", "6");
    expect(screen.getByTestId("globe")).toHaveAttribute("data-connections", "3");
  });

  it("gives the globe a text alternative that says it is illustrative", () => {
    mockMatchMedia({ width: 1280, reducedMotion: false });
    render(<BridgeMonitorPage />);
    expect(screen.getByRole("img", { name: /Illustrative only/ })).toBe(screen.getByTestId("globe"));
  });

  it("labels the globe as illustrative, not live availability", () => {
    mockMatchMedia({ width: 1280, reducedMotion: false });
    render(<BridgeMonitorPage />);
    expect(screen.getByText("Illustrative — not live bridge availability.")).toBeInTheDocument();
    expect(screen.getByText(/They show no liquidity, availability or status/)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Corridors shown" }).querySelectorAll("li")).toHaveLength(3);
  });

  it("says the data is not connected yet", () => {
    mockMatchMedia({ width: 1280, reducedMotion: false });
    render(<BridgeMonitorPage />);
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("The monitor's data isn't connected yet")).toBeInTheDocument();
    expect(screen.getByText("Simulated")).toBeInTheDocument();
  });

  it("starts in motion and toggles the globe's paused prop with the button", async () => {
    mockMatchMedia({ width: 1280, reducedMotion: false });
    render(<BridgeMonitorPage />);
    const globe = screen.getByTestId("globe");
    expect(globe).toHaveAttribute("data-paused", "false");
    expect(pauseButton()).toHaveTextContent("Pause rotation");

    await userEvent.click(pauseButton());
    expect(globe).toHaveAttribute("data-paused", "true");
    expect(pauseButton()).toHaveTextContent("Resume rotation");
    expect(screen.getByText("Globe motion paused")).toBeInTheDocument();

    await userEvent.click(pauseButton());
    expect(globe).toHaveAttribute("data-paused", "false");
    expect(screen.getByText("Globe motion running")).toBeInTheDocument();
  });

  it("has one h1", () => {
    mockMatchMedia({ width: 1280, reducedMotion: false });
    render(<BridgeMonitorPage />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });
});

describe("BridgeMonitorPage reduced motion", () => {
  it("starts paused, tells the globe to skip its introduction, and lets the user resume", async () => {
    mockMatchMedia({ width: 1280, reducedMotion: true });
    render(<BridgeMonitorPage />);
    const globe = screen.getByTestId("globe");
    expect(globe).toHaveAttribute("data-paused", "true");
    expect(globe).toHaveAttribute("data-reduced-motion", "true");
    expect(pauseButton()).toHaveTextContent("Resume rotation");

    await userEvent.click(pauseButton());
    expect(globe).toHaveAttribute("data-paused", "false");
    expect(pauseButton()).toHaveTextContent("Pause rotation");
  });

  it("does not set reducedMotion when the user has no such preference", () => {
    mockMatchMedia({ width: 1280, reducedMotion: false });
    render(<BridgeMonitorPage />);
    expect(screen.getByTestId("globe")).toHaveAttribute("data-reduced-motion", "false");
  });
});

describe("BridgeMonitorPage below 1024px", () => {
  it.each([1023, 768, 375])("shows the pending screen and no globe at %ipx", (width) => {
    mockMatchMedia({ width, reducedMotion: false });
    render(<BridgeMonitorPage />);
    expect(screen.queryByTestId("globe")).not.toBeInTheDocument();
    expect(globeRenders).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1, name: "Bridge monitor" })).toBeInTheDocument();
    expect(screen.getByText("This screen isn't connected yet")).toBeInTheDocument();
  });

  it("shows the endpoint the screen will use, and none of the globe's text or controls", () => {
    mockMatchMedia({ width: 1023, reducedMotion: false });
    render(<BridgeMonitorPage />);
    expect(screen.getByRole("list", { name: "Endpoints" })).toHaveTextContent("/api/v1/state");
    expect(screen.queryByRole("button", { name: /rotation/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Illustrative — not live bridge availability/)).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Corridors shown" })).not.toBeInTheDocument();
  });

  it("keeps the same labels as the desktop page", () => {
    mockMatchMedia({ width: 1023, reducedMotion: false });
    render(<BridgeMonitorPage />);
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("Simulated")).toBeInTheDocument();
  });

  it("does not render the globe even with reduced motion on", () => {
    mockMatchMedia({ width: 800, reducedMotion: true });
    render(<BridgeMonitorPage />);
    expect(screen.queryByTestId("globe")).not.toBeInTheDocument();
  });
});

describe("BridgeMonitorPage without matchMedia (as in jsdom)", () => {
  it("falls back to the pending screen", () => {
    // @ts-expect-error: simulate an environment with no matchMedia
    window.matchMedia = undefined;
    render(<BridgeMonitorPage />);
    expect(screen.queryByTestId("globe")).not.toBeInTheDocument();
    expect(screen.getByText("This screen isn't connected yet")).toBeInTheDocument();
  });
});
