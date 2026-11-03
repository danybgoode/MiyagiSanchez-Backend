/**
 * Envia.com API client — backend copy.
 *
 * Mirrors apps/storefront/lib/envia.ts but lives in the Medusa backend
 * so all Envia calls originate server-side from one place.
 *
 * Auth:  ENVIA_API_KEY env var (Bearer token)
 * Env:   ENVIA_SANDBOX=true → api-test.envia.com  (default in dev)
 *        ENVIA_SANDBOX=false → api.envia.com       (production)
 */

function baseUrl(): string {
  const isSandbox =
    process.env.ENVIA_SANDBOX === 'true' ||
    (process.env.ENVIA_SANDBOX === undefined && process.env.NODE_ENV !== 'production')
  return isSandbox ? 'https://api-test.envia.com' : 'https://api.envia.com'
}

const DEFAULT_CARRIERS = ['dhl', 'fedex', 'estafeta', 'ups', 'redpack', 'paquetexpress']

function apiKey(): string {
  const key = process.env.ENVIA_API_KEY
  if (!key) throw new Error('Missing ENVIA_API_KEY environment variable')
  return key
}

async function enviaFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers ?? {}),
    },
  })
  if (!res.ok) {
    let detail = ''
    try { detail = JSON.stringify(await res.json()) } catch { /* ignore */ }
    throw new Error(`Envia API error ${res.status}: ${detail}`)
  }
  return res.json() as Promise<T>
}

// ── Address ───────────────────────────────────────────────────────────────────

export interface EnviaAddress {
  name: string
  company?: string
  email?: string
  phone?: string
  /** Street + number */
  street: string
  number?: string
  /** Colonia */
  district?: string
  city: string
  /** Envia 2-digit state code (e.g. "JA", "CX", "NL") */
  state: string
  country?: string
  postalCode: string
}

// ── Package ───────────────────────────────────────────────────────────────────

export interface EnviaPackage {
  content: string
  amount?: number
  type?: string
  weight: number
  declaredValue?: number
  dimensions?: { length: number; width: number; height: number }
}

function packageBody(p: EnviaPackage) {
  return {
    content: p.content,
    amount: p.amount ?? 1,
    type: p.type ?? 'box',
    weight: p.weight,
    insurance: 0,
    declaredValue: p.declaredValue ?? 0,
    weightUnit: 'KG',
    lengthUnit: 'CM',
    dimensions: p.dimensions ?? { length: 20, width: 15, height: 10 },
  }
}

// ── Quote ─────────────────────────────────────────────────────────────────────

export interface EnviaRate {
  rateId: string
  carrier: string
  service: string
  totalPrice: number
  currency: string
  deliveryEstimate: number | null
  logoUrl?: string
}

interface RawRate {
  rateId?: string
  carrier?: string
  service?: string
  serviceDescription?: string
  totalPrice?: number
  basePrice?: number
  currency?: string
  deliveryEstimate?: number | string | null
  deliveryDate?: { dateDifference?: number | string | null }
  carrierLogo?: string
  [key: string]: unknown
}

function selectedRateId(r: RawRate) {
  if (r.rateId) return String(r.rateId)
  if (r.carrier && r.service) return JSON.stringify({ carrier: r.carrier, service: r.service })
  return ''
}

function deliveryDays(r: RawRate): number | null {
  if (typeof r.deliveryEstimate === 'number') return r.deliveryEstimate
  const d = r.deliveryDate?.dateDifference
  if (typeof d === 'number') return d
  if (typeof d === 'string') { const n = Number(d); return Number.isFinite(n) ? n : null }
  return null
}

export interface QuoteParams {
  origin: EnviaAddress
  destination: EnviaAddress
  packages: EnviaPackage[]
  carriers?: string[]
}

export async function quoteShipments(params: QuoteParams): Promise<EnviaRate[]> {
  const base = {
    origin: { country: 'MX', ...params.origin },
    destination: { country: 'MX', ...params.destination },
    packages: params.packages.map(packageBody),
    settings: { currency: 'MXN' },
  }
  const carriers = params.carriers?.length ? params.carriers : DEFAULT_CARRIERS
  const settled = await Promise.allSettled(
    carriers.map(carrier =>
      enviaFetch<{ data?: RawRate[] }>('/ship/rate/', {
        method: 'POST',
        body: JSON.stringify({ ...base, shipment: { type: 1, carrier } }),
      })
    )
  )
  const rates = settled.flatMap((r, i) => {
    if (r.status === 'fulfilled') return r.value.data ?? []
    console.warn(`[envia-backend] quote failed for ${carriers[i]}:`, (r as PromiseRejectedResult).reason)
    return []
  })
  if (rates.length === 0) {
    const first = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (first) throw first.reason
  }
  return rates.map((r: RawRate) => ({
    rateId: selectedRateId(r),
    carrier: String(r.carrier ?? ''),
    service: String(r.serviceDescription ?? r.service ?? ''),
    totalPrice: Number(r.totalPrice ?? r.basePrice ?? 0),
    currency: String(r.currency ?? 'MXN'),
    deliveryEstimate: deliveryDays(r),
    logoUrl: r.carrierLogo as string | undefined,
  }))
}

// ── Create shipment ───────────────────────────────────────────────────────────

export interface CreateShipmentParams {
  origin: EnviaAddress
  destination: EnviaAddress
  packages: EnviaPackage[]
  rateId: string
  reference?: string
}

export interface CreatedShipment {
  enviaShipmentId: string
  carrier: string
  trackingNumber: string | null
  labelUrl: string | null
  estimatedDeliveryDate: string | null
  raw: Record<string, unknown>
}

function shipmentSelection(rateId: string) {
  try {
    const p = JSON.parse(rateId) as { carrier?: string; service?: string }
    if (p.carrier && p.service) return { type: 1, carrier: p.carrier, service: p.service }
  } catch { /* fall through */ }
  const [carrier, service] = rateId.split(':')
  if (carrier && service) return { type: 1, carrier, service }
  return { type: 1, rateId }
}

export async function createShipment(params: CreateShipmentParams): Promise<CreatedShipment> {
  const body = {
    origin:      { country: 'MX', ...params.origin },
    destination: { country: 'MX', ...params.destination },
    packages:    params.packages.map(packageBody),
    shipment:    shipmentSelection(params.rateId),
    settings: { printFormat: 'PDF', printSize: 'STOCK_4X6', comments: params.reference ?? '' },
  }
  const res = await enviaFetch<{
    data?: Record<string, unknown> | Array<Record<string, unknown>>
    [k: string]: unknown
  }>('/ship/generate/', { method: 'POST', body: JSON.stringify(body) })

  const d = Array.isArray(res.data) ? (res.data[0] ?? {}) : (res.data ?? {})
  const labelUrl = typeof d.label === 'string'
    ? d.label
    : (d.label as Record<string, string> | undefined)?.labelUrl
    ?? (d.label as Record<string, string> | undefined)?.url
    ?? null

  return {
    enviaShipmentId: String(d.shipmentId ?? ''),
    carrier: String(d.carrier ?? ''),
    trackingNumber: d.trackingNumber ? String(d.trackingNumber) : null,
    labelUrl,
    estimatedDeliveryDate: d.estimatedDeliveryDate ? String(d.estimatedDeliveryDate) : null,
    raw: res as Record<string, unknown>,
  }
}

// ── Error mapping ─────────────────────────────────────────────────────────────

export function mapEnviaError(msg: string): string {
  const m = msg.toLowerCase()
  if (m.includes('missing envia_api_key') || (m.includes('envia_api_key') && m.includes('missing')))
    return 'Configuración de envío incompleta en el servidor (ENVIA_API_KEY). Contacta al administrador.'
  if (m.includes('401') || m.includes('403') || m.includes('unauthorized'))
    return 'Error de autenticación con Envia. Verifica ENVIA_API_KEY.'
  if (m.includes('postal') || m.includes('zip'))
    return 'El código postal no es válido. Verifica e intenta de nuevo.'
  if (m.includes('coverage') || m.includes('cobertura') || m.includes('no service'))
    return 'Las paqueterías no tienen cobertura para ese código postal.'
  if (m.includes('timeout') || m.includes('network') || m.includes('econnrefused'))
    return 'No se pudo conectar con Envia. Intenta en unos momentos.'
  return 'No se pudo cotizar el envío. Verifica el código postal o coordina con el vendedor.'
}
