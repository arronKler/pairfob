import { ALargeSmall } from "lucide-react";
import { usePointerFine } from "../../../app/input-mode";
import { t } from "../../../lib/i18n";
import { showActionSheet } from "../../../shared/ui/overlay/action-sheet";
import { MenuGroup, MenuStepper } from "../../../shared/ui/overlay/menu-controls";
import { Button } from "../../../shared/ui/primitives";
import { autoChatSize, canStepChatSize, drawnChatSize, stepChatSize, useChatFontSize } from "./chat-reading";

/**
 * The transcript's reading size, applied in place behind the sheet: the
 * conversation stays visible, and the reader watches the words change. The
 * same two fingers that work the sheet's buttons work on the transcript itself
 * (`useChatPinch`).
 */
function ChatReadingSettings() {
  const fine = usePointerFine();
  const auto = autoChatSize(fine);
  const size = drawnChatSize(useChatFontSize(), fine);
  return <MenuGroup>
    <MenuStepper label={t("pane.fontSize")} value={t("pane.fontPx", { n: Number(size.toFixed(1)) })}
      decrease={t("menu.fontDown")} increase={t("menu.fontUp")}
      onDecrease={() => stepChatSize(-1, auto)} onIncrease={() => stepChatSize(1, auto)}
      canDecrease={canStepChatSize(-1, auto)} canIncrease={canStepChatSize(1, auto)} />
  </MenuGroup>;
}

/**
 * The transcript's size, in the chat header beside the files and menu. Lit
 * while the reader has chosen a size of their own, so a larger page that
 * followed the pointer still reads as the automatic one.
 */
export function ChatReadingButton() {
  const fine = usePointerFine();
  const chosen = useChatFontSize();
  const label = t("pane.fontSize");
  const size = drawnChatSize(chosen, fine);
  return <Button className={`icon-btn icon-reading${chosen !== null ? " is-set" : ""}`}
    aria-label={chosen === null ? label : t("chat.readingAria", { label, size: Number(size.toFixed(1)) })}
    title={label} aria-haspopup="dialog"
    onClick={() => showActionSheet(label, () => <ChatReadingSettings />,
      { className: "chat-reading-sheet", popover: "panel" })}>
    <ALargeSmall size={20} aria-hidden="true" />
  </Button>;
}
