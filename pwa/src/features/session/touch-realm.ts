/**
 * Test support: a realm whose pointer is a finger.
 *
 * The test DOM answers every pointer query like a mouse, at any width. A suite
 * that pins phone or tablet behaviour (Return adds a line, nothing takes focus
 * unasked, the key row stays) says so here and restores the realm afterwards.
 */
type Realm = { matchMedia: (query: string) => MediaQueryList };

export function emulateTouchDevice(realm: Realm = window): () => void {
  const native = realm.matchMedia;
  realm.matchMedia = (query: string): MediaQueryList => {
    const fine = /\(pointer:\s*fine\)|\(hover:\s*hover\)/.test(query);
    const coarse = /\((any-)?pointer:\s*coarse\)/.test(query);
    if (!fine && !coarse) return native.call(realm, query);
    return {
      matches: coarse && !fine,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    } as MediaQueryList;
  };
  return () => { realm.matchMedia = native; };
}
