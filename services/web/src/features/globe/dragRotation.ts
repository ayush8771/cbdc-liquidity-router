/*
 * Pointer-drag rotation for the globe. Deliberately free of `three`: it turns
 * pointer movement into rotation deltas (radians) and leaves applying them to
 * the caller, so the logic can be tested without WebGL.
 *
 * Mouse and pen only. Touch is ignored so a finger still scrolls the page, and
 * no wheel listener is added. There is no inertia: the globe stops following
 * the moment the pointer is released.
 */

/** Vertical tilt limits, in radians (-8° to +74°), applied to the globe's x rotation. */
export const TILT_MIN = (-8 * Math.PI) / 180;
export const TILT_MAX = (74 * Math.PI) / 180;

/**
 * The globe's on-screen radius is a bit under 40% of the smaller canvas side, so
 * dragging by that many pixels turns the surface under the pointer by about one
 * radian and the globe feels grabbed rather than slid.
 */
const SURFACE_PER_MIN_SIDE = 2.6;

export const clampTilt = (tilt: number) => Math.min(TILT_MAX, Math.max(TILT_MIN, tilt));

/** Radians of rotation per pixel of drag; 0 when the canvas has no usable size. */
export function dragSensitivity(width: number, height: number): number {
  const side = Math.min(width, height);
  return Number.isFinite(side) && side > 0 ? SURFACE_PER_MIN_SIDE / side : 0;
}

/**
 * A pointer movement as rotation. Dragging right turns the near side right
 * (positive yaw); dragging down tips the top toward the viewer (positive pitch).
 */
export function dragDelta(dx: number, dy: number, sensitivity: number) {
  return { dYaw: dx * sensitivity, dPitch: dy * sensitivity };
}

export type DragRotationOptions = {
  /** Current size of the canvas in CSS pixels, read on every move so resizes count. */
  getSize: () => { width: number; height: number };
  /** Called for each movement with the rotation to add. */
  onRotate: (dYaw: number, dPitch: number) => void;
  onStart?: () => void;
  /** Called once when a drag ends for any reason: release, cancel or lost capture. */
  onEnd?: () => void;
};

export type DragRotation = {
  readonly dragging: boolean;
  /** Ends any drag in progress and removes every listener. Safe to call twice. */
  detach: () => void;
};

export function attachDragRotation(target: HTMLElement, options: DragRotationOptions): DragRotation {
  let activeId: number | null = null;
  let lastX = 0;
  let lastY = 0;
  let detached = false;

  function end() {
    if (activeId === null) return;
    const id = activeId;
    activeId = null;
    try {
      if (target.hasPointerCapture?.(id)) target.releasePointerCapture(id);
    } catch {
      // The pointer is already gone; nothing to release.
    }
    target.style.cursor = "grab";
    options.onEnd?.();
  }

  function onDown(event: PointerEvent) {
    if (detached || activeId !== null) return;
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") return; // touch scrolls the page
    if (event.button !== 0) return; // primary button or pen contact only
    if (event.isPrimary === false) return;
    const { width, height } = options.getSize();
    if (dragSensitivity(width, height) === 0) return;

    activeId = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    try {
      target.setPointerCapture?.(event.pointerId);
    } catch {
      // Capture is a convenience; the drag still works inside the canvas.
    }
    event.preventDefault(); // no text selection or native image drag while rotating
    target.style.cursor = "grabbing";
    options.onStart?.();
  }

  function onMove(event: PointerEvent) {
    if (event.pointerId !== activeId) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    const { width, height } = options.getSize();
    const sensitivity = dragSensitivity(width, height);
    if (sensitivity === 0 || (dx === 0 && dy === 0)) return;
    const { dYaw, dPitch } = dragDelta(dx, dy, sensitivity);
    options.onRotate(dYaw, dPitch);
  }

  function onUp(event: PointerEvent) {
    if (event.pointerId === activeId) end();
  }

  function onLostCapture(event: PointerEvent) {
    if (event.pointerId === activeId) end();
  }

  target.style.cursor = "grab";
  target.addEventListener("pointerdown", onDown);
  target.addEventListener("pointermove", onMove);
  target.addEventListener("pointerup", onUp);
  target.addEventListener("pointercancel", onUp);
  target.addEventListener("lostpointercapture", onLostCapture);

  return {
    get dragging() {
      return activeId !== null;
    },
    detach() {
      if (detached) return;
      end();
      detached = true;
      target.removeEventListener("pointerdown", onDown);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      target.removeEventListener("lostpointercapture", onLostCapture);
      target.style.cursor = "";
    },
  };
}
