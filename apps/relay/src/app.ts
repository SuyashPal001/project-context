import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { MastraServer } from '@mastra/hono'
import { mastra } from './mastra/index.js'
import { downloadMediaAttachment } from './media.js'
import { fireToolCallLog } from './events.js'
import { tasksRouter } from './routes/tasks.js'
import { pmRouter } from './routes/pm.js'
import { documentsRouter } from './routes/documents.js'
import { chatRouter } from './routes/chat.js'
import { sessionsRouter } from './routes/sessions.js'
import { internalRouter, initStudio } from './routes/internal.js'
import { schedulesRouter } from './routes/schedules.js'
import { explanationRouter } from './routes/explanation.js'
import {
  API_BASE_URL, sessions,
} from './types.js'
import type { RelaySessionCtx, DownloadedMedia } from './types.js'

const app = new Hono()

app.use('/studio/*', cors({
  origin: 'https://agent-studio.fitnearn.com',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'x-mastra-client-type'],
  credentials: true,
}))

app.route('', internalRouter)
app.route('', tasksRouter)
app.route('', pmRouter)
app.route('', documentsRouter)
app.route('', chatRouter)
app.route('', sessionsRouter)
app.route('', schedulesRouter)
app.route('', explanationRouter)

await initStudio(app)

export {
  app,
  API_BASE_URL,
  downloadMediaAttachment,
  fireToolCallLog,
  sessions,
}
export type { RelaySessionCtx, DownloadedMedia }
