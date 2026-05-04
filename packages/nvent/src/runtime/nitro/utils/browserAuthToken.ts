import { createHmac, timingSafeEqual } from 'node:crypto'

function b64urlEncode(input: string): string {
  return Buffer.from(input, 'utf-8').toString('base64url')
}

function b64urlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf-8')
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export interface BrowserAuthTokenPayload {
  iat: number
  exp: number
  request: {
    headers: Record<string, string>
    path?: string
  }
}

export function createBrowserAuthToken(payload: BrowserAuthTokenPayload, secret: string): string {
  const body = b64urlEncode(JSON.stringify(payload))
  const sig = sign(body, secret)
  return `${body}.${sig}`
}

export function verifyBrowserAuthToken(token: string, secret: string): BrowserAuthTokenPayload | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [body, sig] = parts

  const expected = sign(body, secret)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return null
  if (!timingSafeEqual(a, b)) return null

  try {
    const payload = JSON.parse(b64urlDecode(body)) as BrowserAuthTokenPayload
    if (!payload.exp || Date.now() / 1000 > payload.exp) return null
    return payload
  }
  catch {
    return null
  }
}
