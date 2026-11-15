import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'

export const Route = createFileRoute('/')({
  component: Home,
})

type Share = {
  id: string
  memberId: string
  memberName: string
  amountCents: number
  paidAt: string | null
}

type Bill = {
  id: string
  title: string
  totalCents: number
  shares: Share[]
}

type HomeData = {
  home: { id: string; name: string }
  bills: Bill[]
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: HomeData }

type RequestOptions = {
  headers?: Record<string, string>
  body?: unknown
}

const STORAGE_KEY = 'billSplitter.homeId'
const TIMEOUT_MS = 10000

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'The request took too long. Please try again.'
  }
  if (error instanceof TypeError) {
    return 'Could not reach the server. Please try again.'
  }
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

function readError(parsed: unknown, status: number): string {
  if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
    const message = (parsed as { error: unknown }).error
    if (typeof message === 'string') return message
  }
  return `Request failed (${status})`
}

async function api<T>(
  method: 'GET' | 'POST',
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json', ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    })
    const text = await response.text()
    let parsed: unknown = null
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    if (!response.ok) throw new Error(readError(parsed, response.status))
    if (parsed === null) throw new Error('Unexpected response from server')
    return parsed as T
  } finally {
    clearTimeout(timer)
  }
}

function readStoredHomeId(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function storeHomeId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // Storage is only a convenience, so ignore failures.
  }
}

function markPaid(data: HomeData, shareId: string, paidAt: string | null): HomeData {
  return {
    ...data,
    bills: data.bills.map((bill) => ({
      ...bill,
      shares: bill.shares.map((share) => (share.id === shareId ? { ...share, paidAt } : share)),
    })),
  }
}

function Home() {
  const [initialId] = useState(readStoredHomeId)
  const [input, setInput] = useState(initialId)
  const [state, setState] = useState<LoadState>({ status: 'idle' })
  const [creating, setCreating] = useState(false)
  const [payingIds, setPayingIds] = useState<string[]>([])
  const [payErrors, setPayErrors] = useState<Record<string, string>>({})
  const latest = useRef(0)
  const lastId = useRef('')
  const keys = useRef(new Map<string, string>())

  const load = useCallback(async (id: string) => {
    latest.current += 1
    const requestId = latest.current
    lastId.current = id
    setState({ status: 'loading' })
    try {
      const path = `/api/homes/${encodeURIComponent(id)}/bills`
      const data = await api<HomeData>('GET', path)
      if (requestId === latest.current) setState({ status: 'ready', data })
    } catch (error) {
      if (requestId === latest.current) {
        setState({ status: 'error', message: errorMessage(error) })
      }
    }
  }, [])

  useEffect(() => {
    if (initialId) load(initialId)
  }, [initialId, load])

  function openHome(id: string) {
    const trimmed = id.trim()
    if (!trimmed) return
    storeHomeId(trimmed)
    setInput(trimmed)
    load(trimmed)
  }

  async function createDemoHome() {
    setCreating(true)
    try {
      const home = await api<{ id: string }>('POST', '/api/homes', {
        body: { name: 'Demo home' },
      })
      for (const name of ['Asha', 'Ben', 'Chitra']) {
        await api('POST', `/api/homes/${home.id}/members`, { body: { name } })
      }
      await api('POST', `/api/homes/${home.id}/bills`, {
        body: { title: 'Electricity', totalCents: 1000 },
      })
      openHome(home.id)
    } catch (error) {
      setState({ status: 'error', message: errorMessage(error) })
    } finally {
      setCreating(false)
    }
  }

  async function pay(billId: string, share: Share) {
    // Reusing the key on a retry makes the request safe to repeat.
    let key = keys.current.get(share.id)
    if (!key) {
      key = crypto.randomUUID()
      keys.current.set(share.id, key)
    }
    setPayingIds((ids) => [...ids, share.id])
    setPayErrors((prev) => ({ ...prev, [share.id]: '' }))
    try {
      const result = await api<{ paidAt: string | null }>(
        'POST',
        `/api/bills/${billId}/shares/${share.id}/pay`,
        { headers: { 'Idempotency-Key': key } },
      )
      keys.current.delete(share.id)
      setState((current) =>
        current.status === 'ready'
          ? {
              status: 'ready',
              data: markPaid(current.data, share.id, result.paidAt),
            }
          : current,
      )
    } catch (error) {
      setPayErrors((prev) => ({ ...prev, [share.id]: errorMessage(error) }))
    } finally {
      setPayingIds((ids) => ids.filter((id) => id !== share.id))
    }
  }

  return (
    <main
      style={{
        padding: 24,
        fontFamily: 'system-ui, sans-serif',
        maxWidth: 720,
      }}
    >
      <h1>Bill Splitter</h1>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          openHome(input)
        }}
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
      >
        <label htmlFor="home-id">Home ID</label>
        <input
          id="home-id"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          style={{ flex: 1, minWidth: 220 }}
        />
        <button type="submit">Load</button>
        <button type="button" disabled={creating} onClick={createDemoHome}>
          {creating ? 'Creating…' : 'Create demo home'}
        </button>
      </form>

      {state.status === 'idle' && <p>Enter a home ID, or create a demo home to try the page.</p>}

      {state.status === 'loading' && <p role="status">Loading bills…</p>}

      {state.status === 'error' && (
        <div role="alert">
          <p>Error: {state.message}</p>
          {lastId.current && (
            <button type="button" onClick={() => load(lastId.current)}>
              Try again
            </button>
          )}
        </div>
      )}

      {state.status === 'ready' && (
        <section>
          <h2>{state.data.home.name}</h2>
          {state.data.bills.length === 0 && <p>No bills yet for this home.</p>}
          {state.data.bills.map((bill) => (
            <article
              key={bill.id}
              style={{
                border: '1px solid #ccc',
                borderRadius: 8,
                padding: 12,
                marginBottom: 12,
              }}
            >
              <h3>
                {bill.title} — {formatCents(bill.totalCents)}
              </h3>
              <ul style={{ listStyle: 'none', padding: 0 }}>
                {bill.shares.map((share) => (
                  <li key={share.id} style={{ marginBottom: 8 }}>
                    {share.memberName}: {formatCents(share.amountCents)}{' '}
                    {share.paidAt ? (
                      <span>(paid)</span>
                    ) : (
                      <button
                        type="button"
                        disabled={payingIds.includes(share.id)}
                        onClick={() => pay(bill.id, share)}
                      >
                        {payingIds.includes(share.id) ? 'Paying…' : 'Pay'}
                      </button>
                    )}
                    {payErrors[share.id] && (
                      <div role="alert" style={{ color: 'crimson' }}>
                        Payment failed: {payErrors[share.id]}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </section>
      )}
    </main>
  )
}
