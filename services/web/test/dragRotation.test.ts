import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  TILT_MAX,
  TILT_MIN,
  attachDragRotation,
  clampTilt,
  dragDelta,
  dragSensitivity,
  type DragRotation,
} from "../src/features/globe/dragRotation";

type Init = { pointerId?: number; pointerType?: string; button?: number; isPrimary?: boolean; clientX?: number; clientY?: number };

/** jsdom has no PointerEvent; a plain Event with the fields the module reads is enough. */
function pointer(type: string, init: Init = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & Required<Init>;
  Object.assign(event, { pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true, clientX: 0, clientY: 0, ...init });
  return event;
}

describe("drag maths", () => {
  it("scales with the smaller canvas side and is 0 for unusable sizes", () => {
    expect(dragSensitivity(600, 600)).toBeCloseTo(2.6 / 600);
    expect(dragSensitivity(1200, 600)).toBeCloseTo(dragSensitivity(600, 600));
    expect(dragSensitivity(300, 600)).toBeCloseTo(2 * dragSensitivity(600, 600));
    expect(dragSensitivity(0, 600)).toBe(0);
    expect(dragSensitivity(600, 0)).toBe(0);
    expect(dragSensitivity(Number.NaN, 600)).toBe(0);
  });

  it("maps right and down to positive yaw and pitch, left and up to negative, scaled linearly", () => {
    expect(dragDelta(10, 0, 0.01)).toEqual({ dYaw: 0.1, dPitch: 0 });
    expect(dragDelta(-10, 0, 0.01).dYaw).toBeCloseTo(-0.1);
    expect(dragDelta(0, 20, 0.01).dPitch).toBeCloseTo(0.2);
    expect(dragDelta(0, -20, 0.01).dPitch).toBeCloseTo(-0.2);
    expect(dragDelta(20, 0, 0.01).dYaw).toBeCloseTo(2 * dragDelta(10, 0, 0.01).dYaw);
  });

  it("clamps the tilt to -8Â° .. +74Â°", () => {
    expect(TILT_MIN).toBeCloseTo((-8 * Math.PI) / 180);
    expect(TILT_MAX).toBeCloseTo((74 * Math.PI) / 180);
    expect(clampTilt(-5)).toBe(TILT_MIN);
    expect(clampTilt(5)).toBe(TILT_MAX);
    expect(clampTilt(0.42)).toBe(0.42);
  });
});

describe("attachDragRotation", () => {
  let el: HTMLElement;
  let size: { width: number; height: number };
  let rotate: Mock<(dYaw: number, dPitch: number) => void>;
  let start: Mock<() => void>;
  let end: Mock<() => void>;
  let captured: Set<number>;
  let drag: DragRotation;

  beforeEach(() => {
    el = document.createElement("div");
    document.body.appendChild(el);
    size = { width: 600, height: 600 };
    rotate = vi.fn<(dYaw: number, dPitch: number) => void>();
    start = vi.fn<() => void>();
    end = vi.fn<() => void>();
    captured = new Set();
    el.setPointerCapture = vi.fn((id: number) => void captured.add(id));
    el.hasPointerCapture = vi.fn((id: number) => captured.has(id));
    el.releasePointerCapture = vi.fn((id: number) => void captured.delete(id));
    drag = attachDragRotation(el, { getSize: () => size, onRotate: rotate, onStart: start, onEnd: end });
  });

  afterEach(() => {
    drag.detach();
    el.remove();
  });

  const s = 2.6 / 600;

  it("rotates horizontally and vertically in the right directions", () => {
    el.dispatchEvent(pointer("pointerdown", { clientX: 100, clientY: 100 }));
    el.dispatchEvent(pointer("pointermove", { clientX: 160, clientY: 100 }));
    expect(rotate).toHaveBeenLastCalledWith(expect.closeTo(60 * s, 10), 0);
    el.dispatchEvent(pointer("pointermove", { clientX: 130, clientY: 100 })); // back left
    expect(rotate.mock.calls.at(-1)![0]).toBeCloseTo(-30 * s, 10);
    el.dispatchEvent(pointer("pointermove", { clientX: 130, clientY: 150 })); // down
    expect(rotate.mock.calls.at(-1)![1]).toBeCloseTo(50 * s, 10);
    el.dispatchEvent(pointer("pointermove", { clientX: 130, clientY: 120 })); // up
    expect(rotate.mock.calls.at(-1)![1]).toBeCloseTo(-30 * s, 10);
  });

  it("recalculates sensitivity when the canvas is resized", () => {
    el.dispatchEvent(pointer("pointerdown"));
    size = { width: 300, height: 300 };
    el.dispatchEvent(pointer("pointermove", { clientX: 10 }));
    expect(rotate.mock.calls[0]![0]).toBeCloseTo(10 * (2.6 / 300), 10);
  });

  it("runs start, move, release in order and stops after release", () => {
    el.dispatchEvent(pointer("pointerdown", { clientX: 5 }));
    expect(start).toHaveBeenCalledTimes(1);
    expect(drag.dragging).toBe(true);
    expect(el.setPointerCapture).toHaveBeenCalledWith(1);
    el.dispatchEvent(pointer("pointermove", { clientX: 15 }));
    el.dispatchEvent(pointer("pointerup", { clientX: 15 }));
    expect(end).toHaveBeenCalledTimes(1);
    expect(drag.dragging).toBe(false);
    expect(el.releasePointerCapture).toHaveBeenCalledWith(1);
    el.dispatchEvent(pointer("pointermove", { clientX: 400 }));
    expect(rotate).toHaveBeenCalledTimes(1); // no inertia, no movement without a drag
  });

  it("ends the drag on pointercancel", () => {
    el.dispatchEvent(pointer("pointerdown"));
    el.dispatchEvent(pointer("pointercancel"));
    expect(end).toHaveBeenCalledTimes(1);
    expect(drag.dragging).toBe(false);
  });

  it("ends the drag exactly once on lostpointercapture, including after a release", () => {
    el.dispatchEvent(pointer("pointerdown"));
    captured.clear();
    el.dispatchEvent(pointer("lostpointercapture"));
    expect(end).toHaveBeenCalledTimes(1);

    el.dispatchEvent(pointer("pointerdown"));
    el.dispatchEvent(pointer("pointerup")); // releasing capture also fires lostpointercapture in a browser
    el.dispatchEvent(pointer("lostpointercapture"));
    expect(end).toHaveBeenCalledTimes(2);
  });

  it("keeps following a drag that leaves the canvas, and ends on release outside", () => {
    el.dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10 }));
    el.dispatchEvent(pointer("pointermove", { clientX: 5000, clientY: -300 })); // far outside the element
    expect(rotate).toHaveBeenCalledTimes(1);
    el.dispatchEvent(pointer("pointerup", { clientX: 5000, clientY: -300 }));
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("ignores touch, non-primary buttons and secondary pointers", () => {
    el.dispatchEvent(pointer("pointerdown", { pointerType: "touch" }));
    el.dispatchEvent(pointer("pointerdown", { button: 1 }));
    el.dispatchEvent(pointer("pointerdown", { button: 2 }));
    el.dispatchEvent(pointer("pointerdown", { isPrimary: false }));
    expect(start).not.toHaveBeenCalled();
    expect(drag.dragging).toBe(false);
    el.dispatchEvent(pointer("pointermove", { clientX: 50 }));
    expect(rotate).not.toHaveBeenCalled();
  });

  it("accepts a pen", () => {
    el.dispatchEvent(pointer("pointerdown", { pointerType: "pen" }));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("ignores events from other pointers during a drag, and a second down", () => {
    el.dispatchEvent(pointer("pointerdown", { pointerId: 1 }));
    el.dispatchEvent(pointer("pointerdown", { pointerId: 2 }));
    el.dispatchEvent(pointer("pointermove", { pointerId: 2, clientX: 40 }));
    el.dispatchEvent(pointer("pointerup", { pointerId: 2 }));
    expect(start).toHaveBeenCalledTimes(1);
    expect(rotate).not.toHaveBeenCalled();
    expect(drag.dragging).toBe(true);
  });

  it("prevents the default on a drag start so nothing gets selected", () => {
    const down = pointer("pointerdown");
    el.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    const touch = pointer("pointerdown", { pointerType: "touch", pointerId: 9 });
    el.dispatchEvent(touch);
    expect(touch.defaultPrevented).toBe(false);
  });

  it("does not start, and does not rotate, on a zero-size canvas", () => {
    size = { width: 0, height: 0 };
    el.dispatchEvent(pointer("pointerdown"));
    expect(start).not.toHaveBeenCalled();
    expect(drag.dragging).toBe(false);

    size = { width: 600, height: 600 };
    el.dispatchEvent(pointer("pointerdown"));
    size = { width: 0, height: 0 }; // collapsed mid-drag
    el.dispatchEvent(pointer("pointermove", { clientX: 30 }));
    expect(rotate).not.toHaveBeenCalled();
  });

  it("works when pointer capture is unsupported or throws", () => {
    drag.detach();
    const bare = document.createElement("div");
    const onRotate = vi.fn<(dYaw: number, dPitch: number) => void>();
    const onStart = vi.fn<() => void>();
    const bareDrag = attachDragRotation(bare, { getSize: () => size, onRotate, onStart });
    bare.dispatchEvent(pointer("pointerdown"));
    bare.dispatchEvent(pointer("pointermove", { clientX: 20 }));
    expect(onStart).toHaveBeenCalled();
    expect(onRotate).toHaveBeenCalledTimes(1);
    bare.dispatchEvent(pointer("pointerup"));

    const throwing = document.createElement("div");
    throwing.setPointerCapture = () => {
      throw new Error("InvalidPointerId");
    };
    const throwingDrag = attachDragRotation(throwing, { getSize: () => size, onRotate, onStart });
    expect(() => throwing.dispatchEvent(pointer("pointerdown"))).not.toThrow();
    bareDrag.detach();
    throwingDrag.detach();
  });

  it("removes every listener on detach, ending a drag in progress", () => {
    el.dispatchEvent(pointer("pointerdown"));
    drag.detach();
    expect(end).toHaveBeenCalledTimes(1);
    expect(el.style.cursor).toBe("");
    el.dispatchEvent(pointer("pointerdown"));
    el.dispatchEvent(pointer("pointermove", { clientX: 50 }));
    expect(start).toHaveBeenCalledTimes(1);
    expect(rotate).not.toHaveBeenCalled();
    expect(() => drag.detach()).not.toThrow();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("registers and removes the same five listeners", () => {
    const add = vi.spyOn(HTMLElement.prototype, "addEventListener");
    const remove = vi.spyOn(HTMLElement.prototype, "removeEventListener");
    const other = document.createElement("div");
    const d = attachDragRotation(other, { getSize: () => size, onRotate: rotate });
    d.detach();
    const added = add.mock.calls.map((c) => c[0]).sort();
    const removed = remove.mock.calls.map((c) => c[0]).sort();
    expect(added).toEqual(["lostpointercapture", "pointercancel", "pointerdown", "pointermove", "pointerup"]);
    expect(removed).toEqual(added);
    expect(added).not.toContain("wheel");
    add.mockRestore();
    remove.mockRestore();
  });
});
