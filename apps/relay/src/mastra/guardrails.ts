import { AsyncLocalStorage } from 'async_hooks'
import { API_BASE_URL } from '../types.js'

const INTERNAL_KEY = process.env.INTERNAL_SERVICE_KEY ?? ''

interface GuardrailCtx {
  tenantId: string
  conversationId: string
}

const _store = new AsyncLocalStorage<GuardrailCtx>()

export function runWithGuardrailContext<T>(ctx: GuardrailCtx, fn: () => Promise<T>): Promise<T> {
  return _store.run(ctx, fn)
}

interface Violation {
  processorId: string
  message: string
  detail: unknown
}

export function createViolationHandler() {
  return (v: Violation): void => {
    const ctx = _store.getStore()
    if (!ctx) return
    fetch(`${API_BASE_URL}/api/v1/internal/guardrails/log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-service-key': INTERNAL_KEY,
      },
      body: JSON.stringify({
        tenantId: ctx.tenantId,
        conversationId: ctx.conversationId,
        processorId: v.processorId,
        message: v.message,
        detail: v.detail,
      }),
    }).catch((err: Error) => {
      console.warn(`[guardrails] violation log failed (${v.processorId}):`, err.message)
    })
  }
}
