---
name: Pairfob
description: A pager for your agent herd.
colors:
  night-deck: "#0a0c10"
  panel: "#12161d"
  raised-panel: "#1a2029"
  sheet-plate: "#0e1218"
  field-sink: "#0a0d12"
  paper-ink: "#e9edf3"
  quiet-ink: "#9aa5b4"
  hairline: "rgba(233, 237, 243, 0.09)"
  hairline-strong: "rgba(233, 237, 243, 0.17)"
  electric-signal-blue: "#6ea8fe"
  signal-depressed: "#3d7bfd"
  signal-on-fill: "#081018"
  settled-green: "#46d68c"
  attention-amber: "#ffb224"
  fault-rose: "#ff8080"
  destructive-red: "#d63b31"
  selected-ground: "#16202e"
  blocked-ground: "#1c1a13"
typography:
  display:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", system-ui, "Segoe UI", sans-serif'
    fontSize: "1.45rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", system-ui, "Segoe UI", sans-serif'
    fontSize: "1.05rem"
    fontWeight: 680
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", system-ui, "Segoe UI", sans-serif'
    fontSize: "0.84rem"
    fontWeight: 500
    lineHeight: 1.45
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", system-ui, "Segoe UI", sans-serif'
    fontSize: "0.72rem"
    fontWeight: 620
    lineHeight: 1.4
  code:
    fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'
    fontSize: "0.78rem"
    fontWeight: 500
rounded:
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "22px"
  control: "14px"
  small-control: "10px"
spacing:
  space-1: "4px"
  space-2: "8px"
  space-3: "12px"
  space-4: "16px"
  space-5: "22px"
  space-6: "32px"
components:
  button-primary:
    backgroundColor: "{colors.electric-signal-blue}"
    textColor: "{colors.signal-on-fill}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 18px"
    height: "52px"
  button-primary-pressed:
    backgroundColor: "{colors.signal-depressed}"
  button-default:
    backgroundColor: "{colors.raised-panel}"
    textColor: "{colors.paper-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 18px"
    height: "52px"
  button-small:
    backgroundColor: "{colors.raised-panel}"
    textColor: "{colors.paper-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.small-control}"
    padding: "0 14px"
    height: "44px"
  button-danger:
    backgroundColor: "{colors.destructive-red}"
    textColor: "#ffffff"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 18px"
    height: "52px"
  menu-item:
    backgroundColor: "{colors.raised-panel}"
    textColor: "{colors.paper-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "48px"
  list-row:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.paper-ink}"
    typography: "{typography.body}"
    height: "64px"
  dialog-card:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.paper-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.xl}"
    padding: "18px"
    width: "23rem"
  text-field:
    backgroundColor: "{colors.sheet-plate}"
    textColor: "{colors.paper-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.small-control}"
    padding: "0 12px"
    height: "46px"
---

# Design System: Pairfob

## Overview

**Creative North Star: "The Pager"**

Pairfob is a pager for an agent herd. A pager is a small, low-light device that stays quiet until something needs you, and then says so in one unmistakable way. That is the whole visual brief: the screen is mostly calm dark ground, and the only things that earn colour are states — who is waiting on you, who is working, who is done.

The surface stack is built for glancing, not reading. Cool near-black grounds climb in small tonal steps, text sits at a size that fits several facts per row, and every separation is a hairline that disappears until you look for the edge. Density is high on purpose: the value of the screen is how much of the herd you can take in at once without panning.

The feel is brisk and warm at the same time. Controls answer a press immediately with a small scale and a colour shift; sheets follow the finger and spring back; nothing animates for decoration. Warmth comes from the copy and from the recovery affordances — an undo in the strip rather than a modal, a notice in place — not from soft colours or round shapes.

**Key Characteristics:**
- Dark by default, with a light theme that restates the same roles rather than inventing new ones
- One action colour; status colours carry meaning and are never used as ornament
- Depth from tonal layering first, shadows only on things that genuinely float
- 1px alpha hairlines instead of solid borders
- Finger targets of 44px and up everywhere; the terminal never loses rows to chrome

## Colors

A cool, low-chroma dark field with one electric blue and three semantic status colours doing all the signalling.

### Primary
- **Electric Signal Blue** (#6ea8fe): the one action colour. Primary buttons, the create affordance, focus rings, the running tint, links inside help copy. On dark it is the only saturated hue in a resting screen.
- **Signal Depressed** (#3d7bfd): the same blue a step deeper, used only while a primary control is held.
- **Signal On-Fill** (#081018): the ink that sits on top of the blue fill; near-black, so filled buttons read as a lit panel rather than a coloured button.

### Secondary
- **Settled Green** (#46d68c): a run finished and unread. Pairs with a slow pulse on live dots and with the green completion edge on a row.
- **Attention Amber** (#ffb224): the agent is blocked and needs a human. It owns the blocked row's warm ground.
- **Fault Rose** (#ff8080): text-level failure — an invalid field, an error toast.
- **Destructive Red** (#d63b31): the button you should hesitate over. The only place a saturated red fills a shape.

### Neutral
- **Night Deck** (#0a0c10): the page ground. Everything else is a step above it.
- **Panel** (#12161d): cards, rows, the surface of a group body.
- **Raised Panel** (#1a2029): a step above a panel — pressed rows, default buttons, menu items.
- **Sheet Plate** (#0e1218): the ground a field is cut into.
- **Field Sink** (#0a0d12): a chosen or recessed region that sits below the page.
- **Paper Ink** (#e9edf3): primary text. Never pure white.
- **Quiet Ink** (#9aa5b4): secondary text, captions, timestamps, disabled labels.
- **Hairline** (rgba(233, 237, 243, 0.09)) / **Hairline Strong** (rgba(233, 237, 243, 0.17)): every divider, every card edge, every field border.
- **Selected Ground** (#16202e): the row the reader has chosen.
- **Blocked Ground** (#1c1a13): the warm ground under a row that is waiting on a human.

### Named Rules
**The One Signal Rule.** Electric Signal Blue marks one thing per view: the primary action, or the working state, never both. Its scarcity is what makes it read as a signal.

**The Meaning-Not-Decoration Rule.** Green, amber and rose are only ever states. A card does not get a coloured accent because it looks flat; it gets one because something happened to it.

**The Restatement Rule.** The light theme restates the same roles on paper — it does not add, drop or re-hue a role. Every alpha wash flips to the dark-alpha equivalent so a hairline stays a hairline. A theme swap must not move a dark value.

## Typography

**Display Font:** system UI stack (-apple-system, SF Pro Text, PingFang SC, Noto Sans SC)
**Body Font:** the same stack
**Label/Mono Font:** ui-monospace / SF Mono for paths, codes, commands and the terminal

**Character:** the system face, never a downloaded webfont. It keeps the app instant on a phone and makes the product read as an instrument rather than a brochure. Weight, size and spacing do the hierarchy work; there are no italics and no display serif.

### Hierarchy
- **Display** (700, 1.45rem, 1.15): screen titles and page headings only.
- **Title** (680, 1.05rem, 1.2, -0.01em): dialog titles, topbar titles, card group heads.
- **Body** (500, 0.84rem, 1.45): row facts, help copy, notices, form labels.
- **Label** (620, 0.72rem): fact keys, captions, micro badges. Sentence case, never shouted.
- **Code** (500, 0.78rem, mono): paths, host names, operation ids, anything a reader might copy.

### Named Rules
**The Literal 16 Rule.** A text input on a phone stays at a literal 16px regardless of the type scale, or iOS zooms the page on focus.

**The Half-Pixel Rule.** Type steps sit on the sizes the UI already converged on, so no label moves by more than half a pixel when a screen adopts a token. Micro badges below 0.7rem and wordmarks above 1.5rem stay deliberate one-offs.

## Layout

One codebase, three surfaces. Width decides the layout and nothing else does:

- under 720px — phone: one screen at a time, tab bar at the bottom
- 720–899px — the list stays beside the session; files and the board take the full page
- 900–1199px — files and changes open beside the session, and the list gives way while they are open
- 1200px and up — list, session, files and changes side by side

A phone on its side keeps the phone layout below 900px: the tier reads the screen's short side, not the window, because width alone cannot tell a landscape phone from a portrait tablet.

Spacing runs on a 4 / 8 / 12 / 16 / 22 / 32 rhythm (`--space-1` … `--space-6`). Rows are 64px tall, controls 44–52px, and the reading column keeps to roughly 12–18px of side padding. Safe-area insets are added, not assumed.

**The Never-Reflow-The-Terminal Rule.** Anything that would change the complete terminal's box — a notice, a side column, a draft — floats or pans over it. It never takes rows, because rows are the program on the computer.

**The No-Page-Pan Rule.** The document never pans sideways. The terminal, the board and each chip rail own their own horizontal scroller; one decoration reaching past the right edge must not turn the list into a drag strip.

## Elevation & Depth

Depth is tonal first. Four grounds — Night Deck, Panel, Raised Panel / Sheet Plate, Field Sink — carry almost all of the hierarchy, separated by hairlines. Shadows are reserved for things that actually float above the page: sheets, dialogs, popovers, menus. A resting row has no shadow at all.

### Shadow Vocabulary
- **Ambient** (`--shadow-1`, `0 8px 20px rgba(0,0,0,0.28)`): a small floating plate over content.
- **Lifted** (`--shadow-2`, `0 10px 28px rgba(0,0,0,0.5)`): an anchored popover or a menu.
- **Top Layer** (`--shadow-3`, `0 28px 90px rgba(0,0,0,0.55)`): a modal card or a bottom sheet, which owns the whole screen while it is open.
- **Focus Ring** (`0 0 0 3px rgba(110,168,254,0.22)`): a halo around a focused field, never a border replacement.

### Named Rules
**The Flat-Row Rule.** Rows and cards are flat at rest. A shadow appears only as a response to state or because the element has left the document flow entirely.

**The Vertical-Only Rule.** Drop shadows fall straight down. Inset rings and status glows stay local to the control that owns them; no decorative light spills across a surface.

## Shapes

Corners are soft but not pill-shaped: 22px for a top-layer card (`--r-xl`), 16px for a group body (`--r-lg`), 12px for a menu item or notice (`--r-md`), 8px for small chips and back affordances (`--r-sm`). Buttons take 14px and small buttons and fields 10px, because a 44px control at 22px would read as a pill.

Borders are 1px alpha hairlines; never a solid grey. Pills are reserved for the create affordance and status dots. There is no gradient fill and no glassmorphism anywhere except the 4px backdrop blur under a modal, which exists to push the page back, not to decorate the card.

**The One-Radius-Family Rule.** A new component takes a radius from the existing family. A one-off radius is a signal that the component belongs to a different system.

## Components

### Buttons
- **Shape:** soft rectangle, 14px radius (10px when small), 1px transparent border.
- **Primary:** Electric Signal Blue fill with Signal On-Fill text, 52px tall, full width in dialogs and forms.
- **Pressed:** scales to 0.98 and deepens to Signal Depressed over 120ms. There is no hover-only state that a finger cannot reach.
- **Default / Ghost / Danger:** raised panel with Paper Ink; transparent with Quiet Ink; a solid Destructive Red fill for the one irreversible action.
- **Small:** 44px minimum height, auto width, 0.84rem.

### Session rows / Cards
- **Shape:** a group body is one 16px-radius panel with `overflow: hidden`; rows inside it are flat, 64px, and separated by a hairline inset 68px from the left, past the agent mark.
- **Background:** Panel at rest, Raised Panel while pressed, Selected Ground when chosen. A row waiting on a human lifts onto the warm Blocked Ground with an amber edge.
- **Motion:** a swipe slides the row's action over its content, with no transition while the finger is down and a spring settle on release.

### Sheets & Dialogs
- **Card:** 23rem max width, 22px radius, Panel fill, Top Layer shadow, 18px padding.
- **Phone:** the same dialog becomes a bottom sheet — a grab handle, a fixed head, a scrolling body, drag-to-dismiss, and the page behind scaled back by 1.5% while it is open.
- **Anchored:** a mouse-opened menu is a popover at its trigger, not a sheet at any width. Width must not decide the interaction.

### Fields
- **Shape:** 10px radius, 1px Hairline Strong, Sheet Plate ground, 46px tall.
- **Focus:** the border turns Electric Signal Blue and gains the 3px focus halo. A quiet-focus dialog suppresses the ring for a finger, but keeps the field's border and glow, because those are not a keyboard ring.
- **Invalid:** Fault Rose border with a rose halo and matching hint text.

### Navigation
- **Topbar:** 44px minimum, title at 1.1rem/700 with -0.01em tracking, actions right-aligned and wrapping.
- **Create:** a text-plus-glyph affordance in Electric Signal Blue, with a translucent 12% blue plate and a 22% blue border drawn as a pseudo-element so the 44px target is taller than the chip it draws.

### Notices & Status
- **Notice:** 12px radius, translucent fill — the accent tint for status, a 12% red tint with a rose border for errors. It floats; it does not push the terminal.
- **Status dot:** 6px, coloured by state; a live run pulses slowly (2.6s), a blocked one faster (1.4s). Under reduced motion the dot stops moving and keeps its colour, because the colour is the message.

## Do's and Don'ts

### Do:
- **Do** take a colour from a role token (`--accent`, `--warn`, `--surface-2`), never a literal in a screen's stylesheet.
- **Do** express state with colour, position and a short transition, in that order of importance.
- **Do** keep every finger target at 44px or more, and give the press a visible answer within 120ms.
- **Do** use a hairline at 9% or 17% ink for separation, and a tonal step for hierarchy.
- **Do** let a sheet, popover or notice float over the terminal instead of laying the page out around it.
- **Do** state light-theme values inside `light-theme` as the same roles, so one override repaints the product.

### Don't:
- **Don't** introduce a second accent hue. Blue is the action colour; green, amber and rose are states.
- **Don't** put an accent fill on more than one primary action in the same view.
- **Don't** add a shadow to a resting row or card; step the tone instead.
- **Don't** invent a radius outside the 8/10/12/14/16/22 family.
- **Don't** use gradients, glass panels or glowing outlines; the one backdrop blur belongs to a modal's scrim.
- **Don't** put text below 0.7rem in a control, or below a 3:1 contrast ratio against its ground in a terminal.
- **Don't** let any chrome take rows from the complete terminal — it resizes the program on the computer.
