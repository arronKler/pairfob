import { Button as Imported } from "./shared-primitives";

function Local(): null {
  return null;
}

const LocalConst = 1;

export { Imported as Button, Local, LocalConst };
export { Feedback as FeedbackView } from "./shared-primitives";
