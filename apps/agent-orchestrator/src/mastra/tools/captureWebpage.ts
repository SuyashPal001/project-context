import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import puppeteer from 'puppeteer'
import { costMicro, isUnlimited, resolveRate, spendCredits } from '@serverless-saas/credits'
import { uploadGeneratedFile } from '../../persistence.js'
import { refundCaptureWebpageCharge } from './captureWebpageCredits.js'
import { shouldRequireApproval } from './generationApproval.js'
import { stableToolCallId } from '../../credits.js'
import { finishedAdTitle } from './fileTitle.js'

const CAPTURE_SUBJECT = 'capture-webpage'
const NAVIGATION_TIMEOUT_MS = 30_000

export const inputSchema = z.object({
  url: z.string().url().describe('A public page — never a logged-in portal. For a page behind login, the user provides a screen recording or a scripted Playwright session they log into themselves; this tool never stores credentials.'),
  width: z.number().int().min(640).max(2560).default(1920),
  height: z.number().int().min(480).max(2560).default(1080),
})

const outputSchema = z.object({
  fileId: z.string().optional(),
  name: z.string().optional(),
  fileType: z.string().optional(),
  size: z.number().optional(),
  refused: z.boolean().optional(),
  refusalReason: z.string().optional(),
  insufficientCredits: z.boolean().optional(),
  creditsUsedMicro: z.string().optional(),
  jobId: z.string().optional(),
})

// Wraps every IP address and email address found in a text node in a black
// redaction box (background black, text made transparent — the glyphs still
// occupy their original layout space, so nothing reflows) before the
// screenshot is taken. Runs inside the page via page.evaluate, not as a
// post-processing step on the image, so it sees the live-rendered DOM text
// exactly as the user would. A portal's own login page printed the caller's
// real IP address in the consulate demo (2026-10-14) — this exists because
// of that, not a hypothetical.
const REDACT_SCRIPT = `
(() => {
  const ipRe = /\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b/g
  const emailRe = /\\b[\\w.+-]+@[\\w-]+\\.[\\w.-]+\\b/g
  const box = (m) => '<span style="background:#000;color:transparent;border-radius:3px">' + m + '</span>'
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const nodes = []
  let n
  while ((n = walker.nextNode())) nodes.push(n)
  for (const node of nodes) {
    const text = node.nodeValue
    if (!text) continue
    ipRe.lastIndex = 0; emailRe.lastIndex = 0
    if (!ipRe.test(text) && !emailRe.test(text)) continue
    const span = document.createElement('span')
    span.innerHTML = text.replace(ipRe, box).replace(emailRe, box)
    node.parentNode && node.parentNode.replaceChild(span, node)
  }
})()
`

export const captureWebpage = createTool({
  id: 'capture-webpage',
  description: 'Headless-Chrome screenshot of a public page, with IP addresses and emails automatically redacted before capture. Never logs into a page — pass only public URLs.',
  inputSchema,
  outputSchema,
  requireApproval: async (_input, ctx) =>
    shouldRequireApproval({ resourceType: 'clip_assembly', subject: CAPTURE_SUBJECT }, ctx),
  execute: async (inputData, execContext) => {
    const { url, width, height } = inputData as z.infer<typeof inputSchema>

    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const agentId = execContext?.requestContext?.get('agentId') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const sessionId = conversationId ?? 'unknown'
    const toolCallId = execContext?.agent?.toolCallId ?? 'unknown'
    const jobId = `${conversationId ?? sessionId}:${stableToolCallId(toolCallId)}`

    if (!idToken) return { refused: true, refusalReason: 'SOURCE_UNAVAILABLE', jobId }

    const attempt = 0
    const chargeKey = `capture-webpage:${jobId}:${attempt}`
    let charged = false
    let rateId: string | null = null
    let rateVersion: number | null = null
    let amountMicro = 0n

    if (!(await isUnlimited(tenantId))) {
      const rate = await resolveRate('clip_assembly', CAPTURE_SUBJECT)
      if (!rate) {
        console.error(`[credits] UNBILLED CAPTURE WEBPAGE: no active clip_assembly/${CAPTURE_SUBJECT} rate tenantId=${tenantId} — generation was NOT charged`)
      } else {
        rateId = rate.id
        rateVersion = rate.version
        amountMicro = costMicro(rate.schema, { count: 1 })
        try {
          await spendCredits({
            tenantId, amountMicro: -amountMicro, key: chargeKey, kind: 'debit',
            actorId: agentId, actorType: 'agent', rateId, rateVersion, jobType: 'clip_assembly',
          })
          charged = true
        } catch (err) {
          if ((err as Error).name === 'InsufficientCreditsError') return { insufficientCredits: true, jobId }
          throw err
        }
      }
    }

    let buffer: Buffer
    let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined
    try {
      browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
      const page = await browser.newPage()
      await page.setViewport({ width, height })
      await page.goto(url, { waitUntil: 'networkidle2', timeout: NAVIGATION_TIMEOUT_MS })
      await page.evaluate(REDACT_SCRIPT)
      buffer = Buffer.from(await page.screenshot({ type: 'png' }))
    } catch (err) {
      console.error(`[session:${sessionId}] captureWebpage: capture failed:`, (err as Error).message)
      if (charged) await refundCaptureWebpageCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'CAPTURE_FAILED', jobId }
    } finally {
      await browser?.close().catch(() => {})
    }

    if (!conversationId) {
      if (charged) await refundCaptureWebpageCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'NO_SESSION_CONTEXT', jobId }
    }

    const attachment = await uploadGeneratedFile(idToken, {
      conversationId, title: finishedAdTitle(conversationId, 'Webpage Capture'), content: buffer,
      contentType: 'image/png', extension: 'png',
    })

    if (!attachment) {
      if (charged) await refundCaptureWebpageCharge(tenantId, agentId, chargeKey, rateId, rateVersion)
      return { refused: true, refusalReason: 'STORAGE_FAILED', jobId }
    }

    return {
      fileId: attachment.fileId, name: attachment.name, fileType: attachment.type, size: attachment.size,
      ...(charged ? { creditsUsedMicro: amountMicro.toString() } : {}),
      jobId,
    }
  },
})
