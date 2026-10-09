import type { PaletteActionId, PaletteInput } from "./model/palette";

/**
 * What search-and-jump needs from the application.
 *
 * The palette lists the herd and fires the list's and the rail's own actions,
 * and the rail in turn opens the palette. So the feature imports neither: the
 * composition that already holds the herd bridge provides these ports, and
 * everything here stays a leaf that any entry point can import.
 */
export type CommandPalettePorts = {
  /** One snapshot of what the palette lists; taken on open and after every notification. */
  read(): PaletteInput;
  subscribe(listener: () => void): () => void;
  /** The list row's own open action, so a jump behaves as a click on the row. */
  openSession(paneId: string): void;
  /** The rail's own entry for that destination. */
  runAction(action: PaletteActionId): void;
};

let ports: CommandPalettePorts | null = null;

/** Called once by the application composition; `null` withdraws them (fixtures). */
export function provideCommandPalette(next: CommandPalettePorts | null): void {
  ports = next;
}

export function commandPalettePorts(): CommandPalettePorts | null {
  return ports;
}
