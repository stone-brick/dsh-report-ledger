/**
 * One report's detail: its transfer path, its thread links, and its body.
 *
 * Shared by the two surfaces that show a report — the conversation tab, where it
 * opens in place under its row, and the right column's canvas tab, where it opens
 * under the drawing. One implementation on purpose: the two are read side by
 * side, and the same report must not read differently in them.
 *
 * The two variants differ in exactly two ways, both about who owns the space:
 * a row's panel grows with the timeline's own scroll (so it has no inner scroll
 * box — a nested scroller would only steal the wheel), while a docked panel hands
 * over a finite height and the detail takes its share of it and scrolls inside.
 *
 * @module dsh-report-ledger/client/ReportDetailView
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Button,
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconCopyOutlineRegular,
  MarkdownText,
  StateDot,
  Tooltip,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HopAction, ReportDetail } from '../shared/wire.ts'
import { closeOpenFence, displayBody, shortId } from './timeline-model.ts'
import { COPIED_HOLD_MS, fill, stamp } from './format.ts'
import { HOP_LABEL } from './locales.ts'
import type { Translate } from './ReportsView.tsx'

/** Props for one report's detail. */
export interface ReportDetailViewProps {
  /** The report being shown. */
  readonly report: string
  /** The read result; `undefined` while the read is still in flight. */
  readonly detail: ReportDetail | undefined
  /** The failure code of the read, when it failed. */
  readonly error: string | undefined
  readonly t: Translate
  /** Full id plus session title, for the hover hints on session ids. */
  readonly idHint: (id: string) => string
  /** `domId` for a row's `aria-controls`; omitted inside a panel. */
  readonly id?: string
  /** How the box is dressed: a list row's inline panel, or a docked pane's detail. */
  readonly variant: 'row' | 'pane'
  /** Open another report: a thread link, or `undefined` for "back to the list". */
  readonly onOpenReport: (report: string | undefined) => void
  /** Whether this report belongs to the rendered list at all. */
  readonly inList: boolean
  /** Whether the current filter admits it; only meaningful when `inList`. */
  readonly visibleInFilter: boolean
  /** Show a collapse control in the pane's own header. */
  readonly onClose?: () => void
}

const time: Record<string, string | number> = {
  color: 'var(--dsw-alias-label-caption, #999)',
  fontSize: 'var(--dsw-font-xxxs-11, 11)',
  whiteSpace: 'nowrap',
}

/**
 * The same caption look, for content that must be allowed to WRAP.
 *
 * `time` sets `white-space: nowrap`, which is right for a timestamp and wrong for
 * anything whose length the ledger decides: a nowrap element's min-content width
 * is its whole unbreakable line, so inside a `1fr` grid track it grows the track
 * past its container. Recipient lists and hop notes are exactly that — which is
 * how the transfer path used to push the whole tab into a horizontal scrollbar.
 */
const wrap: Record<string, string | number> = {
  ...time,
  whiteSpace: 'normal',
  minWidth: 0,
  overflowWrap: 'anywhere',
}

/** The frame the rendered body sits in — a block, not a scroll box. */
const bodyFrame: Record<string, string | number> = {
  padding: '8px 10px',
  background: 'var(--dsw-alias-bg-base, rgba(0,0,0,0.02))',
  border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06))',
  borderRadius: '4px',
}

/** The footer line: ledger path plus its copy control. */
const pathRow: Record<string, string | number> = {
  ...wrap,
  marginTop: '6px',
  display: 'flex',
  alignItems: 'baseline',
  gap: '6px',
}

/** A row's inline panel: indented under its row, growing with the page. */
const rowBox: Record<string, string | number> = {
  margin: '4px 0 10px 24px',
  padding: '10px 12px',
  borderRadius: '6px',
  background: 'var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.03))',
  border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06))',
}

/**
 * How one hop reads in the rail.
 *
 * The four wire kinds on the canvas already own a colour semantics, so the path
 * reuses it rather than inventing a second one: a delivery is the business blue,
 * participation and acknowledgement are the success green, addressing (cc, copy)
 * is the quiet caption grey, and state changes take the warning ink.
 *
 * The dot's fill is the one non-colour cue: a **filled** dot is a hop that moved
 * or changed the report, a **hollow** one is addressing, observation or checkout
 * bookkeeping. Read in grayscale, the timeline still separates "what happened to
 * it" from "who merely saw it".
 */
const HOP_TONE: Readonly<Record<HopAction, { readonly colour: string; readonly emphasis: 'filled' | 'hollow' }>> = {
  authored: { colour: 'var(--dsw-alias-state-business-primary, #4176e6)', emphasis: 'filled' },
  contributed: { colour: 'var(--dsw-alias-state-success-primary, #1f9254)', emphasis: 'filled' },
  sent: { colour: 'var(--dsw-alias-state-business-primary, #4176e6)', emphasis: 'filled' },
  delivered: { colour: 'var(--dsw-alias-state-success-primary, #1f9254)', emphasis: 'hollow' },
  cc: { colour: 'var(--dsw-alias-label-caption, #70757d)', emphasis: 'hollow' },
  forwarded: { colour: 'var(--dsw-alias-state-business-primary, #4176e6)', emphasis: 'filled' },
  copied: { colour: 'var(--dsw-alias-label-caption, #70757d)', emphasis: 'hollow' },
  read: { colour: 'var(--dsw-alias-label-caption, #70757d)', emphasis: 'hollow' },
  acked: { colour: 'var(--dsw-alias-state-success-primary, #1f9254)', emphasis: 'filled' },
  leased: { colour: 'var(--dsw-alias-label-tertiary, #9aa0a8)', emphasis: 'hollow' },
  released: { colour: 'var(--dsw-alias-label-tertiary, #9aa0a8)', emphasis: 'hollow' },
  reclaimed: { colour: 'var(--dsw-alias-label-tertiary, #9aa0a8)', emphasis: 'hollow' },
  amended: { colour: 'var(--dsw-alias-state-warn-primary, #c77700)', emphasis: 'filled' },
  closed: { colour: 'var(--dsw-alias-label-caption, #70757d)', emphasis: 'filled' },
  reopened: { colour: 'var(--dsw-alias-state-warn-primary, #c77700)', emphasis: 'filled' },
  transferred: { colour: 'var(--dsw-alias-state-business-primary, #4176e6)', emphasis: 'filled' },
}

/** The rail: a list, because the hops are a sequence and a screen reader should hear one. */
const rail: Record<string, string | number> = {
  listStyle: 'none',
  margin: '0 0 8px',
  padding: 0,
}
const railItem: Record<string, string | number> = { display: 'flex', gap: '8px', alignItems: 'stretch' }
/** The dot-and-line column; `stretch` keeps the connector reaching the next row. */
const railSpine: Record<string, string | number> = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  width: '12px',
  flex: '0 0 12px',
  paddingTop: '4px',
}
/** A GitHub-style marker: a token-coloured ring; filled when the hop moved something. */
const railDot: Record<string, string | number> = {
  width: '10px',
  height: '10px',
  borderRadius: '50%',
  border: '2px solid currentColor',
  background: 'var(--dsw-alias-bg-layer-2, #fff)',
  boxSizing: 'border-box',
  flex: '0 0 auto',
}
/** The connector is always the neutral border, whatever the hop's colour is. */
const railSegment: Record<string, string | number> = {
  flex: '1 1 auto',
  borderLeft: '2px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))',
  margin: '2px 0 -2px',
  minHeight: '8px',
}
const railBody: Record<string, string | number> = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  flex: '1 1 auto',
  minWidth: 0,
  padding: '0 0 8px',
}
const railHead: Record<string, string | number> = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '6px',
  flexWrap: 'wrap',
}
/** The action label: a tinted chip — the colour lives in the fill, not in a border. */
const hopAction: Record<string, string | number> = {
  borderRadius: '4px',
  padding: '0 6px',
  fontSize: 'var(--dsw-font-xxxs-11, 11px)',
  fontWeight: 500,
  lineHeight: '16px',
  whiteSpace: 'nowrap',
}
/**
 * One session reference.
 *
 * The actor and every recipient share this exact chip. That is the point: an
 * arrow with plain text on one side and a boxed id on the other reads as if the
 * two ends were different kinds of thing, and they are not — both are sessions.
 */
const hopRef: Record<string, string | number> = {
  background: 'var(--dsw-alias-bg-layer-3, rgba(0,0,0,0.04))',
  borderRadius: '4px',
  padding: '0 5px',
  fontFamily: 'var(--dsw-font-family-mono, ui-monospace, monospace)',
  fontSize: 'var(--dsw-font-xxxs-11, 11px)',
  lineHeight: '16px',
  whiteSpace: 'nowrap',
}
const hopArrow: Record<string, string | number> = {
  color: 'var(--dsw-alias-label-tertiary, #aaa)',
  fontSize: '11px',
  margin: '0 -2px',
}
const hopNote: Record<string, string | number> = {
  ...time,
  whiteSpace: 'normal',
  overflowWrap: 'anywhere',
}

/** A docked panel's share: a column that owns its height and scrolls inside it. */
const pane: Record<string, string | number> = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  padding: '8px 12px 10px',
  borderTop: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08))',
  background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.02))',
}

const paneHead: Record<string, string | number> = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  marginBottom: '6px',
}

const paneBody: Record<string, string | number> = {
  flex: '1 1 auto',
  minHeight: 0,
  overflow: 'auto',
}

/**
 * Render one report: route, thread, body and path.
 * @param props - the read result, the copy seat, and how the box is dressed.
 * @returns the detail block.
 */
export function ReportDetailView(props: ReportDetailViewProps): ReactElement {
  const { report, detail, error, t, idHint, id, variant, onOpenReport, inList, visibleInFilter, onClose } = props
  const [copiedPath, setCopiedPath] = useState(false)
  const copyTimer = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined)
  useEffect(() => () => {
    if (copyTimer.current !== undefined) globalThis.clearTimeout(copyTimer.current)
  }, [])
  const shownBody = useMemo(() => displayBody(detail?.body ?? ''), [detail])
  // The text the renderer gets. A cut body can end mid-fence, and an unterminated
  // fence would turn the rest of the report into a code block — see `closeOpenFence`.
  // Only applied when the body was actually cut, so a whole body renders as written.
  const bodyText = useMemo(() => {
    const text = shownBody.text.trim()
    return shownBody.truncated ? closeOpenFence(text) : text
  }, [shownBody])
  /** Strings for the prose renderer's own controls, from this plugin's dictionary. */
  const markdownLabels = useMemo(
    () => ({ code: { copyLabel: t('body.copy'), copiedLabel: t('body.copied') }, footnotes: t('body.footnotes') }),
    [t],
  )
  /**
   * Copy the ledger path.
   *
   * Uses the shell's `writeClipboard` rather than `navigator.clipboard`, so the
   * plugin inherits whatever fallback chain the rest of the GUI relies on.
   */
  const copyPath = useCallback((path: string) => {
    void writeClipboard(path).then((ok) => {
      if (!ok) return
      setCopiedPath(true)
      if (copyTimer.current !== undefined) globalThis.clearTimeout(copyTimer.current)
      copyTimer.current = globalThis.setTimeout(() => { setCopiedPath(false) }, COPIED_HOLD_MS)
    })
  }, [])

  const link = (target: string): ReactElement => (
    <span key={target} style={{ marginRight: '6px' }}>
      <Tooltip label={fill(t('detail.openLinked'), { report: target })} side="bottom" delayMs={400}>
        <Button variant="outline" size="sm" onClick={() => { onOpenReport(target) }}>
          {target}
        </Button>
      </Tooltip>
    </span>
  )

  const content = (
    <>
      {error !== undefined ? <div style={{ color: 'var(--dsw-alias-state-error-primary, #b00)' }}>{t('view.error', { code: error })}</div> : null}
      {detail === undefined && error === undefined ? <div style={time}>{t('view.detail.loading')}</div> : null}
      {detail === undefined ? null : (
        <>
          <div style={{ marginBottom: '6px' }}><strong>{t('view.detail.route')}</strong></div>
          {detail.hops.length === 0 ? <div style={time}>{t('view.detail.routeEmpty')}</div> : (
            <ol style={rail}>
              {detail.hops.map((hop, hopIndex) => {
                const tone = HOP_TONE[hop.action]
                const last = hopIndex === detail.hops.length - 1
                return (
                  <li key={`h-${hopIndex}`} style={railItem}>
                    {/* The rail: a dot per hop and a segment toward the next one. The
                        segment carries the hop's dash, so a passive hop (cc, read) reads
                        as interrupted even in grayscale. */}
                    <span aria-hidden="true" style={{ ...railSpine, color: tone.colour }}>
                      <span style={{
                        ...railDot,
                        background: tone.emphasis === 'filled' ? tone.colour : 'var(--dsw-alias-bg-layer-2, #fff)',
                      }} />
                      {last ? null : <span style={railSegment} />}
                    </span>
                    <span style={railBody}>
                      <span style={railHead}>
                        <span style={{
                          ...hopAction,
                          color: tone.colour,
                          background: `color-mix(in srgb, ${tone.colour} 13%, transparent)`,
                        }}>
                          {t(HOP_LABEL[hop.action])}
                        </span>
                        <Tooltip label={idHint(hop.actor)} side="bottom" delayMs={400}>
                          <span style={hopRef}>{shortId(hop.actor)}</span>
                        </Tooltip>
                        {hop.to.length === 0 ? null : (
                          <>
                            <span aria-hidden="true" style={hopArrow}>→</span>
                            {hop.to.map((target) => (
                              <Tooltip key={target} label={idHint(target)} side="bottom" delayMs={400}>
                                <span style={hopRef}>{shortId(target)}</span>
                              </Tooltip>
                            ))}
                          </>
                        )}
                        <span style={{ flex: '1 1 auto' }} />
                        <span style={time}>{stamp(hop.at)}</span>
                      </span>
                      {hop.note === undefined ? null : <span style={hopNote}>{hop.note}</span>}
                    </span>
                  </li>
                )
              })}
            </ol>
          )}
          {/* "Still owed" is a state, so it gets the shell's state dot instead of a
              colour mixed by hand. */}
          {detail.pending.length === 0 ? null : (
            <div style={{ ...wrap, display: 'flex', alignItems: 'baseline', gap: '6px' }}>
              <StateDot state="warning" size={8} />
              <span>{fill(t('view.detail.pending'), { targets: detail.pending.join(', ') })}</span>
            </div>
          )}

          {(() => {
            const parent = detail.front.parent
            const children = detail.front.children
            if (parent === undefined && children.length === 0) return null
            return (
              <div style={{ marginBottom: '8px' }}>
                <strong>{t('detail.thread')}</strong>
                {parent === undefined ? null : (
                  <div style={{ marginTop: '2px' }}>
                    <span style={time}>{`${t('detail.parent')}: `}</span>{link(parent)}
                  </div>
                )}
                {children.length === 0 ? null : (
                  <div style={{ marginTop: '2px' }}>
                    <span style={time}>{`${t('detail.children')}: `}</span>{children.map(link)}
                  </div>
                )}
              </div>
            )
          })()}

          {/* Kept OUT of the thread block above: that block returns early when a
              report has no thread links, which is the common case for exactly the
              reports this notice is about. */}
          {inList ? null : (
            <div style={{ ...wrap, marginBottom: '8px' }}>
              {fill(t('detail.outside'), { report: detail.front.report })}
              {' '}
              <Button variant="outline" onClick={() => { onOpenReport(undefined) }}>
                {t('detail.backToList')}
              </Button>
            </div>
          )}
          {inList && !visibleInFilter ? (
            <div style={{ ...wrap, marginBottom: '8px' }}>
              {fill(t('detail.filteredOut'), { report: detail.front.report })}
            </div>
          ) : null}

          <div style={{ margin: '8px 0 4px' }}><strong>{t('view.detail.body')}</strong></div>
          {/* Rendered with the shell's own prose renderer — the same one the Chat
              and Trajectory views use — so a report body reads like everything
              else in the GUI instead of like a raw file. */}
          <div style={bodyFrame}>
            <MarkdownText text={bodyText} labels={markdownLabels} />
          </div>
          {shownBody.truncated ? (
            <div style={{ ...wrap, marginTop: '4px' }}>
              {fill(t('detail.bodyTruncated'), { chars: shownBody.text.trim().length })}
            </div>
          ) : null}
          {/* The ledger path is the longest string here and the only one with no
              spaces to break at, so it wraps mid-segment on purpose — and it has a
              copy control, because "see the file" is only useful if you can get
              there. */}
          <div style={pathRow}>
            <StateDot state="idle" size={6} />
            <span style={{ wordBreak: 'break-all' }}>{t('view.detail.path')}: {detail.path}</span>
            <Tooltip label={copiedPath ? t('body.copied') : t('view.copyPath')} side="bottom" delayMs={300}>
              <Button
                variant="ghost"
                size="sm"
                icon={copiedPath ? <IconCheckOutlineRegular size={16} /> : <IconCopyOutlineRegular size={16} />}
                aria-label={copiedPath ? t('body.copied') : t('view.copyPath')}
                onClick={() => { copyPath(detail.path) }}
              />
            </Tooltip>
          </div>
        </>
      )}
    </>
  )

  if (variant === 'pane') {
    return (
      <div style={pane}>
        <div style={paneHead}>
          <strong>{report}</strong>
          {onClose === undefined ? null : (
            <Button
              variant="ghost"
              size="sm"
              icon={<IconChevronDownOutlineRegular size={14} />}
              aria-label={fill(t('row.collapse'), { report })}
              onClick={onClose}
            />
          )}
        </div>
        <div style={paneBody}>{content}</div>
      </div>
    )
  }
  return <div id={id} style={rowBox}>{content}</div>
}
