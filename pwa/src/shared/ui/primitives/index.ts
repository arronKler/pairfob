/**
 * Shared presentation primitives.
 *
 * Every component here is pure: props in, markup out. None of them imports
 * application state, the paint loop, or a page model, and none of them looks up
 * `#app`. Localized copy is either passed in as a prop or resolved through
 * `lib/i18n`, which is a leaf copy table with no application dependency.
 */
export { Button } from "./button";
export { Spinner } from "./spinner";
export { Brand, StatusDot, StatusLine, type StatusTone } from "./status";
export { Feedback, type FeedbackValue } from "./feedback";
export { EmptyState, type EmptyFigure, type EmptySpec } from "./empty-state";
export { BackBar, BackButton, Chevron } from "./navigation";
export { GroupToggle, SectionTitle } from "./grouping";
export { HelpButton, SetHeading, SetNavRow, SetRow } from "./definition-row";
