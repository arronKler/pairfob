import { ChevronDown } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { t } from "../../../lib/i18n";
import { Button, StatusDot } from "../../../shared/ui/primitives";
import { hostBrief, STATUS_JOIN, type HerdHostView } from "../model/herd-view";

/**
 * The rail's status line: the sentence the phone header reads, whenever the
 * head has room for it, and otherwise its parts, most telling first, each
 * carrying the dot that joins it to the one before. The row then shows as many
 * parts as fit and drops the others whole, so it never ends in half a number
 * or a unit on its own.
 *
 * Whether the sentence fits is measured, not guessed from the window: the room
 * depends on the rail's width and the pointer's button sizes, the sentence on
 * the language and the latency's digits. It is laid out once out of sight on a
 * single row and compared with the line, again whenever either changes size.
 */
function RailStatus({ host }: { host: HerdHostView }) {
  const line = useRef<HTMLSpanElement>(null);
  const whole = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    const room = line.current;
    const sentence = whole.current;
    if (!room || !sentence) return;
    const measure = () => {
      const width = room.getBoundingClientRect().width;
      // A line that is not laid out (the rail hidden behind the inspector) has no room to judge by.
      setFits(width > 0 && sentence.getBoundingClientRect().width <= width + 0.5);
    };
    measure();
    const sized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    sized?.observe(room);
    sized?.observe(sentence);
    return () => sized?.disconnect();
  }, [host.line]);
  return (
    <span ref={line} className="host-title-line is-brief">
      {/* Drawn by the style sheet from the attribute, so the line's own text stays what it shows. */}
      <span ref={whole} className="host-title-whole" data-sentence={host.line} aria-hidden="true" />
      {fits
        ? <span className="host-title-fact">{host.line}</span>
        : hostBrief(host).map((part, index) => <span key={index} className="host-title-fact">{index ? STATUS_JOIN : ""}{part}</span>)}
    </span>
  );
}

/**
 * The list's title on the phone header and in the desktop rail's head: the
 * computer this list belongs to, and one line for how it is reached. It opens
 * the computer panel (switch, retry, details).
 *
 * `brief` is the rail, whose head may be too narrow for the sentence
 * (`RailStatus`). A pointer resting on the title reads the name and the line
 * in full, and the button's name always carries both.
 */
export function HostTitle({ host, onOpen, brief = false }: { host: HerdHostView; onOpen: () => void; brief?: boolean }) {
  return (
    <Button
      className={`host-title is-${host.tone}`}
      aria-haspopup="dialog"
      aria-label={t("host.aria", { host: host.name, status: host.line })}
      title={brief ? `${host.name} · ${host.line}` : undefined}
      onClick={onOpen}
    >
      <StatusDot tone={host.tone} />
      <span className="host-title-text">
        <span className="host-title-name">
          <span className="host-title-label">{host.name}</span><ChevronDown size={16} aria-hidden="true" />
        </span>
        {brief ? <RailStatus host={host} /> : <span className="host-title-line">{host.line}</span>}
      </span>
    </Button>
  );
}
