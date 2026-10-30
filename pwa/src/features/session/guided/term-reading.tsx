import { t } from "../../../lib/i18n";
import { useComputers } from "../../computers/hooks";
import { useNetworkOnline } from "../../connection/hooks";

/** Enough rows to reach the fade in the tallest pane; a shorter one hides the rest. */
const READING_ROWS = 56;

/**
 * A pane whose screen has not been read yet.
 *
 * The terminal is the destination the reader just chose, so its arrival is
 * drawn as the screen it will hold — rows of output at the terminal's own
 * rhythm — instead of an empty buffer on the terminal's ground, which reads as
 * a black screen for as long as the round trip takes. Same language as the
 * workspace placeholders: bars in the text colour, one sheen across them.
 *
 * With the computer out of reach (no network, or the session dropped) no read
 * is on its way at all, so the rows stand still and the pane says why: a sheen
 * there would promise a screen that cannot arrive. Polling resumes by itself
 * when the connection returns, and this hands back to the moving rows.
 */
export function TermReading() {
  const networkOnline = useNetworkOnline();
  const { live } = useComputers();
  const reading = networkOnline && live?.isConnected() === true;
  return (
    <div
      className={reading ? "term-reading" : "term-reading is-still"}
      role="status"
      aria-live="polite"
      aria-busy={reading ? "true" : "false"}
      aria-label={reading ? t("term.readingScreen") : t("term.waitingComputer")}
    >
      <div className="term-reading-lines" aria-hidden="true">
        {Array.from({ length: READING_ROWS }, (_, index) => <div key={index} className="term-reading-line" />)}
      </div>
      {reading ? null : <p className="term-reading-note" aria-hidden="true">{t("term.waitingComputer")}</p>}
    </div>
  );
}
