import { t } from "../../lib/i18n";
import type { ConnectStage } from "./model";

/**
 * A miniature of what `pairfob pair` prints on the computer right now: the
 * offer (QR + code), the waiting line, the "Press Enter to pair" chip once the
 * phone reaches approval. It only shows lines the CLI
 * really prints (`internal/pairingqr`, `cmd/pairfob/pair.go`); the QR is a
 * fixed decorative pattern and the code is masked so nobody types a fake one.
 */

const MODULES = 25;

/** A deterministic, unscannable QR-like pattern with the three finder squares. */
function qrPath(): string {
  const cells: boolean[][] = [];
  let seed = 11;
  const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let y = 0; y < MODULES; y++) {
    cells.push([]);
    for (let x = 0; x < MODULES; x++) cells[y].push(next() > 0.53);
  }
  const finder = (ox: number, oy: number) => {
    for (let y = -1; y < 8; y++) {
      for (let x = -1; x < 8; x++) {
        const cx = ox + x;
        const cy = oy + y;
        if (cx < 0 || cy < 0 || cx >= MODULES || cy >= MODULES) continue;
        const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        cells[cy][cx] = ring !== 2 && ring !== 4;
      }
    }
  };
  finder(0, 0);
  finder(MODULES - 7, 0);
  finder(0, MODULES - 7);
  let d = "";
  cells.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x} ${y}h1v1h-1z`; }));
  return d;
}

const QR_PATH = qrPath();

export function TerminalMiniature({ stage }: { stage: ConnectStage }) {
  const quiet = stage === "connecting" || stage === "approve";
  return <div className="term-mini" aria-hidden="true">
    <div className={`term-mini-window${quiet ? " is-quiet" : ""}`}>
      <div className="term-mini-bar"><span>{t("connect.termLabel")}</span></div>
      <div className="term-mini-body">
        <p><span className="term-mini-prompt">~ %</span> pairfob pair</p>
        <p className="term-mini-dim">Scan from the other device:</p>
        <div className="term-mini-qr">
          <svg viewBox={`-1 -1 ${MODULES + 2} ${MODULES + 2}`} shapeRendering="crispEdges"><path d={QR_PATH} /></svg>
          <i className="term-mini-corner is-tl" /><i className="term-mini-corner is-tr" />
          <i className="term-mini-corner is-bl" /><i className="term-mini-corner is-br" />
          <i className="term-mini-sweep" />
        </div>
        <p className="term-mini-dim">Can't scan? Type this pairing code: <span className="term-mini-mask"><i /><i /><i /></span></p>
        <div className="term-mini-tail">
          {stage === "approve" ? <>
            <p className="term-mini-dim">Waiting to pair…</p>
            <p><span className="term-mini-enter">{"  Press Enter to pair  "}</span></p>
          </> : <p className="term-mini-dim">Waiting to pair…<span className="term-mini-caret" /></p>}
        </div>
      </div>
    </div>
  </div>;
}
