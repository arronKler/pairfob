import { useLayoutEffect, useRef, type ButtonHTMLAttributes } from "react";
import { composeIME } from "./compose-store";

/** Keep pad presses from moving focus away from an active IME composition or selection. */
export function preventComposeBlur(event: Event): void {
  event.preventDefault();
}

export function preventComposeBlurUnlessIME(event: Event): void {
  if (!composeIME()) event.preventDefault();
}

/** Pad chrome that must not steal compose focus; native so non-bubbling presses count. */
export function PadChromeButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener("pointerdown", preventComposeBlur);
    return () => el.removeEventListener("pointerdown", preventComposeBlur);
  }, []);
  return <button {...props} ref={ref} />;
}

export function usePointerDown(listener: (event: Event) => void) {
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener("pointerdown", listener);
    return () => el.removeEventListener("pointerdown", listener);
  }, [listener]);
  return ref;
}
