import { record } from "./environment";
import { readDesktopObservation, type DesktopRPC } from "../src/lib/protocol/remote-desktop";

const origin = "http://127.0.0.1:18846";

let desktopOverride: (() => DesktopRPC) | null = null;

/** Allow QA unit tests without the Go loopback peer to supply a deterministic DesktopRPC. */
export function setFixtureDesktopOverride(factory: (() => DesktopRPC) | null): void {
  desktopOverride = factory;
}

// QA blocks application fetches. This dedicated loopback peer sends a generated H.264 test card.
function request(path: string, data: unknown): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", origin + path);
    xhr.timeout = 12000;
    xhr.responseType = "json";
    xhr.onload = () => {
      if (xhr.status === 200 && xhr.response) resolve(xhr.response);
      else reject(new Error("Desktop QA peer rejected the request"));
    };
    xhr.ontimeout = xhr.onerror = () => reject(new Error("Start the local desktop peer described in pwa/qa/README.md"));
    xhr.send(JSON.stringify(data));
  });
}

export function fixtureDesktop(): DesktopRPC {
  if (desktopOverride) {
    const inner = desktopOverride();
    return {
      async open(sdp, control, audio, quality) {
        record("mutation", "DesktopOpen", [control, audio, quality]);
        return inner.open(sdp, control, audio, quality);
      },
      async ping(observe = false, keyframe = false) {
        const result = await inner.ping(observe, keyframe);
        if (observe && result) record("read", "DesktopPing", [observe, keyframe, result]);
        return result;
      },
      async input(event) {
        record("mutation", "DesktopInput", [event]);
        return inner.input(event);
      },
      async close() {
        record("mutation", "DesktopClose");
        return inner.close();
      },
    };
  }
  // Exercise the production input queue across delayed acknowledgements.
  const ackDelay = Math.min(500, Math.max(0, Number(new URLSearchParams(location.search).get("desktopAckMs")) || 0));
  const mode = new URLSearchParams(location.search).get("desktopFrames");
  const observation = mode === "idle" || mode === "recover" || mode === "freeze";
  let id = "", closed = false;
  const closePeer = () => request("/close?id=" + encodeURIComponent(id), {});
  return {
    async open(sdp, control, audio, quality) {
      record("mutation", "DesktopOpen", [control, audio, quality]);
      const result = await request("/open" + (observation ? "?mode=" + mode : ""), { sdp, control, audio, quality });
      id = result.id;
      if (closed) { await closePeer(); throw new Error("Closed"); }
      return { sdp: result.sdp, display: result.display };
    },
    async ping(observe = false, keyframe = false) {
      if (closed) throw new Error("Closed");
      if (!observation) return;
      const result = await request("/ping?id=" + encodeURIComponent(id), { observe, keyframe });
      record("read", "DesktopPing", [observe, keyframe, result]);
      return readDesktopObservation(result);
    },
    async input(event) {
      record("mutation", "DesktopInput", [event]);
      if (ackDelay) await new Promise(resolve => setTimeout(resolve, ackDelay));
    },
    async close() {
      record("mutation", "DesktopClose"); closed = true;
      if (id) await closePeer();
    },
  };
}
