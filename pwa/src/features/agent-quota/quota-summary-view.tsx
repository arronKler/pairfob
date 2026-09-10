import type { CSSProperties } from "react";
import { Button, SetHeading } from "../../shared/ui/primitives";
import type { QuotaSummaryModel } from "./model";

/**
 * The compact provider ring strip composed into the settings page.
 *
 * Pure: ring geometry, labels and ordering are already resolved in the model,
 * and opening the details page is a callback the caller owns.
 */
export function QuotaSummaryView({ summary, onOpenDetails }: {
  summary: QuotaSummaryModel; onOpenDetails: () => void;
}) {
  return (
    <section className="quota-summary" aria-busy={summary.busy}>
      <SetHeading text={summary.title} help={summary.help} className="quota-summary-heading">
        <Button className="quota-details" onClick={onOpenDetails}>{summary.details}</Button>
      </SetHeading>
      <div className="quota-strip">
        {summary.rings.map(ring => (
          <Button key={ring.provider} className="quota-mini" onClick={onOpenDetails} aria-label={ring.aria}>
            <span className={`quota-ring${ring.unknown ? " is-unknown" : ""}`} aria-hidden="true"
              style={{ "--quota-angle": ring.angle } as CSSProperties}>
              <span className="quota-ring-center">{ring.center}</span>
            </span>
            <span className="quota-mini-name">{ring.name}</span>
          </Button>
        ))}
      </div>
    </section>
  );
}
