import type { Context } from 'hono'
import { Hono } from 'hono'

type AppContext = Context<{ Bindings: Env }>

const app = new Hono<{ Bindings: Env }>()

async function readJson(c: AppContext): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json()
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return null
    }
    return body as Record<string, unknown>
  } catch {
    return null
  }
}

async function readName(c: AppContext): Promise<string | null> {
  const body = await readJson(c)
  const name = body?.name
  if (typeof name !== 'string') return null
  const trimmed = name.trim()
  return trimmed.length > 0 ? trimmed : null
}

app.get('/api/health', (c) => c.json({ status: 'ok' }))

app.post('/api/homes', async (c) => {
  const name = await readName(c)
  if (name === null) return c.json({ error: 'name is required' }, 422)

  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)').bind(id, name).run()
  return c.json({ id, name }, 201)
})

app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) return c.json({ error: 'home not found' }, 404)

  const name = await readName(c)
  if (name === null) return c.json({ error: 'name is required' }, 422)

  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO members (id, home_id, name) VALUES (?, ?, ?)')
    .bind(id, homeId, name)
    .run()
  return c.json({ id, homeId, name }, 201)
})

app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) return c.json({ error: 'home not found' }, 404)

  const body = await readJson(c)
  const title = typeof body?.title === 'string' ? body.title.trim() : ''
  const totalCents = body?.totalCents
  if (title.length === 0) {
    return c.json({ error: 'title is required' }, 422)
  }
  if (typeof totalCents !== 'number' || !Number.isSafeInteger(totalCents) || totalCents <= 0) {
    return c.json({ error: 'totalCents must be a positive whole number' }, 422)
  }

  const { results: members } = await c.env.DB.prepare(
    'SELECT id FROM members WHERE home_id = ? ORDER BY seq',
  )
    .bind(homeId)
    .all<{ id: string }>()
  if (members.length === 0) {
    return c.json({ error: 'home has no members' }, 422)
  }

  const billId = crypto.randomUUID()
  const base = Math.floor(totalCents / members.length)
  const extra = totalCents % members.length
  const shares = members.map((member, index) => ({
    id: crypto.randomUUID(),
    memberId: member.id,
    amountCents: base + (index < extra ? 1 : 0),
    paidAt: null,
  }))

  const insertBill = c.env.DB.prepare(
    'INSERT INTO bills (id, home_id, title, total_cents) ' + 'VALUES (?, ?, ?, ?)',
  ).bind(billId, homeId, title, totalCents)

  const insertShares = shares.map((share) =>
    c.env.DB.prepare(
      'INSERT INTO shares (id, bill_id, member_id, amount_cents) ' + 'VALUES (?, ?, ?, ?)',
    ).bind(share.id, billId, share.memberId, share.amountCents),
  )

  await c.env.DB.batch([insertBill, ...insertShares])

  return c.json({ id: billId, homeId, title, totalCents, shares }, 201)
})

type ShareRow = {
  id: string
  member_id: string
  amount_cents: number
  paid_at: string | null
  idempotency_key: string | null
}

const SELECT_SHARE =
  'SELECT id, member_id, amount_cents, paid_at, idempotency_key ' +
  'FROM shares WHERE id = ? AND bill_id = ?'

app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const key = c.req.header('Idempotency-Key')?.trim()
  if (!key) return c.json({ error: 'Idempotency-Key header is required' }, 400)

  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')

  const existing = await c.env.DB.prepare(SELECT_SHARE).bind(shareId, billId).first<ShareRow>()
  if (!existing) return c.json({ error: 'share not found' }, 404)

  // Only one request can flip paid_at from NULL, even if two run at once.
  await c.env.DB.prepare(
    'UPDATE shares SET paid_at = ?, idempotency_key = ? ' +
      'WHERE id = ? AND bill_id = ? AND paid_at IS NULL',
  )
    .bind(new Date().toISOString(), key, shareId, billId)
    .run()

  const share = await c.env.DB.prepare(SELECT_SHARE).bind(shareId, billId).first<ShareRow>()
  if (!share) return c.json({ error: 'share not found' }, 404)

  if (share.idempotency_key !== key) {
    return c.json({ error: 'share already paid with a different key' }, 409)
  }

  return c.json({
    id: share.id,
    memberId: share.member_id,
    amountCents: share.amount_cents,
    paidAt: share.paid_at,
  })
})

const BALANCES_SQL = `
  SELECT m.id AS memberId, m.name AS name,
    COALESCE(
      SUM(CASE WHEN s.paid_at IS NULL THEN s.amount_cents ELSE 0 END),
      0
    ) AS outstandingCents
  FROM members m
  LEFT JOIN shares s ON s.member_id = m.id
  WHERE m.home_id = ?
  GROUP BY m.id
  ORDER BY m.seq
`

app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) return c.json({ error: 'home not found' }, 404)

  const { results } = await c.env.DB.prepare(BALANCES_SQL)
    .bind(homeId)
    .all<{ memberId: string; name: string; outstandingCents: number }>()

  return c.json({ balances: results })
})

export default app
