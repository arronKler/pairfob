# Machine linking

`ListMachines`, `LinkMachine`, `LinkMachineStatus` and `LinkMachineCancel`
extend inner RPC without changing the pairfob.v1 envelope or pairing crypto.
All four require an Established session. GetConfig advertises `link_machine`;
older daemons omit the key, which the PWA treats as false.

A machine is another computer the paired one already reaches over the
operator's own SSH (the runtime's saved machines). Linking does not proxy that
machine's panes. It starts Pairfob there and relays that machine's ordinary
one-use pairing offer to the device, which then pairs with it directly. Each
machine keeps its own daemon identity and keys; this computer never holds them.

## Requests

- `ListMachines {}` → `{ "machines": [{ "id", "label", "state", "daemon_id"? }] }`.
  `id` is an opaque profile ID. `state` is `available`, `disabled`, or
  `session_unsupported`. `daemon_id` is present once this computer has linked
  the machine, so a device can tell which machines it already holds. SSH
  targets, hosts and paths never appear in any result.
- `LinkMachine { operation_id, machine_id, install? }` starts the one link job
  this computer runs at a time and returns its status. A second request while a
  job is active fails with `conflict`. `machine_id` must be an ID from
  `ListMachines`; a device cannot name an SSH destination.
- `LinkMachineStatus {}` → the current job.
- `LinkMachineCancel { operation_id }` ends that job if the calling device
  started it, and returns the current job.

## Job status

`{ "operation_id", "machine_id", "phase", "pair_url"?, "error"? }`

| Phase | Meaning |
| --- | --- |
| `idle` | No job has run. `operation_id` and `machine_id` are empty. |
| `checking` | Probing the machine over SSH. |
| `needs_install` | Pairfob is missing or too old there, and the request did not carry `install: true`. Nothing was changed. The PWA asks the user, then sends a new `LinkMachine` with a fresh `operation_id` and `install: true`. |
| `installing` | Running the official installer on the machine. |
| `offering` | `pair_url` holds the machine's pairing link. |
| `paired` | The machine accepted the device that proved the code. |
| `failed` | `error` is one of `unreachable`, `unsupported`, `disabled`, `session_unsupported`, `not_running`, `install_failed`, `cancelled`, `expired`, `internal`. |

`pair_url` is the same `/pair#…` link a QR code carries, including the one-use
code. It is returned only to the device that started the job and only while
`offering`; other devices see the phase without it. The PWA must pair from it
only when its origin is the page's own origin.

## Admission

On a terminal, the operator presses Enter to admit a device after it proves the
code. Here the machine's `pairfob pair offer` admits it instead: the offer has
travelled only over the operator's SSH session and this Established session,
and the device still has to prove the code through SPAKE2+. The offer process
holds the SSH session open; cancelling, expiry, or losing that session denies
the slot on the machine.

## Failure handling

`LinkMachine` is a mutation: it carries a fresh `operation_id` and is never
retried automatically. An unknown outcome is resolved by reading
`LinkMachineStatus`, not by replaying. Every failure is closed: an SSH prompt,
an unknown host key, an unsupported OS, or a named remote session ends the job
with an error code rather than a guess.

Deploy the updated PWA before upgrading daemons. Old PWA versions enforce
their earlier exact capability set and reject a GetConfig that carries
`link_machine`.
