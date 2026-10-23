/**
 * Switching the conversation area to this plugin's report view.
 *
 * The shell exposes view selection in exactly one place: the `openView` prop it
 * hands to a mounted `conversation.view`. That is circular for us — the sidebar
 * canvas is not a view, and it needs the switch precisely when the report view is
 * **not** mounted. The per-session conversation store that actually holds the
 * selection is slot-private (`PropsStore<ConversationStore>`), and
 * `ctx.uiConversation` publishes registries and bindings but no view verb
 * (`binding(...).activate` activates an assembly target, not a tab).
 *
 * So this is the one honest way left: click the tab the shell rendered for us.
 * The label is the one we registered (`view.tab`), the hit is scoped to
 * `[role="tab"]`, and a label that is no longer on screen is a no-op rather than
 * an error — a host that hides the tab bar (fewer than two views) simply keeps
 * the request pending in the selection bridge.
 *
 * This is a documented compromise, not a pattern to copy: the day the shell
 * exposes a select-view verb, this file goes away and nothing else changes.
 *
 * @module dsh-report-ledger/client/report-tab
 */

/**
 * Bring the report view to the front, if the shell rendered a tab for it.
 * @param doc - the document to search (passed in so it can be faked in checks).
 * @param label - the view's label, as this plugin registered it.
 * @returns whether a tab was found. `true` also means "it is selected now",
 *   including when it already was.
 */
export function activateReportTab(doc: Document | undefined, label: string): boolean {
  if (doc === undefined) return false
  const tabs = Array.from(doc.querySelectorAll('[role="tab"]'))
  const matches = tabs.filter((candidate) => (candidate.textContent ?? '').trim() === label)
  // Any selected match settles it: a second tab with the same label (two hosts,
  // or a stale one mid-unmount) must not be clicked on top of the selected one.
  if (matches.some((tab) => tab.getAttribute('aria-selected') === 'true')) return true
  const target = matches[0]
  if (target === undefined) return false
  const clickable = target as HTMLElement
  if (typeof clickable.click !== 'function') return false
  clickable.click()
  return true
}
