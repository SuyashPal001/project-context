// FREE-AI Sutra 1 — FairnessGuard
// Orchestrates automated fairness checks on every agent response (chat + stream).
// All checks run non-blocking after the response has been sent to the client.

import { checkResponseBias } from './bias.js'
import { checkPolicyCompliance } from './policy.js'
import { captureEquityMetrics } from './equity.js'
import { fireFairnessAudit } from '../events.js'

export interface FairnessAuditInput {
  tenantId: string
  conversationId: string
  messageId: string
  agentId: string
  agentName: string
  responseText: string
  toolsUsed: number
}

type CheckStatus = 'pass' | 'warn' | 'fail'

function deriveOverall(statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes('fail')) return 'fail'
  if (statuses.includes('warn')) return 'warn'
  return 'pass'
}

export function runFairnessCheck(input: FairnessAuditInput): void {
  void (async () => {
    try {
      const bias   = checkResponseBias(input.responseText)
      const policy = checkPolicyCompliance(input.responseText)
      const equity = captureEquityMetrics(input.responseText.length, input.toolsUsed)

      const overallStatus = deriveOverall([bias.status, policy.status, equity.status])

      // Only store a snippet when something was flagged — avoids retaining clean response text
      const responseSnippet = overallStatus !== 'pass'
        ? input.responseText.slice(0, 150).replace(/\s+/g, ' ').trim()
        : undefined

      fireFairnessAudit({
        tenantId:        input.tenantId,
        conversationId:  input.conversationId,
        messageId:       input.messageId,
        agentId:         input.agentId,
        agentName:       input.agentName,
        overallStatus,
        checkResults:    [bias, policy, equity],
        responseLength:  equity.responseLength,
        toolsUsed:       equity.toolsUsed,
        responseSnippet,
      })

      if (overallStatus !== 'pass') {
        const failed = [bias, policy].filter(r => r.status !== 'pass')
        console.warn(`[fairness:Sutra1] ${overallStatus} tenantId=${input.tenantId} cid=${input.conversationId}`, JSON.stringify(failed))
      }
    } catch (err) {
      console.error('[fairness:Sutra1] check error:', (err as Error).message)
    }
  })()
}
