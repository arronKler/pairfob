/**
 * Domain environment contract (framework-neutral).
 *
 * The browser facts a domain may need at hydration, expressed as a pure type and
 * a headless factory. Domain models initialize from pure defaults so importing
 * them requires no `window`, `document`, `navigator` or `localStorage`; the
 * browser boot boundary supplies a real environment once and hydrates the
 * domains through their owner actions.
 *
 * The real `browserEnvironment` stays at the App boundary (`app/environment.ts`)
 * because it reads `navigator`, `localStorage` and the responsive viewport. This
 * module imports no DOM, React or App.
 */
export type DomainEnvironment = {
  /** Guarded storage read: blocked or missing storage yields null. */
  read(key: string): string | null;
  /** Browser-reported reachability at boot. */
  online: boolean;
  /** Wide layout at boot; the responsive listener keeps it current afterwards. */
  desk: boolean;
};

/** An environment with nothing stored, for fixtures and headless callers. */
export function emptyEnvironment(overrides: Partial<DomainEnvironment> = {}): DomainEnvironment {
  return { read: () => null, online: true, desk: false, ...overrides };
}
