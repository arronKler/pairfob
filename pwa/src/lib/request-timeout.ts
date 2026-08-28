import { ProtocolError } from "./protocol/errors.ts";

export const HTTP_REQUEST_TIMEOUT_MS = 12_000;

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Give small control-plane requests a real deadline while preserving a caller's
 * cancellation signal. AbortSignal.any is deliberately avoided for older iOS.
 */
export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = options.signal;
  if (callerSignal?.aborted) throw callerSignal.reason ?? new DOMException("Aborted", "AbortError");

  let timedOut = false;
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? HTTP_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchImpl(input, { ...init, signal: controller.signal });
    if (timedOut) throw new ProtocolError("timeout", "网络请求超时");
    return response;
  } catch (error) {
    if (timedOut) throw new ProtocolError("timeout", "网络请求超时");
    throw error;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}
