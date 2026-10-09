# Shared UI

Keep presentation and local interaction here; pass business state and actions in
from features. Shared UI must not import pages, domain stores or protocol clients.
The architecture tests enforce that dependency direction.

Use these existing modules before adding another visually equivalent control:

- `primitives/segmented-control`: `SegmentedControl` and `SegmentedOption` own
  radio semantics, selection classes, one tab stop, arrow/Home/End navigation
  and disabled-item skipping. Business callbacks still own selection changes.
  Use `activation="manual"` when choosing an option closes a menu or triggers
  another screen. Terminal options may use `as={PadChromeButton}` to retain
  native pointer/focus protection. Native radio inputs (such as attachment
  compression choices) already have browser keyboard behavior; keep them native.
- `primitives/navigation`: `BackBar` for titled navigation, `TopbarActions` for
  trailing page actions. The action group keeps intrinsic button widths, right
  alignment and wrapping. Its styles belong to shared navigation, not a feature.
- `primitives/selection-row`: `SelectionRow` for a selectable title/description
  row, with optional leading content and a status badge. Keep a separate delete
  or forget action outside the row button; never nest interactive elements.
- `overlay/dialog-lifecycle`: native opening, cancel/backdrop guards, closing,
  optional sheet drag and cleanup. `ModalFrame` and `SheetFrame` use it for
  promise-based dialogs; controlled portals can use the same hook directly.
  `presentModal` owns promise settlement and focus restoration for its dialogs.
  Controlled portals opt into `restoreFocus`; do not give both layers ownership.
- `overlay/sheet-content`: the shared sheet handle, heading, close target and
  scrollable body. Keep forms and validation in their owning feature.
- The desk form (a dialog a mouse or the keyboard opened beside the list) has
  one anatomy and one order, the document's and the eye's alike: title, form,
  footer (`DeskCancel`, then the action), corner close (`DeskClose`, which
  `ModalFrame deskClose` and `SheetContent` write last). `DeskCancel` draws
  nothing in a sheet; a footer button of your own takes the `desk-action`
  mixins. `useDeskEnter` gives a form Enter from its fields and its choices.
  Tab is kept inside every dialog by the lifecycle; do not add a trap.
- A sheet's pinned footer is written through `SheetFooter`
  (`overlay/sheet-content`): the bottom sheet keeps it inside the scroller, the
  desk card places it under the scrolling body, so a scrollbar never moves it.
- Escape undoes the last step first. A step taken inside a dialog (a question
  asked in place, a list that took the form's place) registers with
  `useEscapeStep` (`overlay/escape-steps`); a pushed page and the dialog follow.
  A dialog opened over another as its next step takes `stepClass()`.
- A refused submit leaves the reader in the field it is about and a form that
  locks while it runs never drops focus onto the page: `focusRefused` and
  `holdFocus` (`overlay/form-focus`).

Reuse `Button`, `EmptyState`, `StatusLine`, setting rows and menu primitives as
appropriate. `Button` deliberately retains native props and only defaults the
button type; it does not own business loading or mutation state. Specialized
terminal keys, board tabs and the camera scanner retain their own interactions.
