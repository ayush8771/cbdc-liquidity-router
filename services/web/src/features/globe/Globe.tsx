import { useEffect, useRef, useState } from "react";
import { Notice } from "../../components/ui/Notice";
import { cx } from "../../lib/cx";
import type { GlobeScene } from "./createGlobeScene";
import type { GlobeConnection, GlobeLocation } from "./types";

type GlobeStatus = "loading" | "ready" | "unavailable";

type GlobeProps = {
  locations: GlobeLocation[];
  connections: GlobeConnection[];
  /** Stops all motion (rotation, arcs, signals) while true. */
  paused: boolean;
  /** Skip the introduction animation. Read once, when the globe is created. */
  reducedMotion?: boolean;
  /** Text alternative for assistive technology. */
  label: string;
  /** Equirectangular Earth textures; default to the files in public/textures. */
  lightsUrl?: string;
  landUrl?: string;
  /** Sizes the globe. It fills whatever box this gives it. */
  className?: string;
};

const BASE = import.meta.env.BASE_URL;
const INTRO_MS = 1800;

/**
 * A rotating 3D globe with markers, glowing arcs and travelling signals.
 *
 * The 3D code is loaded on demand (a separate chunk), the canvas is created
 * and removed by this component so every mount gets a fresh WebGL context, and
 * everything is released on unmount. If WebGL isn't available the globe is
 * replaced by a short notice and the rest of the page is unaffected.
 *
 * It displays only what it is given: places and the links between them.
 */
export function Globe({
  locations,
  connections,
  paused,
  reducedMotion = false,
  label,
  lightsUrl = `${BASE}textures/earth-lights.jpg`,
  landUrl = `${BASE}textures/earth-land.png`,
  className,
}: GlobeProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<GlobeScene | null>(null);
  const pausedRef = useRef(paused);
  const reducedMotionRef = useRef(reducedMotion);
  const [status, setStatus] = useState<GlobeStatus>("loading");

  useEffect(() => {
    pausedRef.current = paused;
    sceneRef.current?.setPaused(paused);
  }, [paused]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    let scene: GlobeScene | null = null;

    // A fresh canvas per mount: a canvas whose WebGL context was released
    // cannot be reused, which matters when React mounts, unmounts and remounts.
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText = "display:block;width:100%;height:100%";
    host.appendChild(canvas);

    (async () => {
      try {
        const { createGlobeScene } = await import("./createGlobeScene");
        if (cancelled) return;
        const created = await createGlobeScene({
          canvas,
          container: host,
          locations,
          connections,
          lightsUrl,
          landUrl,
          introMs: reducedMotionRef.current ? 0 : INTRO_MS,
          paused: pausedRef.current,
          onContextLost: () => {
            if (!cancelled) setStatus("unavailable");
          },
        });
        if (cancelled) {
          created.dispose();
          return;
        }
        scene = created;
        sceneRef.current = created;
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("unavailable");
      }
    })();

    return () => {
      cancelled = true;
      scene?.dispose();
      sceneRef.current = null;
      canvas.remove();
    };
  }, [locations, connections, lightsUrl, landUrl]);

  return (
    <div className={cx("relative", className)}>
      <div ref={hostRef} role="img" aria-label={label} className="absolute inset-0" />

      {status === "loading" ? (
        <div role="status" className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="sr-only">Loading the globe</span>
          <span aria-hidden="true" className="h-3/5 w-3/5 animate-pulse rounded-full border border-line-subtle" />
        </div>
      ) : null}

      {status === "unavailable" ? (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <div className="max-w-sm">
            <Notice tone="info" role="status" title="The globe can't be shown">
              Your browser or device doesn&apos;t support the 3D graphics it needs, or they are turned off. Nothing else on
              this page is affected.
            </Notice>
          </div>
        </div>
      ) : null}
    </div>
  );
}
