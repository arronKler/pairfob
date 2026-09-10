import type { ComponentPropsWithRef } from "react";

/**
 * The one button element. It only fixes the default `type`, so a button inside a
 * form never submits by accident; every caller keeps full native props and refs.
 */
export function Button({ type = "button", ...props }: ComponentPropsWithRef<"button">) {
  return <button type={type} {...props} />;
}
