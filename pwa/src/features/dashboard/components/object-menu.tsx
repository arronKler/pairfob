import { MenuItem, MenuSection, showActionSheet } from "../../../shared/ui/overlay";
import type { AgentCard } from "../../../lib/ranking";
import { objectMenuSections, type ObjectMenuKind, type ObjectMenuModel } from "../model/object-menu";

/**
 * What one menu action does. The sheet owns ordering, labels and gates from the
 * model; the runner owns the operation, so presentation never reaches the record
 * or the session.
 */
export type ObjectMenuRunner = (kind: ObjectMenuKind, agent: AgentCard) => void | Promise<void>;

/**
 * Where focus goes when the control the menu opened from cannot take it back.
 * A swiped row's "more" is behind the row again by then, so the row itself
 * answers; a session that left the list while its menu was open leaves the
 * list to answer, with the row the reader is on or its first.
 */
function listHome(paneId: string): HTMLElement | null {
  const rows = [...document.querySelectorAll<HTMLElement>(".herd-list .card-main[data-pane-id]")].filter(row => !row.closest("[hidden]"));
  return rows.find(row => row.dataset.paneId === paneId) ?? rows.find(row => row.getAttribute("aria-pressed") === "true") ?? rows[0] ?? null;
}

/**
 * Present a projected object menu and route each item back through the runner.
 * Rows about one object stay together under its name — this session, its tab,
 * its workspace — as a ruled group in the popover and a headed run in the sheet.
 */
export function openObjectMenu(
  model: ObjectMenuModel,
  agent: AgentCard,
  run: ObjectMenuRunner,
): void {
  showActionSheet(model.title, (modal) => (
    <>
      {model.facts.length > 0 && (
        <dl className="sheet-facts">
          {model.facts.map((row, index) => (
            <div key={index} className="sheet-fact">
              <dt className="sheet-fact-key">{row.key}</dt>
              <dd className={`sheet-fact-val${row.kind === "path" ? " sheet-fact-path" : ""}`}>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {objectMenuSections(model).map((section) => {
        const rows = section.items.map((item) => (
          <MenuItem key={item.kind} modal={modal} danger={item.danger === true} action={() => run(item.kind, agent)}>
            {item.label}
          </MenuItem>
        ));
        return section.title ? <MenuSection key={section.scope} title={section.title}>{rows}</MenuSection> : rows;
      })}
    </>
  ), { popover: "menu", className: "object-menu-sheet", home: () => listHome(agent.paneId) });
}
