export async function surface(): Promise<string> {
  const loaded = await import("../lib/i18n");
  return loaded.copy;
}
