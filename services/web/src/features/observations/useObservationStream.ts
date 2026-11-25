import { useEffect, useState, useSyncExternalStore } from "react";
import { useObservationSession } from "../../auth/observationSession";
import { createObservationController, type ObservationController } from "./observationController";
import type { ObservationState } from "./types";

/**
 * The observation stream for one mounted panel. The state lives in its own controller and is read
 * through `useSyncExternalStore`, so it is never put in a context that routing or transaction
 * screens read (AD-6 B-8). The stream opens when the panel mounts and is aborted, with every
 * listener removed, when it unmounts. React StrictMode's mount, unmount, mount leaves one stream.
 */
export function useObservationStream(): { state: ObservationState; controller: ObservationController } {
  const { openObservationStream } = useObservationSession();
  // shortcut: the controller keeps the `openObservationStream` it was created with. AuthProvider keeps that
  // function stable for the session's store and fetch, so it never goes stale; revisit if either becomes dynamic.
  const [controller] = useState(() => createObservationController({ open: openObservationStream }));
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);

  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return { state, controller };
}
