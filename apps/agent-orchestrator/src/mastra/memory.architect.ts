import { Memory } from '@mastra/memory'
import { z } from 'zod'

import { getMastraStore, getMastraVector, embedder } from './memory.js'

export const architectMemory = new Memory({
  storage: getMastraStore(),
  vector: getMastraVector(),
  embedder,
  options: {
    lastMessages: 10,
    workingMemory: {
      enabled: true,
      scope: 'resource',
      schema: z.object({
        currentTask: z.string().optional(),
        filesDiscussed: z.array(z.string()).optional(),
        tablesInvolved: z.array(z.string()).optional(),
        patternsConfirmed: z.array(z.string()).optional(),
        patternsQuestioned: z.array(z.string()).optional(),
        openQuestions: z.array(z.string()).optional(),
        decisionsAudited: z.array(z.string()).optional(),
        riskFlags: z.array(z.string()).optional(),
      }),
    },
    semanticRecall: {
      topK: 3,
      messageRange: 2,
    },
  },
})
