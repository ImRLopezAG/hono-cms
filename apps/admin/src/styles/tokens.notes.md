# Design tokens — philosophy and usage

`tokens.css` is the **single source of truth** for color, typography,
spacing, motion, radii, shadow, and z-index in the `@hono-cms/admin` SPA.
Everything else (component CSS, shadcn primitives, the existing
`visualizer.css` / `admin-shell.css`) should reference these variables,
not raw hex values.

## Why semantic naming

We follow Strapi's design-system vocabulary (`primary600`, `neutral100`,
`danger700`, etc.) re-expressed as CSS custom properties. That gives us
two layers:

1. **Raw scales** — `--color-neutral-50…950`, `--color-primary-50…900`,
   `--color-success-*`, `--color-warning-*`, `--color-danger-*`.
   Pick a step like you'd pick a Tailwind shade.
2. **Semantic aliases** — `--color-surface`, `--color-ink`,
   `--color-border`, etc. These resolve to a raw scale step today but
   are the *real* contract for components. They re-point under
   `[data-theme="dark"]`. **Prefer these.**

## What to use when

| Intent | Token |
| --- | --- |
| Page background | `var(--color-surface-subtle)` |
| Card / panel background | `var(--color-surface)` |
| Hover row / table head | `var(--color-surface-muted)` |
| Slightly raised surface | `var(--color-surface-strong)` |
| Primary body text | `var(--color-ink)` |
| Secondary text | `var(--color-ink-dim)` |
| Meta / labels | `var(--color-ink-mute)` |
| Placeholder / hint | `var(--color-ink-faint)` |
| Border (default) | `var(--color-border)` |
| Border (emphasised, e.g. input) | `var(--color-border-strong)` |
| Primary CTA fill | `var(--color-primary-600)` |
| Primary CTA hover | `var(--color-primary-700)` |
| Primary CTA disabled | `var(--color-primary-200)` |
| Soft chip / pill background | `var(--color-accent-soft)` |
| Soft chip text | `var(--color-accent-soft-ink)` |
| Status: ready | `--color-success-*` family |
| Status: needs attention | `--color-warning-*` family |
| Status: fail / destructive | `--color-danger-*` family |
| Focus ring | `var(--shadow-focus)` |

For type: `--font-sans` for everything except code / IDs (`--font-mono`).
Headlines use `--letter-spacing-tight` (`-0.02em`); eyebrow / ALL-CAPS
labels use `--letter-spacing-wider` (`0.08em`).

For motion: `--duration-xs` (100 ms) for hover-color flips, `--duration-md`
(220 ms) for node enter / dialog rise, with `--ease-snappy` on anything
spatial.

## Origins

| Token group | Inspired by | Notes |
| --- | --- | --- |
| Neutrals (`--color-neutral-*`) | Strapi's `lightTheme` neutral0…neutral1000 (cool blue-tinted gray) | `neutral0` = `#ffffff`, `neutral100` = `#f6f6f9`, `neutral150` = `#eaeaef`, `neutral200` = `#dcdce4`, `neutral300` = `#c0c0cf`, `neutral500` = `#8e8ea9`, `neutral600` = `#666687`, `neutral700` = `#4a4a6a`, `neutral800` = `#32324d`, `neutral1000` = `#181826`. |
| Primary (`--color-primary-*`) | Strapi "blurple", base = `#4945ff` (`primary600`) | `primary100` = `#f0f0ff`, `primary200` = `#d9d8ff`, `primary500` = `#7b79ff`, `primary600` = `#4945ff`, `primary700` = `#271fe0` — direct port from `@strapi/design-system` `lightTheme`. |
| Success / Warning / Danger | Strapi's `success / warning / danger` ramps | Matched to the hex values already in `admin-shell.css` (`#16a34a`, `#92400e`, `#b91c1c`). |
| Surface / Ink / Border semantics | Strapi (`background`, `neutral100`, `neutral1000`) + chartdb (`--background`, `--foreground`, `--border`) | Names land on `--color-surface`, `--color-ink`, `--color-border` — shorter, monorepo-flavoured. |
| Radii / shadows / motion | Editorial design language already encoded in `visualizer.css` (10 px nodes, 14 px dialogs, `0.2, 0.8, 0.2, 1` easing) | Promoted to first-class tokens. |
| Dark theme | chartdb's `globals.css` `.dark` block | We don't copy chartdb's HSL values literally — they're tuned to its OKLCH base. Instead we hand-tuned slate-ish darks that still let `--color-primary-600` pop. |

## Back-compat layer

Legacy variables are kept as **aliases**, not deleted. The visualizer and
admin shell continue to work unchanged.

The following are now **superseded** by the canonical tokens — new code
should reference the right column instead.

### `--vz-*` (visualizer)

| Legacy | Superseded by |
| --- | --- |
| `--vz-ink` | `--color-ink` |
| `--vz-ink-dim` | `--color-ink-dim` |
| `--vz-ink-mute` | `--color-ink-mute` |
| `--vz-faint` | `--color-ink-faint` |
| `--vz-line` | `--color-border` |
| `--vz-line-strong` | `--color-border-strong` |
| `--vz-bg` | `--color-surface-strong` |
| `--vz-bg-soft` | `--color-surface-subtle` |
| `--vz-accent` | `--color-primary-600` |
| `--vz-accent-soft` | `--color-accent-soft` |
| `--vz-accent-ink` | `--color-accent-soft-ink` |
| `--vz-relation` | `--color-primary-600` |
| `--vz-uid` | (unique green — kept literal `#047857`) |
| `--vz-danger` | `--color-danger-700` |
| `--vz-danger-bg` | `--color-danger-soft` |
| `--vz-warn` | `--color-warning-800` |
| `--vz-warn-bg` | `--color-warning-soft` |

### `--hcms-*` (admin shell)

| Legacy | Superseded by |
| --- | --- |
| `--hcms-ink` | `--color-ink` |
| `--hcms-ink-dim` | `--color-ink-dim` |
| `--hcms-ink-mute` | `--color-ink-mute` |
| `--hcms-faint` | `--color-ink-faint` |
| `--hcms-line` | `--color-border` |
| `--hcms-line-strong` | `--color-border-strong` |
| `--hcms-bg` | `--color-surface-strong` |
| `--hcms-bg-soft` | `--color-surface-subtle` |
| `--hcms-accent` | `--color-primary-600` |
| `--hcms-accent-soft` | `--color-accent-soft` |
| `--hcms-accent-ink` | `--color-accent-soft-ink` |
| `--hcms-ok` | `--color-success-600` |
| `--hcms-ok-bg` | `--color-success-soft` |
| `--hcms-ok-ink` | `--color-success-soft-ink` |
| `--hcms-warn` | `--color-warning-800` |
| `--hcms-warn-bg` | `--color-warning-soft` |
| `--hcms-danger` | `--color-danger-700` |
| `--hcms-danger-bg` | `--color-danger-soft` |

> Note: the older `admin.css` / `index.css` shadcn token set
> (`--background`, `--foreground`, `--primary`, `--radius`, …) is **not**
> touched by this file and still functions. Over time those should also
> migrate to read from the canonical tokens; until then they coexist.

## Dark mode

Activate by setting `data-theme="dark"` on `<html>`:

```html
<html lang="en" data-theme="dark">
```

Only the semantic aliases flip (`--color-surface*`, `--color-ink*`,
`--color-border*`, soft fills, shadows). The raw `--color-primary-*` /
`--color-success-*` / `--color-warning-*` / `--color-danger-*` scales
**stay stable** so brand accent reads identically in both modes.

If you're styling something new, write it against the semantic aliases
and it will automatically support dark mode with zero extra work.
