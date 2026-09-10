// A layer must never do this: import { state } from "../state";
// and it must never do this either: await import("../state");
const documented = 'import { state } from "../state" is forbidden here';
const example = "await import(\"../state\")";

export const surface = [documented, example];
