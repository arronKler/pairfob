export async function surface(): Promise<string> {
  const loaded = await import("../state");
  return loaded.state.phase;
}
