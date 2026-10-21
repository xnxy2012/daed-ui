import { useStore } from '@nanostores/react'
import { Download, Pause, Play, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '~/components/ui/sheet'
import { cn } from '~/lib/utils'
import { endpointURLAtom, logEndpointURLAtom, tokenAtom } from '~/store'

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'panic'

/** One new connection, parsed from dae's `msg="src <-> dst" key=value ...` log line. */
interface Conn {
  time: string
  network: string
  src: string
  dst: string
  host: string
  outbound: string
  dialer: string
  policy: string
  proc: string
  mac: string
}

interface LogLine {
  id: number
  raw: string
  level: LogLevel
  conn?: Conn
}

const LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error']
const MAX_BUFFER = 5000
const MAX_RENDER = 1500
const ANSI_RE = /\x1B\[[0-9;]*m/g
const LEVEL_RE = /level=(trace|debug|info|warn|warning|error|fatal|panic)\b|\b(TRAC|DEBU|INFO|WARN|ERRO|FATA|PANI)\b/
const KV_RE = /([A-Za-z_][\w.]*)=("(?:[^"\\]|\\.)*"|\S*)/g
const CONN_RE = /(\S+) <-> (\S+)/

const LEVEL_CLASS: Record<LogLevel, string> = {
  trace: 'text-muted-foreground',
  debug: 'text-muted-foreground',
  info: 'text-foreground',
  warn: 'text-yellow-600 dark:text-yellow-400',
  error: 'text-red-600 dark:text-red-400',
  fatal: 'text-red-600 dark:text-red-400 font-semibold',
  panic: 'text-red-600 dark:text-red-400 font-semibold',
}

function parseLevel(line: string): LogLevel {
  const m = LEVEL_RE.exec(line)
  if (!m) return 'info'
  const v = (m[1] || m[2]).toLowerCase()
  if (v.startsWith('trac')) return 'trace'
  if (v.startsWith('debu')) return 'debug'
  if (v.startsWith('warn')) return 'warn'
  if (v.startsWith('erro')) return 'error'
  if (v.startsWith('fata')) return 'fatal'
  if (v.startsWith('pani')) return 'panic'
  return 'info'
}

function unquote(v: string) {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string
    } catch {
      return v.slice(1, -1)
    }
  }
  return v
}

function parseKV(raw: string) {
  const out: Record<string, string> = {}
  for (const m of raw.matchAll(KV_RE)) out[m[1]] = unquote(m[2])
  return out
}

function parseConn(raw: string): Conn | undefined {
  if (!raw.includes(' <-> ')) return undefined
  const f = parseKV(raw)
  const m = CONN_RE.exec(f.msg ?? '')
  if (!m) return undefined
  return {
    time: f.time ?? '',
    network: f.network ?? f.l4proto ?? '',
    src: m[1],
    dst: m[2],
    host: f.sniffed ?? '',
    outbound: f.outbound ?? f.group ?? '',
    dialer: f.dialer ?? '',
    policy: f.policy ?? '',
    proc: f.pname ?? '',
    mac: f.mac ?? '',
  }
}

function outboundClass(name: string) {
  const n = name.toLowerCase()
  if (n === 'direct' || n === 'must_direct' || n === 'asis') return 'bg-green-500/15 text-green-700 dark:text-green-400'
  if (n === 'block' || n === 'reject') return 'bg-red-500/15 text-red-700 dark:text-red-400'
  return 'bg-blue-500/15 text-blue-700 dark:text-blue-400'
}

/** Default: the GraphQL endpoint with its path swapped to /logs (served by dae-wing, same port and auth). */
function deriveLogURL(graphqlURL: string) {
  try {
    const u = new URL(graphqlURL)
    u.pathname = u.pathname.replace(/graphql\/?$/, 'logs')
    u.search = ''
    return u.toString()
  } catch {
    return `${location.protocol}//${location.hostname}:2023/logs`
  }
}

function escapeRegExp(v: string) {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function highlight(raw: string, keyword: string) {
  const kw = keyword.trim()
  if (!kw) return raw
  const parts = raw.split(new RegExp(`(${escapeRegExp(kw)})`, 'gi'))
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded-sm bg-yellow-300 px-0.5 text-black dark:bg-yellow-500">
        {part}
      </mark>
    ) : (
      part
    ),
  )
}

function countBy(items: Conn[], pick: (c: Conn) => string) {
  const m = new Map<string, number>()
  for (const c of items) {
    const k = pick(c)
    if (k) m.set(k, (m.get(k) ?? 0) + 1)
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-0.5 text-xs whitespace-nowrap transition-colors',
        active ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted',
      )}
    >
      {children}
    </button>
  )
}

export function LogPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation()
  const endpointURL = useStore(endpointURLAtom)
  const customURL = useStore(logEndpointURLAtom)
  const token = useStore(tokenAtom)

  const [tab, setTab] = useState<'connections' | 'logs'>('connections')
  const [lines, setLines] = useState<LogLine[]>([])
  const [paused, setPaused] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [keyword, setKeyword] = useState('')
  const [outboundSel, setOutboundSel] = useState('')
  const [dialerSel, setDialerSel] = useState('')
  const [enabled, setEnabled] = useState<Record<LogLevel, boolean>>({
    trace: true,
    debug: true,
    info: true,
    warn: true,
    error: true,
    fatal: true,
    panic: true,
  })
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  const pausedRef = useRef(false)
  const pendingRef = useRef<LogLine[]>([])
  const idRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  const logURL = customURL || deriveLogURL(endpointURL)

  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  const push = useCallback((raw: string) => {
    const clean = raw.replace(ANSI_RE, '')
    if (!clean.trim()) return
    const line: LogLine = { id: idRef.current++, raw: clean, level: parseLevel(clean), conn: parseConn(clean) }
    if (pausedRef.current) {
      pendingRef.current.push(line)
      return
    }
    setLines((prev) => {
      const next = prev.length >= MAX_BUFFER ? prev.slice(prev.length - MAX_BUFFER + 1) : prev.slice()
      next.push(line)
      return next
    })
  }, [])

  // Stream via fetch so that the Authorization header can be sent (EventSource cannot).
  useEffect(() => {
    if (!open) return

    const controller = new AbortController()
    let retryTimer: ReturnType<typeof setTimeout> | undefined

    const connect = async () => {
      setStatus('connecting')
      setErrorMsg('')
      try {
        const res = await fetch(`${logURL}?tail=2000`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          signal: controller.signal,
        })
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
        setStatus('connected')

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx = buf.indexOf('\n')
          while (idx >= 0) {
            const row = buf.slice(0, idx).replace(/\r$/, '')
            buf = buf.slice(idx + 1)
            if (row.startsWith('data:')) push(row.slice(5).replace(/^ /, ''))
            idx = buf.indexOf('\n')
          }
        }
        throw new Error('stream closed')
      } catch (e) {
        if (controller.signal.aborted) return
        setStatus('error')
        setErrorMsg(e instanceof Error ? e.message : String(e))
        retryTimer = setTimeout(connect, 3000)
      }
    }

    connect()
    return () => {
      controller.abort()
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [open, logURL, token, push])

  const togglePause = useCallback(() => {
    setPaused((p) => {
      if (p && pendingRef.current.length) {
        const pending = pendingRef.current
        pendingRef.current = []
        setLines((prev) => [...prev, ...pending].slice(-MAX_BUFFER))
      }
      return !p
    })
  }, [])

  // ---- raw logs view
  const visibleLogs = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return lines
      .filter((l) => {
        const key = l.level === 'fatal' || l.level === 'panic' ? 'error' : l.level
        return enabled[key] && (!kw || l.raw.toLowerCase().includes(kw))
      })
      .slice(-MAX_RENDER)
  }, [lines, keyword, enabled])

  // ---- connections view
  const allConns = useMemo(() => lines.flatMap((l) => (l.conn ? [{ id: l.id, ...l.conn }] : [])), [lines])
  const outboundCounts = useMemo(() => countBy(allConns, (c) => c.outbound), [allConns])
  const dialerCounts = useMemo(() => countBy(allConns, (c) => c.dialer).slice(0, 12), [allConns])
  const visibleConns = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return allConns
      .filter((c) => {
        if (outboundSel && c.outbound !== outboundSel) return false
        if (dialerSel && c.dialer !== dialerSel) return false
        if (!kw) return true
        return [c.host, c.src, c.dst, c.outbound, c.dialer, c.policy, c.proc, c.mac, c.network].some((v) =>
          v.toLowerCase().includes(kw),
        )
      })
      .slice(-MAX_RENDER)
      .reverse() // newest first, like Clash / Surge
  }, [allConns, keyword, outboundSel, dialerSel])

  useEffect(() => {
    if (tab === 'logs' && autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [visibleLogs, autoScroll, tab])

  const download = useCallback(() => {
    let text: string
    let name: string
    if (tab === 'logs') {
      text = visibleLogs.map((l) => l.raw).join('\n')
      name = 'log'
    } else {
      const q = (v: string) => `"${v.replace(/"/g, '""')}"`
      const head = ['time', 'network', 'source', 'host', 'destination', 'outbound', 'dialer', 'policy', 'process', 'mac']
      text = [
        head.join(','),
        ...visibleConns.map((c) =>
          [c.time, c.network, c.src, c.host, c.dst, c.outbound, c.dialer, c.policy, c.proc, c.mac].map(q).join(','),
        ),
      ].join('\n')
      name = 'csv'
    }
    const blob = new Blob([text], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `dae-${new Date().toISOString().replace(/[:.]/g, '-')}.${name}`
    a.click()
    URL.revokeObjectURL(a.href)
  }, [tab, visibleLogs, visibleConns])

  const th = 'px-2 py-1.5 text-left font-medium whitespace-nowrap'
  const td = 'px-2 py-1 align-top'

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" size="full" className="h-[88vh] flex flex-col gap-3 p-4">
        <SheetHeader className="p-0">
          <SheetTitle className="flex items-center gap-2">
            {t('logs.title')}
            <span
              className={cn(
                'inline-block h-2 w-2 rounded-full',
                status === 'connected' && 'bg-green-500',
                status === 'connecting' && 'bg-yellow-500 animate-pulse',
                (status === 'error' || status === 'idle') && 'bg-red-500',
              )}
            />
            <span className="text-xs font-normal text-muted-foreground">
              {status === 'error' ? `${t('logs.disconnected')} (${errorMsg})` : t(`logs.${status}`)}
            </span>
          </SheetTitle>
        </SheetHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={tab === 'connections' ? 'default' : 'outline'}
            className="h-8"
            onClick={() => setTab('connections')}
          >
            {t('logs.tabConnections')} ({allConns.length})
          </Button>
          <Button size="sm" variant={tab === 'logs' ? 'default' : 'outline'} className="h-8" onClick={() => setTab('logs')}>
            {t('logs.tabLogs')}
          </Button>

          <Input
            className="h-8 w-64 max-w-full"
            placeholder={t('logs.search')}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          {keyword.trim() && (
            <span className="text-xs text-muted-foreground">
              {tab === 'logs' ? `${visibleLogs.length} / ${lines.length}` : `${visibleConns.length} / ${allConns.length}`}
            </span>
          )}

          {tab === 'logs' &&
            LEVELS.map((lv) => (
              <Button
                key={lv}
                size="sm"
                variant={enabled[lv] ? 'default' : 'outline'}
                className="h-8 px-2 text-xs uppercase"
                onClick={() => setEnabled((s) => ({ ...s, [lv]: !s[lv] }))}
              >
                {lv}
              </Button>
            ))}

          <div className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="outline" className="h-8 gap-1" onClick={togglePause}>
              {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              {paused ? t('logs.resume') : t('logs.pause')}
            </Button>
            {tab === 'logs' && (
              <Button
                size="sm"
                variant={autoScroll ? 'default' : 'outline'}
                className="h-8"
                onClick={() => setAutoScroll((v) => !v)}
              >
                {t('logs.autoScroll')}
              </Button>
            )}
            <Button size="sm" variant="outline" className="h-8" onClick={download}>
              <Download className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onClick={() => {
                setLines([])
                pendingRef.current = []
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {tab === 'connections' && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">{t('logs.colOutbound')}</span>
              <Chip active={!outboundSel} onClick={() => setOutboundSel('')}>
                {t('logs.all')}
              </Chip>
              {outboundCounts.map(([name, n]) => (
                <Chip key={name} active={outboundSel === name} onClick={() => setOutboundSel(outboundSel === name ? '' : name)}>
                  {name} · {n}
                </Chip>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">{t('logs.colDialer')}</span>
              <Chip active={!dialerSel} onClick={() => setDialerSel('')}>
                {t('logs.all')}
              </Chip>
              {dialerCounts.map(([name, n]) => (
                <Chip key={name} active={dialerSel === name} onClick={() => setDialerSel(dialerSel === name ? '' : name)}>
                  {name} · {n}
                </Chip>
              ))}
            </div>
          </div>
        )}

        <Input
          className="h-8 text-xs font-mono"
          value={customURL}
          placeholder={logURL}
          onChange={(e) => logEndpointURLAtom.set(e.target.value)}
          title={t('logs.endpoint')}
        />

        <div
          ref={scrollRef}
          className="flex-1 min-h-0 overflow-auto rounded-md border bg-muted/30 font-mono text-[13px] leading-6"
          onWheel={() => tab === 'logs' && setAutoScroll(false)}
        >
          {tab === 'logs' ? (
            <div className="p-2">
              {visibleLogs.length === 0 ? (
                <div className="text-muted-foreground">{t('logs.empty')}</div>
              ) : (
                visibleLogs.map((l) => (
                  <div key={l.id} className={cn('whitespace-pre-wrap break-all', LEVEL_CLASS[l.level])}>
                    {highlight(l.raw, keyword)}
                  </div>
                ))
              )}
            </div>
          ) : visibleConns.length === 0 ? (
            <div className="p-2 text-muted-foreground">{t('logs.emptyConnections')}</div>
          ) : (
            <table className="w-full border-collapse">
              <thead className="sticky top-0 z-10 bg-background text-xs text-muted-foreground shadow-[0_1px_0_0_var(--border)]">
                <tr>
                  <th className={th}>{t('logs.colTime')}</th>
                  <th className={th}>{t('logs.colNetwork')}</th>
                  <th className={th}>{t('logs.colSource')}</th>
                  <th className={th}>{t('logs.colDestination')}</th>
                  <th className={th}>{t('logs.colOutbound')}</th>
                  <th className={th}>{t('logs.colDialer')}</th>
                  <th className={th}>{t('logs.colPolicy')}</th>
                  <th className={th}>{t('logs.colProcess')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleConns.map((c) => (
                  <tr key={c.id} className="border-t border-border/50 hover:bg-muted/60">
                    <td className={cn(td, 'whitespace-nowrap text-muted-foreground')}>{c.time.replace(/^\w{3} \d+ /, '')}</td>
                    <td className={cn(td, 'uppercase')}>{c.network}</td>
                    <td className={cn(td, 'whitespace-nowrap')}>{highlight(c.src, keyword)}</td>
                    <td className={cn(td, 'max-w-[28rem] break-all')}>
                      {c.host ? (
                        <>
                          <div className="font-semibold">{highlight(c.host, keyword)}</div>
                          <div className="text-xs text-muted-foreground">{highlight(c.dst, keyword)}</div>
                        </>
                      ) : (
                        highlight(c.dst, keyword)
                      )}
                    </td>
                    <td className={td}>
                      {c.outbound && (
                        <span className={cn('rounded px-1.5 py-0.5 text-xs', outboundClass(c.outbound))}>
                          {highlight(c.outbound, keyword)}
                        </span>
                      )}
                    </td>
                    <td className={cn(td, 'whitespace-nowrap')}>{highlight(c.dialer, keyword)}</td>
                    <td className={cn(td, 'whitespace-nowrap text-muted-foreground')}>{c.policy}</td>
                    <td className={cn(td, 'whitespace-nowrap')}>
                      {highlight(c.proc || c.mac, keyword)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
