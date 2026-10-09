import { Laptop, Smartphone, Tablet } from "lucide-react";

export type DeviceKind = "phone" | "tablet" | "computer";

/**
 * What this browser runs on, for the mark beside "this device": a phone, a
 * tablet or a computer browser are all paired devices, and a phone glyph on a
 * laptop reads as somebody else's device.
 *
 * iPadOS presents a Mac user agent by default; a Mac has no touch points.
 */
export function deviceKind(userAgent: string, maxTouchPoints: number): DeviceKind {
  if (/iPad/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1)) return "tablet";
  if (/iPhone|iPod/i.test(userAgent)) return "phone";
  if (/Android/i.test(userAgent)) return /Mobile/i.test(userAgent) ? "phone" : "tablet";
  return "computer";
}

/** A laptop, not a monitor: the monitor already marks the computer being controlled. */
export function ThisDeviceIcon({ size }: { size: number }) {
  const kind = deviceKind(navigator.userAgent, navigator.maxTouchPoints || 0);
  const Icon = kind === "phone" ? Smartphone : kind === "tablet" ? Tablet : Laptop;
  return <Icon size={size} aria-hidden="true" />;
}
