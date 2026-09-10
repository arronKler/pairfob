/**
 * One-line result banner.
 *
 * The value is a prop, so the component paints whatever a caller resolved and
 * owns no notice store. `appNotice` marks the application-wide instance, which
 * is the only one that lives outside a page's own flow.
 */
export type FeedbackValue = { text: string; tone: "error" | "status" };

export function Feedback({ value, id, appNotice = false }: { value: FeedbackValue; id?: string; appNotice?: boolean }) {
  return <p id={id} className={`notice notice-${value.tone}`} role={value.tone === "error" ? "alert" : "status"}
    aria-live={value.tone === "error" ? "assertive" : "polite"} aria-atomic="true"
    data-app-notice={appNotice ? "" : undefined} data-react-notice={appNotice ? "" : undefined}>{value.text}</p>;
}
