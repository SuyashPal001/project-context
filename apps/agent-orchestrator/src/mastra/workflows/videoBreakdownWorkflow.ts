import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { breakDownLocalFile } from '../tools/videoBreakdown/breakDownVideo.js'

const step = createStep({ id: 'break-down-local', inputSchema: z.object({ filePath: z.string() }), outputSchema: z.any(), execute: async ({ inputData }) => breakDownLocalFile(inputData.filePath) })
// Golden-set target (spec §8a): runEvals / Studio experiments run the real breakdown on local fixture files.
export const videoBreakdownWorkflow = createWorkflow({ id: 'video-breakdown-local', inputSchema: z.object({ filePath: z.string() }), outputSchema: z.any() }).then(step).commit()
