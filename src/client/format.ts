/**
 * The two text helpers both report surfaces need.
 *
 * Tiny and pure on purpose: `fill` is the `{name}` substitution every dictionary
 * template is written in, and `stamp` is the one timestamp format the ledger
 * uses. They live outside the views because there are now two of them — the
 * conversation tab and the right column's canvas tab — and a second copy of
 * either would be a second answer to the same question.
 *
 * @module dsh-report-ledger/client/format
 */

/** Substitute `{name}` placeholders, leaving unknown names alone. */
export function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole)
}

/** Format one timestamp for a timeline row or a hop. */
export function stamp(at: number | undefined): string {
  if (at === undefined || at <= 0) return ''
  return new Date(at).toLocaleString()
}

/** How long the path's copy control shows its "copied" state. */
export const COPIED_HOLD_MS = 1200
