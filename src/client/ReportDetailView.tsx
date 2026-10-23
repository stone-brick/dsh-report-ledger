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

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Button,
  FileTypeIcon,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconCopyOutlineRegular,
  IconFolderOpenOutlineRegular,
  MarkdownText,
  Menu,
  StateDot,
  Tag,
  Tooltip,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HopAction, ReportDetail } from '../shared/wire.ts'
import { closeOpenFence, displayBody, shortId } from './timeline-model.ts'
import type { PathAction, PathOpener, WorkspacePathApplication } from './path-opener.ts'
import { COPIED_HOLD_MS, fill, stamp } from './format.ts'
import { HOP_LABEL, STATUS_LABEL, STATUS_TONE } from './locales.ts'
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
  /**
   * Resolve the host desktop's file verbs, lazily.
   *
   * A getter rather than a value: the Remote service arrives (and is replaced)
   * on the client root, so reading it per gesture is what keeps a late-mounted
   * deployment from losing the control. `undefined` means no opener at all —
   * the path row then keeps its plain copy control.
   */
  readonly opener?: () => PathOpener | undefined
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

/** The body's disclosure line, and the digest it shows while closed. */
const bodyHead: Record<string, string | number> = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '6px',
  margin: '8px 0 4px',
  flexWrap: 'wrap',
}
const digestLine: Record<string, string | number> = {
  display: 'inline-flex',
  alignItems: 'baseline',
  gap: '6px',
  flexWrap: 'wrap',
  color: 'var(--dsw-alias-label-caption, #70757d)',
  fontSize: 'var(--dsw-font-xxxs-11, 11px)',
}

/** The ledger file as a delivery card: type tile, two lines, one compact control. */
const fileCard: Record<string, string | number> = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  padding: '8px 10px',
  marginTop: '6px',
  borderRadius: '8px',
  background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.02))',
  border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.08))',
}
/** The delivery cards' file-type tile: white at 50% in light, 5% in dark (their rule). */
const fileTile: Record<string, string | number> = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '30px',
  height: '30px',
  borderRadius: '6px',
  background: 'var(--dsw-alias-bg-layer-3, rgba(0,0,0,0.05))',
  flex: '0 0 auto',
}
const fileName: Record<string, string | number> = {
  display: 'block',
  fontWeight: 500,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}
const filePath: Record<string, string | number> = {
  display: 'block',
  color: 'var(--dsw-alias-label-caption, #70757d)',
  fontSize: 'var(--dsw-font-xxxs-11, 11px)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}
/** The native control, one pill: default-app part and the picker part, divided. */
const split: Record<string, string | number> = {
  display: 'inline-flex',
  alignItems: 'stretch',
  borderRadius: '6px',
  border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.12))',
  overflow: 'hidden',
}
const splitPart: Record<string, string | number> = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '26px',
  height: '24px',
  padding: 0,
  border: 0,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
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
 * The ledger file, dressed as one of the GUI's delivery cards.
 *
 * The delivery cards in a finished turn are the shape this GUI uses for "here is
 * a file": a type icon in a rounded tile, the filename, one muted line, and a
 * compact native split control on the right. That is what a reader already knows
 * how to use, so the ledger file borrows it instead of inventing a row of outline
 * buttons — and the control inside is the same "open in default app + picker +
 * reveal" the shell's own cards carry (`path-opener.ts` explains why it is
 * re-built on the public Remote verbs rather than imported).
 *
 * Without a Host desktop the card still renders: the icon and the path are the
 * file, and copying the path stays available from the same menu.
 * @param props - the file to show and open, the lazy opener, and the translator.
 * @returns the file card.
 */
function OpenFileCard({ path, opener, t }: {
  readonly path: string
  readonly opener?: () => PathOpener | undefined
  readonly t: Translate
}): ReactElement {
  const [desktop, setDesktop] = useState<'unknown' | 'yes' | 'no'>('unknown')
  const [apps, setApps] = useState<readonly WorkspacePathApplication[] | null>(null)
  const [menu, setMenu] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const loading = useRef<AbortController | null>(null)
  const copiedTimer = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined)

  // Ask once whether a desktop is serving this page, and — when it is — start
  // reading the handlers too. The shell's own delivery cards load their desktop
  // metadata on mount for the same reason: the association query is the slow one
  // (measured at over a second here), and a dropdown that opens with two rows and
  // grows a moment later reads as broken.
  useEffect(() => {
    let cancelled = false
    const face = opener?.()
    if (face === undefined) {
      setDesktop('no')
      return () => { cancelled = true }
    }
    void face.available()
      .then((yes) => {
        if (cancelled) return
        setDesktop(yes ? 'yes' : 'no')
        if (!yes) return
        const controller = new AbortController()
        loading.current = controller
        void face.applications(path, controller.signal)
          .then((list) => { if (!controller.signal.aborted) setApps(list ?? []) })
          .catch(() => { if (!controller.signal.aborted) setApps([]) })
      })
      .catch(() => { if (!cancelled) setDesktop('no') })
    return () => {
      cancelled = true
      loading.current?.abort()
      if (copiedTimer.current !== undefined) globalThis.clearTimeout(copiedTimer.current)
    }
  }, [opener, path])

  // A menu opened before the prefetch settled still asks for them itself (a
  // failed prefetch must not leave an empty list forever), and says so while it
  // waits.
  useEffect(() => {
    if (!menu || apps !== null) return
    const face = opener?.()
    if (face === undefined) return
    loading.current?.abort()
    const controller = new AbortController()
    loading.current = controller
    void face.applications(path, controller.signal)
      .then((list) => { if (!controller.signal.aborted) setApps(list ?? []) })
      .catch(() => { if (!controller.signal.aborted) setApps([]) })
    return () => { controller.abort() }
  }, [apps, menu, opener, path])

  const act = useCallback((action: PathAction, application?: string) => {
    const face = opener?.()
    if (face === undefined) return
    setBusy(true)
    setFailed(false)
    setMenu(false)
    void face.open(path, action, application)
      .then((ok) => { if (!ok) setFailed(true) })
      .catch(() => { setFailed(true) })
      .finally(() => { setBusy(false) })
  }, [opener, path])

  const copy = useCallback(() => {
    setMenu(false)
    void writeClipboard(path).then((ok) => {
      if (!ok) return
      setCopied(true)
      if (copiedTimer.current !== undefined) globalThis.clearTimeout(copiedTimer.current)
      copiedTimer.current = globalThis.setTimeout(() => { setCopied(false) }, COPIED_HOLD_MS)
    })
  }, [path])

  const base = path.split(/[\\/]/).pop() ?? path
  const defaultApp = apps?.find((app) => app.default === true)
  const items: MenuEntry[] = desktop === 'yes'
    ? [
        { id: 'default', label: t('detail.openFile') },
        ...(apps === null
          ? [{ type: 'label' as const, id: 'loading', text: t('detail.openFileLoading') }]
          : apps.map((app): MenuEntry => ({
              id: `app:${app.id}`,
              label: app.name,
              ...(app.icon === null ? {} : { icon: <img src={app.icon} alt="" width={14} height={14} /> }),
            }))),
        { type: 'separator', id: 'sep-native' },
        { id: 'reveal', label: t('detail.revealFile') },
        { type: 'separator', id: 'sep-copy' },
        { id: 'copy', label: t('view.copyPath'), icon: <IconCopyOutlineRegular size={14} /> },
      ]
    : [{ id: 'copy', label: t('view.copyPath'), icon: <IconCopyOutlineRegular size={14} /> }]

  return (
    <div style={fileCard}>
      {/* The same file-type tile the delivery cards use. */}
      <span style={fileTile}>
        <FileTypeIcon path={path} size={18} />
      </span>
      <span style={{ flex: '1 1 auto', minWidth: 0 }}>
        <span style={fileName}>{t('view.detail.path')} · {base}</span>
        <span style={filePath} title={path}>
          {copied ? t('body.copied') : failed ? t('detail.openFileFailed') : path}
        </span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flex: '0 0 auto' }}>
        {desktop === 'yes' ? (
          <span style={split}>
            <Tooltip label={t('detail.openFile')} side="top" delayMs={400}>
              <button
                type="button"
                aria-label={t('detail.openFile')}
                disabled={busy}
                onClick={() => { act('open') }}
                style={splitPart}
              >
                {defaultApp !== undefined && defaultApp.icon !== null
                  ? <img src={defaultApp.icon} alt="" width={14} height={14} />
                  : <IconFolderOpenOutlineRegular size={14} />}
              </button>
            </Tooltip>
            <Menu
              open={menu}
              anchor={(
                <button
                  type="button"
                  aria-label={t('detail.openFileMenu')}
                  aria-expanded={menu}
                  disabled={busy}
                  onClick={() => { setMenu((current) => !current) }}
                  style={{ ...splitPart, borderLeft: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.12))' }}
                >
                  <IconChevronDownOutlineRegular size={14} />
                </button>
              )}
              items={items}
              align="end"
              portal
              onSelect={(id) => {
                if (id === 'default') act('open')
                else if (id === 'reveal') act('reveal')
                else if (id === 'copy') copy()
                else if (id.startsWith('app:')) act('open', id.slice('app:'.length))
              }}
              onClose={() => { setMenu(false) }}
            />
          </span>
        ) : (
          <button type="button" aria-label={t('view.copyPath')} title={t('view.copyPath')} onClick={copy} style={splitPart}>
            <IconCopyOutlineRegular size={14} />
          </button>
        )}
      </span>
    </div>
  )
}

/**
 * Render one report: route, thread, body and path.
 * @param props - the read result, the copy seat, and how the box is dressed.
 * @returns the detail block.
 */
export function ReportDetailView(props: ReportDetailViewProps): ReactElement {
  const { report, detail, error, t, idHint, id, variant, onOpenReport, inList, visibleInFilter, onClose, opener } = props
  const [bodyOpen, setBodyOpen] = useState(false)
  /** The panel id `aria-controls` points at; only claimed while the panel exists. */
  const bodyPanelId = `${id ?? 'report-ledger-detail'}-body`
  // A body that was open for one report must not stay open for the next one: the
  // disclosure is about the report under it, and a pane can switch reports in place.
  useEffect(() => { setBodyOpen(false) }, [report])
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

  const link = (target: string): ReactElement => (
    <span key={target} style={{ marginRight: '6px' }}>
      <Tooltip label={fill(t('detail.openLinked'), { report: target })} side="bottom" delayMs={400}>
        <Button variant="outline" size="sm" onClick={() => { onOpenReport(target) }}>
          {target}
        </Button>
      </Tooltip>
    </span>
  )

  /** One session reference, the same reading the list row uses. */
  const idRef = (target: string): ReactElement => (
    <Tooltip label={idHint(target)} side="bottom" delayMs={400}>
      <span>{shortId(target)}</span>
    </Tooltip>
  )

  /**
   * The collapsed body's stand-in: exactly what the front matter carries.
   *
   * The body is the long part of a report and the least often needed: a reader
   * scanning the ledger wants "who, to whom, how far, what happened last". That
   * is the digest, and it is what the closed body shows instead of a wall of
   * prose — the row above shows the same fields, and the pane variant (where
   * there is no row) relies on this line alone.
   */
  const digest = (front: ReportDetail['front']): ReactElement => (
    <span style={digestLine}>
      <Tag tone={STATUS_TONE[front.status]}>{t(STATUS_LABEL[front.status])}</Tag>
      <span>{'from='}{idRef(front.from)}</span>
      {front.to.length === 0 ? null : (
        <span>
          {' → '}
          {front.to.map((target, index) => (
            <Fragment key={target}>{index > 0 ? ', ' : ''}{idRef(target)}</Fragment>
          ))}
        </span>
      )}
      {front.cc.length === 0 ? null : (
        <span>
          {' cc '}
          {front.cc.map((target, index) => (
            <Fragment key={target}>{index > 0 ? ', ' : ''}{idRef(target)}</Fragment>
          ))}
        </span>
      )}
      <span>{` · ${fill(t('row.hops'), { count: front.hops })}`}</span>
      {front.last === undefined ? null : <span>{` · ${t('row.last')} ${t(HOP_LABEL[front.last.action])}`}</span>}
      {front.task === undefined ? null : <Tag tone="info">{front.task}</Tag>}
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

          <div style={bodyHead}>
            <Button
              variant="ghost"
              size="sm"
              icon={bodyOpen
                ? <IconChevronDownOutlineRegular size={14} />
                : <IconChevronRightOutlineRegular size={14} />}
              aria-expanded={bodyOpen}
              {...(bodyOpen ? { 'aria-controls': bodyPanelId } : {})}
              aria-label={bodyOpen ? t('detail.collapseBody') : t('detail.expandBody')}
              title={bodyOpen ? t('detail.collapseBody') : t('detail.expandBody')}
              onClick={() => { setBodyOpen((open) => !open) }}
            />
            <strong>{t('view.detail.body')}</strong>
            {bodyOpen ? null : digest(detail.front)}
          </div>
          {bodyOpen ? (
            <div id={bodyPanelId} style={bodyFrame}>
              {/* Rendered with the shell's own prose renderer — the same one the
                  Chat and Trajectory views use — so a report body reads like
                  everything else in the GUI instead of like a raw file. */}
              <MarkdownText text={bodyText} labels={markdownLabels} />
            </div>
          ) : null}
          {bodyOpen && shownBody.truncated ? (
            <div style={{ ...wrap, marginTop: '4px' }}>
              {fill(t('detail.bodyTruncated'), { chars: shownBody.text.trim().length })}
            </div>
          ) : null}
          {/* The ledger file, as the delivery card this GUI already uses for
              files: type tile, name, path, and the same native open control. */}
          <OpenFileCard path={detail.path} opener={opener} t={t} />
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
