import { useAppNotice } from "../../app/notice";
import type { Notice } from "../../app/notices-store";
import { Feedback } from "../../shared/ui/primitives";

/**
 * The notice of an open session, placed by how long it is there.
 *
 * One that leaves by itself floats over the top of the transcript or buffer
 * (`.session-notice`, session-shell.scss). In the page's flow it pushed
 * everything under it down for as long as it showed and let it jump back, so a
 * press aimed at a control landed on whatever had slid under the pointer.
 * Floating, it takes no room, and since a notice is a line of text with nothing
 * to press it lets presses through to what it covers.
 *
 * One that stays keeps its place in the page: it is there until the reader does
 * something about it, and a float left over the first lines would hide them for
 * as long.
 */

/**
 * An error raised to stay explains what the reader has to act on (a send that
 * was not confirmed, a prompt that failed). A status raised to stay is an
 * operation in flight: its result replaces it, so it floats as the result does
 * and the pair moves nothing.
 */
export function noticeKeepsItsPlace(notice: Notice): boolean {
  return notice.persistent === true && notice.tone === "error";
}

/**
 * `inPage` is for a note the session itself keeps on screen, whatever its tone.
 * `afloat` is for a screen whose box is not its own to resize: the complete
 * terminal's rows are the computer's terminal rows, so a notice that took a
 * place in its page would resize the program under it. There every notice
 * floats, the ones that stay included.
 */
export function SessionNotice({ value, inPage = false, afloat = false }: { value: Notice | null; inPage?: boolean; afloat?: boolean }) {
  if (!value) return null;
  const notice = <Feedback value={value} appNotice />;
  if (!afloat && (inPage || noticeKeepsItsPlace(value))) return notice;
  return <div className="session-notice">{notice}</div>;
}

/** The application notice as a session places it; it repaints alone when the notice changes. */
export function SessionAppNotice({ afloat = false }: { afloat?: boolean }) {
  return <SessionNotice value={useAppNotice()} afloat={afloat} />;
}
