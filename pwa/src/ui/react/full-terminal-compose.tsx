import { useLayoutEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { OPERATION_INPUT_LIMITS } from "../../lib/operations";
import { state } from "../../state";
import { bindFullTerminalCompose } from "../full-terminal-compose";

export type FullTerminalComposeProps = {
  send: (text: string, enter: boolean) => boolean;
};

/** Batch compose form. The textarea is controller-owned after mount. */
export function FullTerminalCompose({ send }: FullTerminalComposeProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef(send);
  sendRef.current = send;
  const [draft, setDraft] = useState(() => state.composeDraft);

  useLayoutEffect(() => {
    const field = fieldRef.current;
    const form = formRef.current;
    if (!field || !form) return;
    return bindFullTerminalCompose(
      field,
      form,
      (text, enter) => sendRef.current(text, enter),
      ({ draft: next }) => setDraft(next),
    );
  }, []);

  const aria = t("compose.batchAria");
  const sendAria = draft.trim() ? t("compose.sendEnterAria") : t("compose.enterAria");

  return <form ref={formRef} className="full-terminal-compose-form">
    <label className="sr-only" htmlFor="full-terminal-compose">{aria}</label>
    <textarea
      ref={fieldRef}
      id="full-terminal-compose"
      className="full-terminal-compose-input"
      name="pairfob-full-terminal-compose"
      rows={1}
      wrap="soft"
      autoComplete="off"
      spellCheck={false}
      autoCapitalize="none"
      autoCorrect="off"
      inputMode="text"
      placeholder={t("compose.batchPh")}
      enterKeyHint="enter"
      maxLength={OPERATION_INPUT_LIMITS.prompt}
    />
    <button
      type="submit"
      className="full-terminal-compose-send"
      aria-label={sendAria}
    >Enter</button>
  </form>;
}
