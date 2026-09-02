export type Lab = "workspace";

/** URL-only release gate. It deliberately does not persist after the flag is removed. */
export function labEnabled(lab: Lab, search = typeof location === "undefined" ? "" : location.search): boolean {
  const params = new URLSearchParams(search);
  return params.getAll("labs").some((value) => value.split(",").some((entry) => entry.trim() === lab));
}
