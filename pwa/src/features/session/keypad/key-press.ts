export const REPEAT_DELAY_MS = 380;
export const REPEAT_EVERY_MS = 90;

type KeyPressOptions = {
  repeat?: boolean;
  release?: (cancelled: boolean) => void;
};

export type PadPressBinding = { stop: () => void; destroy: () => void };

/** One physical press owns its repeats and release; clicks only add keyboard/AT activation. */
export function bindPadPress(
  element: HTMLElement,
  press: () => void,
  options: KeyPressOptions = {},
): PadPressBinding {
  const doc = element.ownerDocument;
  const view = doc.defaultView!;
  let pointer: number | null = null;
  let timer: number | null = null;

  const disabled = () => element.matches(":disabled, [aria-disabled='true']");
  const finish = (cancelled: boolean) => {
    if (timer !== null) view.clearTimeout(timer);
    timer = null;
    element.classList.remove("is-pressed");
    doc.removeEventListener("pointerup", end, true);
    doc.removeEventListener("pointercancel", cancel, true);
    doc.removeEventListener("visibilitychange", visibility);
    view.removeEventListener("blur", stop);
    if (pointer === null) return;
    pointer = null;
    options.release?.(cancelled);
  };
  const stop = () => finish(true);
  const end = (event: PointerEvent) => {
    if (event.pointerId === pointer) finish(!element.isConnected || disabled());
  };
  const cancel = (event: PointerEvent) => {
    if (event.pointerId === pointer) stop();
  };
  const visibility = () => {
    if (doc.hidden) stop();
  };
  const repeat = () => {
    if (!element.isConnected || disabled() || doc.hidden) {
      stop();
      return;
    }
    press();
    if (pointer !== null) timer = view.setTimeout(repeat, REPEAT_EVERY_MS);
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || disabled()) return;
    // Keep the current textarea, selection and mobile keyboard in place.
    event.preventDefault();
    if (pointer !== null) return;
    pointer = event.pointerId;
    element.classList.add("is-pressed");
    doc.addEventListener("pointerup", end, true);
    doc.addEventListener("pointercancel", cancel, true);
    doc.addEventListener("visibilitychange", visibility);
    view.addEventListener("blur", stop);
    press();
    if (options.repeat && pointer !== null) timer = view.setTimeout(repeat, REPEAT_DELAY_MS + REPEAT_EVERY_MS);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return;
    const rect = element.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom) stop();
  };
  const onClick = (event: MouseEvent) => {
    // Pointer-generated clicks belong to the already delivered pointerdown,
    // including PointerEvents whose detail is zero. No time-based debounce:
    // separate rapid taps and keyboard/assistive activation remain independent.
    if (pointer !== null || event.detail !== 0 || ("pointerType" in event && event.pointerType) || disabled()) return;
    event.preventDefault();
    press();
    options.release?.(false);
  };

  element.addEventListener("pointerdown", onPointerDown);
  for (const type of ["pointerleave", "lostpointercapture"] as const) {
    element.addEventListener(type, cancel);
  }
  // Touch implicitly captures pointers, so leaving the hit area may not emit pointerleave.
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("click", onClick);
  return {
    stop,
    destroy() {
      stop();
      element.removeEventListener("pointerdown", onPointerDown);
      for (const type of ["pointerleave", "lostpointercapture"] as const) {
        element.removeEventListener(type, cancel);
      }
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("click", onClick);
    },
  };
}
