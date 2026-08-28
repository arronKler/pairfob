export const DAEMON_ID_RE = /^d_[0-9a-f]{20}$/;
export const DEVICE_ID_RE = /^dev_[A-Za-z0-9_-]{8,128}$/;

export function validDaemonId(value: unknown): value is string {
  return typeof value === "string" && DAEMON_ID_RE.test(value);
}

export function validDeviceId(value: unknown): value is string {
  return typeof value === "string" && DEVICE_ID_RE.test(value);
}
