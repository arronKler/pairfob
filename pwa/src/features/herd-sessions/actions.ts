import { switchHerdSession as retargetHerdSession } from "../connection/controller";
import { notifyHerdSessionSelection } from "./store";

/**
 * Switch the live connection to `name` (null = default). The switch ends in a
 * runtime refresh, which re-reads the list and its running flags.
 */
export async function chooseHerdSession(name: string | null): Promise<void> {
  await retargetHerdSession(name);
  notifyHerdSessionSelection();
}
