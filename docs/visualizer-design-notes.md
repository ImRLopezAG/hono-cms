# Schema Visualizer — Design Notes

Date: 2026-05-23
Module: C (component-in-existing-app — admin uses shadcn + Tailwind 4 + Inter Variable + indigo accent)

## Visual Thesis

Editorial, schema-as-typography. The canvas is the page; chrome recedes. One confident accent (indigo) on slate neutrals. No nested cards.

## What changed vs the first cut

**Before:** Three nested cards — page wrapper → "Schema visualizer" card → canvas card → toolbar card-row. Title was a thin h1 sized smaller than the section heading above it. Collection nodes had a chunky two-tone gradient header with a large pill. Field-row kind labels at #94a3b8 over white failed WCAG contrast.

**After:**

- **Editorial page header.** "CONTENT TYPES" eyebrow + "Schema" h1 (28px, -0.02em tracking, semibold). Subtitle 14px slate at 56ch max-width. Back-link slipped into the right column without crowding the title.
- **Inline action bar** replaces the toolbar card-row. Live `Writable` status pill (green dot) sits next to the collection/relation counts. The primary "+ New collection" button anchors right.
- **Canvas** has a cooler slate-50 ground with crisper #cbd5e1 dots at 24px gap — strong enough figure-ground that the white nodes pop without a heavy shadow.
- **Collection nodes:** single-weight typographic header (collection name 14px semibold + tabular field count). A small "·" dot follows the name as a calm visual separator instead of the gradient header. Chips moved below as a separate row only when relevant (Drafts / i18n).
- **Field rows:** monospace kind labels (string, uid, bool, richtext, →), so the panel reads like a schema definition. Required = REQ pill in indigo only; Unique = UNQ amber; i18n = sky. Each used sparingly.
- **Edges:** thin slate by default. Labels only appear on hover/select (no chatter at rest). Crow-foot markers in the same accent on select.
- **Dialog:** condensed (440px), eyebrow + h2, footer band with the accent-button system. TanStack Form unchanged.

## Motion

Three intentional motions:

1. Node entrance — `hcms-node-enter` (220ms ease-out, 4px translateY + fade)
2. Dialog rise — 160ms cubic-bezier(0.2, 0.8, 0.2, 1)
3. Edge label reveal on hover/select — 100ms opacity transition

No decorative shadows. No ornamental color.

## Accessibility

- `<section>` with `aria-labelledby` for the page
- `<article>` for each collection node with `aria-label="Collection {name}"`
- Status pill announces `Writable` / `Read-only` as text (not just color)
- `:focus` on every input shows a 3px indigo ring via `box-shadow`, not the default browser outline only
- WCAG AA contrast: kind labels moved from `#94a3b8` (3.4:1) to `#64748b` (5.4:1) on white

## Files touched

- `apps/admin/src/components/visualizer/visualizer.css` — new CSS variable palette + layout primitives
- `apps/admin/src/components/visualizer/VisualizerCanvas.tsx` — header slot prop + inline action bar
- `apps/admin/src/components/visualizer/CollectionNode.tsx` — flatter header, monospace kind labels, semantic `<article>`
- `apps/admin/src/components/visualizer/AddCollectionDialog.tsx` — class renames + eyebrow + condensed footer
- `apps/admin/src/app/settings.content-types.visualizer.tsx` — editorial header structure

## Litmus check

- One strong visual anchor? **Yes** — the canvas reads as a piece of schema typography
- Each section one job? **Yes** — header introduces, bar acts, canvas is the work
- Cards actually necessary? **No new cards added.** The dialog is the only card surface; the canvas is unwrapped.
- Premium without shadows? **Yes** — node has a 1px shadow on hover only

## Known limits / next pass

- The page's parent shell ("Content Operations" header + sidebar) still uses the older admin look. A wider admin-shell redesign is out of scope here.
- Edge label still shows static "many-to-one" cardinality; an inline cardinality editor would belong in U12.
- Mobile <768px not addressed; xyflow has its own mobile mode and the editorial header would need to stack.
