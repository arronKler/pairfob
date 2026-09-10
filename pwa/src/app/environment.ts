import { isDesk } from "./viewport";
import type { DomainEnvironment } from "../shared/model/domain-environment";

/**
 * The real browser environment. This is the App boot boundary: it reads
 * `localStorage`, `navigator` and the responsive viewport, so it is called once
 * from the browser boot lifecycle, never at import time and never from a pure
 * domain model. The pure `DomainEnvironment` type and the headless
 * `emptyEnvironment` factory live in `shared/model/domain-environment.ts`.
 */
export function browserEnvironment(): DomainEnvironment {
  return {
    read(key: string): string | null {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    online: typeof navigator === "undefined" ? true : navigator.onLine !== false,
    desk: typeof window === "undefined" ? false : isDesk(),
  };
}
