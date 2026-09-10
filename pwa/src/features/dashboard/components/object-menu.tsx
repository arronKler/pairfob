import { MenuItem, showActionSheet } from "../../../shared/ui/overlay";
import type { AgentCard } from "../../../lib/ranking";
import type { ObjectMenuKind, ObjectMenuModel } from "../model/object-menu";

/**
 * What one menu action does. The sheet owns ordering, labels and gates from the
 * model; the runner owns the operation, so presentation never reaches the record
 * or the session.
 */
export type ObjectMenuRunner = (kind: ObjectMenuKind, agent: AgentCard) => void | Promise<void>;

/** Present a projected object menu and route each item back through the runner. */
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
      {model.items.map((item) => (
        <MenuItem key={item.kind} modal={modal} danger={item.danger === true} action={() => run(item.kind, agent)}>
          {item.label}
        </MenuItem>
      ))}
    </>
  ));
}
