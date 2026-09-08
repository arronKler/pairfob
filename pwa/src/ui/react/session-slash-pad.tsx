import { SLASH_COMMANDS } from "../../lib/slash-commands";
import { t } from "../../lib/i18n";
import { state } from "../../state";
import { selectPadKind } from "../session/slash-pad";
import { setComposeText } from "../session/compose";
import { PadChromeButton } from "./keep-compose-focus";

export function SessionPadModeBar({ onRepaint }: { onRepaint: () => void }) {
  return <div className="seg pad-mode" role="radiogroup" aria-label={t("slash.padKind")}>
    {([
      { kind: "keys" as const, label: t("slash.keys") },
      { kind: "slash" as const, label: t("slash.commands") },
    ]).map((option) => {
      const selected = state.padKind === option.kind;
      return <PadChromeButton
        key={option.kind}
        type="button"
        className={`seg-item${selected ? " on" : ""}`}
        role="radio"
        aria-checked={selected ? "true" : "false"}
        onClick={() => selectPadKind(option.kind, onRepaint)}
      >{option.label}</PadChromeButton>;
    })}
  </div>;
}

export function SessionSlashPad({ onSelect = setComposeText }: { onSelect?: (text: string) => void }) {
  return <div className="slash-pad" role="group" aria-label={t("slash.agentCmds")}>
    {SLASH_COMMANDS.map((command) => (
      <PadChromeButton
        key={command.token}
        type="button"
        className="key slash-cmd"
        aria-label={command.ariaKey ? t(command.ariaKey) : t("slash.insert", { label: command.label })}
        onClick={() => onSelect(command.token)}
      >{command.label}</PadChromeButton>
    ))}
  </div>;
}
