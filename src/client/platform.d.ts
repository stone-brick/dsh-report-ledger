/**
 * Ambient types for the shell module the browser half renders prose with.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` is a **platform module**: the web shell
 * seeds it into the frozen module table that answers every `require` inside a
 * plugin's client bundle, which is where `MarkdownText` actually comes from at
 * runtime (the shipped Chat, Trajectory, deliverables and user-question views
 * all render text through it). It is deliberately external in
 * `tsdown.config.ts`.
 *
 * ⚠️ **This declaration shadows the real package.** In a DSH deployment the
 * package IS resolvable from `tsc`'s `@deepseek-ai/*` path — measured (R-0025):
 * a name that exists only here and not in the platform at all still typechecks,
 * because an ambient `declare module` for a resolvable package wins name
 * resolution. So the shapes below, not the shell's own `.d.ts`, are what every
 * call site is checked against, and a platform change is invisible to `tsc`.
 *
 * It is kept on purpose: a checkout without DSH installed at that path must
 * still typecheck, and taking the shell's package as a dependency is not an
 * option for a third-party plugin. The price is that every DSH upgrade needs a
 * manual re-read of the primitives' `lib/types`, checking at least:
 *
 *   - `MarkdownText` requires `labels`, whose `code` and `footnotes` are
 *     required (the memoized identity also matters: a new one drops its cache);
 *   - `Tag` takes tone / className / children ONLY — no `onClick`, no `title`;
 *   - `StateDot` states are `done | warning | ongoing | error | idle`;
 *   - `Button` / `Input` / `Pill` accept native element attributes (`Button` and
 *     `Input` forward refs);
 *   - `writeClipboard` returns `Promise<boolean>`;
 *   - `Menu` is owner-controlled (`open` + `onClose`), renders its `anchor` in
 *     place, and its `items` are data rows — `onSelect(id)` fires for a row, not
 *     for a separator or a label.
 *
 * The shape asserted below is exactly what this plugin uses, and nothing more:
 * adding a field here that the view then passes and the shell ignores would be a
 * silent no-op.
 *
 * @module dsh-report-ledger/client/platform
 */

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactElement, ReactNode } from 'react'

  /** Presentational strings the renderer needs for the controls it owns. */
  export interface MarkdownLabels {
    /** Labels for the copy control on a rendered code block. */
    readonly code: {
      /** Shown before the code is copied. */
      readonly copyLabel: string
      /** Shown after the code is copied. */
      readonly copiedLabel: string
    }
    /** Heading the renderer gives the footnote list. */
    readonly footnotes: string
  }

  /** Props of the prose renderer, as this plugin calls it. */
  export interface MarkdownTextProps {
    /** The Markdown source. */
    readonly text: string
    /** Strings for the renderer's own controls; pass a memoized object. */
    readonly labels: MarkdownLabels
  }

  /**
   * Render Markdown prose with the shell's own styling.
   * @param props - the source text and the label seat.
   * @returns the rendered block.
   */
  export function MarkdownText(props: MarkdownTextProps): ReactElement

  /**
   * The shell's button. `variant` defaults to `ghost`; the shipped views use
   * `outline` (secondary) and `primary` most.
   */
  export function Button(props: {
    readonly variant?: 'ghost' | 'outline' | 'primary'
    readonly size?: 'sm' | 'md'
    /** Leading glyph, rendered in its own span. */
    readonly icon?: ReactNode
    readonly className?: string
    readonly children?: ReactNode
    readonly disabled?: boolean
    /** Native attributes pass through — including the aria ones this view sets. */
    readonly onClick?: (event: { stopPropagation(): void }) => void
    readonly 'aria-label'?: string
    readonly 'aria-expanded'?: boolean
    readonly 'aria-controls'?: string
    readonly title?: string
  }): ReactElement

  /**
   * An interactive chip. Renders a real `<button>` when `onClick` is given and a
   * plain `<span>` otherwise, which is what makes it the right control for both
   * the toolbar's filter chips and the card's task shortcut.
   */
  export function Pill(props: {
    readonly active?: boolean
    readonly className?: string
    readonly children?: ReactNode
    readonly onClick?: (event: { stopPropagation(): void }) => void
    readonly title?: string
    readonly 'aria-pressed'?: boolean
  }): ReactElement

  /**
   * A static label chip. Tones come from the shell's own palette.
   *
   * Deliberately not interactive, and matching the platform here matters: the
   * real `Tag` takes no `onClick` and no `title`, so a clickable tag has to put
   * its handler on a child element (as the checkout chip does) or use `Pill`.
   */
  export function Tag(props: {
    readonly tone?: 'outline' | 'neutral' | 'quiet' | 'solid' | 'info' | 'success' | 'warning' | 'danger'
    readonly className?: string
    readonly children?: ReactNode
  }): ReactElement

  /** A hover label. Replaces `title` where the browser's own tooltip is too slow. */
  export function Tooltip(props: {
    readonly label: ReactNode
    readonly side?: 'top' | 'bottom' | 'right'
    readonly delayMs?: number
    /** Skip the tooltip without changing the tree, e.g. when the text is not cut. */
    readonly disabled?: boolean
    readonly maxWidth?: number
    readonly children?: ReactNode
  }): ReactElement

  /** The shell's status dot: `ongoing` animates, the rest are coloured dots. */
  export function StateDot(props: {
    readonly state: 'ongoing' | 'idle' | 'done' | 'warning' | 'error'
    readonly size?: number
    readonly className?: string
  }): ReactElement

  /** A text input with the shell's styling. Native input props pass through. */
  export function Input(props: {
    readonly icon?: ReactNode
    /**
     * Lands on the component's own WRAPPER, not on the `<input>` — which is what
     * lets a consumer size the whole control from its own stylesheet.
     */
    readonly className?: string
    readonly type?: string
    readonly value?: string
    readonly placeholder?: string
    readonly 'aria-label'?: string
    readonly onChange?: (event: { target: { value: string } }) => void
  }): ReactElement

  /**
   * One of the shell's outline icons.
   *
   * DSH 0.2.0 dropped the artboard size from the export name: a glyph is exported
   * size-neutral as `…Regular` (the supplied one-pixel artwork) or `…Medium` (the
   * same geometry at a 1.3px stroke), and `size` — defaulting to the glyph's own
   * drawn size — controls the rendered edge. Call sites keep the size explicit so
   * each control draws at exactly the dimension the removed numbered name pinned.
   */
  export interface IconProps {
    readonly size?: number
    readonly className?: string
  }
  export function IconRefreshOutlineRegular(props: IconProps): ReactElement
  export function IconChevronRightOutlineRegular(props: IconProps): ReactElement
  export function IconChevronDownOutlineRegular(props: IconProps): ReactElement
  export function IconCopyOutlineRegular(props: IconProps): ReactElement
  export function IconCheckOutlineRegular(props: IconProps): ReactElement
  export function IconFolderOpenOutlineRegular(props: IconProps): ReactElement

  /** One selectable row in a {@link Menu}. */
  export interface MenuItem {
    readonly id: string
    readonly label: ReactNode
    readonly disabled?: boolean
    /** Leading glyph. */
    readonly icon?: ReactNode
    readonly danger?: boolean
    readonly submenu?: readonly MenuEntry[]
  }
  /** A hairline between groups. */
  export interface MenuSeparator {
    readonly type: 'separator'
    readonly id: string
  }
  /** A non-interactive heading row. */
  export interface MenuLabel {
    readonly type: 'label'
    readonly id: string
    readonly text: string
  }
  /** One entry: a row, a separator, or a heading. */
  export type MenuEntry = MenuItem | MenuSeparator | MenuLabel

  /**
   * The shell's anchored dropdown.
   *
   * Owner-controlled: `open` decides, `onClose` reports an outside click or
   * Escape, `onSelect(id)` reports a chosen row. `anchor` is rendered in place,
   * so the owner supplies its own trigger; `portal` lifts the list out of a
   * clipping ancestor, which a detail panel with `overflow: auto` needs.
   */
  export function Menu(props: {
    readonly open: boolean
    readonly anchor: ReactNode
    readonly items?: readonly MenuEntry[]
    readonly children?: ReactNode
    readonly selectedId?: string
    readonly onSelect?: (id: string) => void
    readonly onClose: () => void
    readonly align?: 'start' | 'end'
    readonly side?: 'bottom' | 'top' | 'right'
    readonly portal?: boolean
    readonly dense?: boolean
    readonly compact?: boolean
    readonly autoFocus?: boolean
  }): ReactElement

  /**
   * Copy text with the shell's own fallback chain.
   * @param text - the text to copy.
   * @returns whether the clipboard took it.
   */
  export function writeClipboard(text: string): Promise<boolean>
}
