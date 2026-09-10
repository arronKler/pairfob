/**
 * Computers flow/navigation generation. Forget captures the id; Add, switch
 * and leaving the picker advance it so a late delete landing cannot overwrite
 * a replacement connect flow or notice when live/credential are already null.
 * This module has no domain imports.
 */

let computersFlow = 0;

export function computersFlowId(): number {
  return computersFlow;
}

export function advanceComputersFlow(): void {
  computersFlow += 1;
}
