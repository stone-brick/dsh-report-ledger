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
 * It is NOT resolvable from disk here: the package lives inside the deployed
 * shell's own bundle, not in the profile's `node_modules` layer that `tsconfig`
 * maps `@deepseek-ai/*` to. So the type has to be asserted rather than imported.
 *
 * This mirrors the choice already made in `client/index.ts`, which declares the
 * structural faces of `slots` and `locale` for the same reason: the shape below
 * is exactly what this plugin uses, and nothing more is claimed about it. Adding
 * a field here that the view then passes and the shell ignores would be a silent
 * no-op, so keep it to what is actually called.
 *
 * @module dsh-report-ledger/client/platform
 */

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { CSSProperties, ReactElement, ReactNode } from 'react'

  /** Presentational strings the renderer needs for the controls it owns. */
  export interface MarkdownLabels {
    /** Labels for the copy control on a rendered code block. */
    readonly code?: {
      /** Shown before the code is copied. */
      readonly copyLabel?: string
      /** Shown after the code is copied. */
      readonly copiedLabel?: string
    }
    /** Heading the renderer gives the footnote list. */
    readonly footnotes?: string
  }

  /** Props of the prose renderer, as this plugin calls it. */
  export interface MarkdownTextProps {
    /** The Markdown source. */
    readonly text: string
    /** Strings for the renderer's own controls. */
    readonly labels?: MarkdownLabels
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

  /** A static label chip. Tones come from the shell's own palette. */
  export function Tag(props: {
    readonly tone?: 'outline' | 'neutral' | 'quiet' | 'solid' | 'info' | 'success' | 'warning' | 'danger'
    readonly className?: string
    readonly children?: ReactNode
  }): ReactElement

  /** A hover label. Replaces `title` where the browser's own tooltip is too slow. */
  export function Tooltip(props: {
    readonly label: ReactNode
    readonly side?: 'top' | 'bottom' | 'left' | 'right'
    readonly delayMs?: number
    /** Skip the tooltip without changing the tree, e.g. when the text is not cut. */
    readonly disabled?: boolean
    readonly maxWidth?: number
    readonly children?: ReactNode
  }): ReactElement

  /** The shell's status dot: `ongoing` animates, the rest are coloured dots. */
  export function StateDot(props: {
    readonly state: 'ongoing' | 'idle' | 'done' | 'warning' | 'error' | 'failed'
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

  /** One of the shell's 16px outline icons. */
  export interface IconProps {
    readonly size?: number
    readonly className?: string
    readonly style?: CSSProperties
  }
  export function IconRefreshOutline16(props: IconProps): ReactElement
  export function IconChevronRightOutline14(props: IconProps): ReactElement
  export function IconChevronDownOutline14(props: IconProps): ReactElement
  export function IconCopyOutline16(props: IconProps): ReactElement
  export function IconCheckOutline16(props: IconProps): ReactElement

  /**
   * Copy text with the shell's own fallback chain.
   * @param text - the text to copy.
   * @returns whether the clipboard took it.
   */
  export function writeClipboard(text: string): Promise<boolean>
}
