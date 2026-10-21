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

interface LogLine {
  id: number
  raw: string
  level: LogLevel
}

const LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error']
const MAX_BUFFER = 5000
const MAX_RENDER = 1500
const ANSI_RE = /\x1B\[[0-9;]*m/g
const LEVEL_RE = /level=(trace|debug|info|warn|warning|error|fatal|panic)\b|\b(TRAC|DEBU|INFO|WARN|ERRO|FATA|PANI)\b/

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

export function LogPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation()
  const endpointURL = useStore(endpointURLAtom)
  const customURL = useStore(logEndpointURLAtom)
  const token = useStore(tokenAtom)

  const [lines, setLines] = useState<LogLine[]>([])
  const [paused, setPaused] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [keyword, setKeyword] = useState('')
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
    const line: LogLine = { id: idRef.current++, raw: clean, level: parseLevel(clean) }
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
        const res = await fetch(`${logURL}?tail=500`, {
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

  const visible = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    const filtered = lines.filter((l) => {
      const key = l.level === 'fatal' || l.level === 'panic' ? 'error' : l.level
      return enabled[key] && (!kw || l.raw.toLowerCase().includes(kw))
    })
    return filtered.slice(-MAX_RENDER)
  }, [lines, keyword, enabled])

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [visible, autoScroll])

  const download = useCallback(() => {
    const blob = new Blob([visible.map((l) => l.raw).join('\n')], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `dae-${new Date().toISOString().replace(/[:.]/g, '-')}.log`
    a.click()
    URL.revokeObjectURL(a.href)
  }, [visible])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[75vh] flex flex-col gap-3 p-4">
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
          <Input
            className="h-8 w-48"
            placeholder={t('logs.search')}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          {LEVELS.map((lv) => (
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
            <Button
              size="sm"
              variant={autoScroll ? 'default' : 'outline'}
              className="h-8"
              onClick={() => setAutoScroll((v) => !v)}
            >
              {t('logs.autoScroll')}
            </Button>
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

        <Input
          className="h-8 text-xs font-mono"
          value={customURL}
          placeholder={logURL}
          onChange={(e) => logEndpointURLAtom.set(e.target.value)}
          title={t('logs.endpoint')}
        />

        <div
          ref={scrollRef}
          className="flex-1 min-h-0 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-xs leading-5"
          onWheel={() => setAutoScroll(false)}
        >
          {visible.length === 0 ? (
            <div className="text-muted-foreground">{t('logs.empty')}</div>
          ) : (
            visible.map((l) => (
              <div key={l.id} className={cn('whitespace-pre-wrap break-all', LEVEL_CLASS[l.level])}>
                {l.raw}
              </div>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
