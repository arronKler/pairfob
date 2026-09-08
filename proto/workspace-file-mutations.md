# Workspace file mutations

`WorkspaceRename` and `WorkspaceDelete` extend inner RPC without changing the
pairfob.v1 envelope or pairing crypto. Both require an Established session and a
fresh `operation_id`. GetConfig advertises `rename_file` and `delete_file`;
older daemons omit these keys, which the PWA treats as false.

Both requests carry `pane_id`, optional `session`, `root` (the canonical root
from WorkspaceOpen), workspace-relative `path`, and the selected directory
entry's `size`, `modified_ms`, and `revision`. The optional entry `revision` is
a SHA-256 token binding device/inode, size, and nanosecond mtime; file actions
require it. Existing daemons' entries may omit it. WorkspaceRename additionally requires
`new_name`: a basename in the same directory, at most 255 UTF-8 bytes.

The daemon re-reads the live pane root inside the durable operation ledger.
It rejects root changes, traversal, symlink components, Git metadata, non-regular
files, and inode/size/nanosecond-mtime changes. Metadata checking is best effort against
concurrent local edits, not a filesystem transaction. Parent directories are
opened without following symlinks and retained by descriptor during the operation.
Renames use atomic no-replace operations; deletes unlink one file, never recurse.
Deletion is permanent and requires confirmation in the PWA.

Success is `{ "operation_id": "op_...", "outcome": "applied" }`.
`conflict` covers a changed file or occupied destination. Unknown outcomes are
refreshed with reads only, never replayed automatically. Duplicate operation IDs
return the stored outcome; reusing an ID for a different intent fails closed.
The PWA invalidates the session/root read cache after every attempted mutation.

Deploy the updated PWA and upgrade the computer's daemon to enable these actions.
Old PWA versions enforce their earlier exact capability set; reload the updated
PWA when upgrading the daemon.
