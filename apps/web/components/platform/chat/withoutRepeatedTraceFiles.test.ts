import { describe, it, expect } from 'vitest'
import { withoutRepeatedTraceFiles } from './ToolCallCard'

describe('withoutRepeatedTraceFiles', () => {
  it('drops a still that show_files repeats after its own generation, keeping the close-up', () => {
    const calls = [
      { toolName: 'generate_image', result: { fileId: 'full', name: 'Generated Image.jpeg', fileType: 'image/jpeg' } },
      { toolName: 'show_files', result: { files: [{ fileId: 'full', name: 'Generated Image.jpeg', fileType: 'image/jpeg' }, { fileId: 'crop', name: 'Close-up.jpg', fileType: 'image/jpeg' }] } },
    ]
    const out = withoutRepeatedTraceFiles(calls)
    expect(out).toHaveLength(2)
    expect((out[1].result!.files as Array<{ fileId: string }>).map(f => f.fileId)).toEqual(['crop'])
  })

  it('keeps show_files whole when nothing before it showed those files', () => {
    const calls = [{ toolName: 'show_files', result: { files: [{ fileId: 'full' }, { fileId: 'crop' }] } }]
    expect(withoutRepeatedTraceFiles(calls)).toEqual(calls)
  })

  it('keeps only the delegate files that were not already relayed one by one', () => {
    const calls = [
      { toolName: 'generate_image', result: { fileId: 'b1', name: 'Beat 1.png', fileType: 'image/png' } },
      { toolName: 'agent-director', result: { text: 'done', subAgentToolResults: [
        { toolName: 'generate_image', result: { fileId: 'b1', name: 'Beat 1.png', fileType: 'image/png' } },
        { toolName: 'check_clip', result: { passed: true } },
        { toolName: 'generate_image', result: { fileId: 'b2', name: 'Beat 2.png', fileType: 'image/png' } },
      ] } },
    ]
    const out = withoutRepeatedTraceFiles(calls)
    expect(out).toHaveLength(2)
    expect((out[1].result!.subAgentToolResults as Array<{ result: { fileId: string } }>).map(e => e.result.fileId)).toEqual(['b2'])
  })
})
