import type { ClipboardEvent } from "react";
import { t } from "../../lib/i18n";
import { PAIR_CODE_WITH_LOCATOR_PATTERN } from "../../lib/pairing-input";
import { Button } from "../../shared/ui/primitives";
import type { ConnectViewModel } from "./model";
import { keepPhrases } from "./phrases";

/**
 * The typed-code field with its label and feedback line: one field for the code
 * sheet and for the card on the page, so both validate and read the same. It is
 * controlled by the pairing domain and lives inside the caller's form.
 *
 * `onPaste` is the clipboard button (the sheet, where reaching the system paste
 * menu takes a long press); `onPasteText` sees a keyboard paste before the field
 * does and returns true when it took the text.
 *
 * The field has no length limit of its own: one would cut a paste short without
 * a word. Everything typed or pasted stays, the counter and the message say when
 * it is more than a code (`pairCodeOver`), and Connect turns it away until it is
 * fourteen.
 */
export function PairCodeField({ view, placeholder, readOnly = false, onPaste, onPasteText, onCodeChange }: {
  view: ConnectViewModel;
  placeholder: string;
  readOnly?: boolean;
  onPaste?: () => void;
  onPasteText?: (text: string) => boolean;
  onCodeChange: (code: string) => void;
}) {
  const notice = view.fieldNotice;
  const error = notice?.tone === "error";
  const hint = keepPhrases(notice?.text ?? t("connect.pairHelp"));
  const paste = onPasteText
    ? (event: ClipboardEvent<HTMLInputElement>) => { if (onPasteText(event.clipboardData.getData("text"))) event.preventDefault(); }
    : undefined;
  return <>
    <div className="pair-field-head">
      <label className="field-label" htmlFor="pair-code">{t("connect.pairCode")}</label>
      {onPaste ? <Button className="pair-paste" onClick={onPaste}>{t("connect.paste")}</Button> : null}
    </div>
    <input id="pair-code" name="code" type="text" className="pair-code-input" autoComplete="one-time-code"
      spellCheck={false} autoCapitalize="characters" autoCorrect="off" inputMode="text" enterKeyHint="go"
      placeholder={placeholder} value={view.pairCodeDraft} required readOnly={readOnly}
      pattern={PAIR_CODE_WITH_LOCATOR_PATTERN} title={t("connect.pairTitle")}
      aria-invalid={view.pairCodeInvalid ? "true" : undefined} aria-describedby="pair-feedback"
      onPaste={paste}
      onChange={event => {
        // Rewriting case/separators here terminates Android IME preedit and
        // moves its replacement range. Keep the DOM value verbatim; the submit
        // parser already normalizes the code, including case and separators.
        onCodeChange(event.currentTarget.value);
      }} />
    <div className={`pair-help${error ? " is-error" : ""}`}>
      <span id="pair-feedback" role={error ? "alert" : undefined}>{hint}</span>
      <span className={`field-count${view.pairCodeComplete ? " ok" : view.pairCodeOver ? " over" : ""}`}>{`${view.pairCodeLength}/14`}</span>
    </div>
  </>;
}
