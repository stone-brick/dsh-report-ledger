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
  import type { ReactElement } from 'react'

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
}
