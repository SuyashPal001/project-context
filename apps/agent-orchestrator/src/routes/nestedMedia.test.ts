import { describe, it, expect } from 'vitest'
import { relayedDelegateMedia } from './nestedMedia.js'

describe('relayedDelegateMedia', () => {
  it('relays a finished image from inside a delegate, under a short stable id', () => {
    const nested = { type: 'tool-result', payload: { toolName: 'generate_image', toolCallId: 'gs.' + 'x'.repeat(4000), result: { fileId: 'b1', name: 'Beat 1.png', fileType: 'image/png' } } }
    const a = relayedDelegateMedia(nested)
    expect(a?.toolName).toBe('generate_image')
    expect(a?.result.fileId).toBe('b1')
    expect(a!.toolCallId.length).toBeLessThan(40)
    expect(relayedDelegateMedia(nested)?.toolCallId).toBe(a?.toolCallId)
  })
  it('skips non-media tools, failures and other chunks', () => {
    expect(relayedDelegateMedia({ type: 'tool-result', payload: { toolName: 'check_clip', toolCallId: 'c', result: { passed: true } } })).toBeNull()
    expect(relayedDelegateMedia({ type: 'tool-result', payload: { toolName: 'generate_image', toolCallId: 'c', result: { cancelled: true } } })).toBeNull()
    expect(relayedDelegateMedia({ type: 'finish', payload: {} })).toBeNull()
    expect(relayedDelegateMedia(undefined)).toBeNull()
  })
})
