import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { MastraServer } from '@mastra/hono'
import { mastra } from './mastra/index.js'
import { downloadMediaAttachment } from './media.js'
import { fireToolCallLog } from './events.js'
import { chatRouter } from './routes/chat.js'
import { sessionsRouter } from './routes/sessions.js'
import { internalRouter, initStudio } from './routes/internal.js'
import { explanationRouter } from './routes/explanation.js'
import { skillsRouter } from './routes/skills.js'
import { ingestRoute } from './routes/ingest.js'
import { composioRouter } from './routes/composio.js'
import { memoryInsightsRouter } from './routes/memoryInsights.js'

import {
  API_BASE_URL, sessions,
} from './types.js'
import type { RelaySessionCtx, DownloadedMedia } from './types.js'

const app = new Hono()

app.use('/studio/*', cors({
  origin: ['https://projectcontext.co', 'https://studio.projectcontext.co'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'x-mastra-client-type'],
  credentials: true,
}))

app.route('', internalRouter)
app.route('', chatRouter)
app.route('', sessionsRouter)
app.route('', explanationRouter)
app.route('', skillsRouter)
app.route('', ingestRoute)
app.route('', composioRouter)
app.route('', memoryInsightsRouter)


await initStudio(app)

export {
  app,
  API_BASE_URL,
  downloadMediaAttachment,
  fireToolCallLog,
  sessions,
}
export type { RelaySessionCtx, DownloadedMedia }
