import { useEffect, useState } from "react";
import { t } from "../../lib/i18n";
import type { DesktopConnection } from "./connection";
import type { DesktopMetricSample } from "./desktop-metrics";

export function DesktopStatistics({ connection }: { connection: DesktopConnection }) {
  const [open, setOpen] = useState(false);
  const [sample, setSample] = useState<DesktopMetricSample | null>(null);
  useEffect(() => {
    setSample(null);
    if (!open) return;
    let cancelled = false, timer = 0;
    async function refresh() {
      try {
        const value = await connection.statistics();
        if (!cancelled) setSample(value);
      } catch {
        if (!cancelled) setSample(null);
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void refresh(), 1000);
      }
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, connection]);

  const fields: string[] = [];
  const timings: string[] = [];
  if (sample) {
    if (sample.width && sample.height) fields.push(sample.width + "×" + sample.height);
    if (sample.protocol) fields.push("P2P " + sample.protocol.toUpperCase());
    if (sample.fps !== undefined) fields.push(Math.round(sample.fps) + " fps");
    if (sample.rttMS !== undefined) fields.push(t("desktop.rtt") + " " + Math.round(sample.rttMS) + " ms");
    if (sample.dropped !== undefined) fields.push(t("desktop.dropped") + " " + sample.dropped);
    if (sample.receivedMbps !== undefined) fields.push(t("desktop.rate") + " " + sample.receivedMbps.toFixed(2) + " Mbps");
    const stages = [
      [t("desktop.encoding"), sample.encodeMS], [t("desktop.buffer"), sample.jitterBufferMS],
      [t("desktop.decoding"), sample.decodeMS], [t("desktop.presentation"), sample.compositorMS],
    ] as const;
    for (const [label, duration] of stages) {
      timings.push(label + " " + (duration === undefined ? "—" : duration.toFixed(1) + " ms"));
    }
  }
  return <details onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>{t("desktop.stats")}</summary>
    {open && <><p>{fields.join(" · ") || t("desktop.statsPending")}</p>
      {sample && <p>{timings.join(" · ")}</p>}</>}
  </details>;
}
