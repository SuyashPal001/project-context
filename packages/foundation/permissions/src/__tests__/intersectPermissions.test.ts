import { describe, it, expect } from 'vitest'
import { intersectPermissions } from '../check'

describe('intersectPermissions', () => {
  it('returns only permissions present in both lists', () => {
    const keyPermissions = ['agent_tasks:create']
    const rolePermissions = ['agent_tasks:create', 'agent_tasks:delete', 'billing:read']
    expect(intersectPermissions(keyPermissions, rolePermissions)).toEqual(['agent_tasks:create'])
  })

  it('returns an empty array when there is no overlap', () => {
    const keyPermissions = ['billing:read']
    const rolePermissions = ['agent_tasks:create', 'agent_tasks:delete']
    expect(intersectPermissions(keyPermissions, rolePermissions)).toEqual([])
  })

  it('returns an empty array when the role has since lost a permission the key was scoped to', () => {
    // Role was downgraded after the key was issued — key must narrow automatically
    const keyPermissions = ['agent_tasks:create', 'billing:read']
    const rolePermissions = ['agent_tasks:create']
    expect(intersectPermissions(keyPermissions, rolePermissions)).toEqual(['agent_tasks:create'])
  })

  it('returns an empty array for an empty key permissions list', () => {
    expect(intersectPermissions([], ['agent_tasks:create'])).toEqual([])
  })

  it('does not duplicate a permission present twice in the role list', () => {
    const keyPermissions = ['agent_tasks:create']
    const rolePermissions = ['agent_tasks:create', 'agent_tasks:create']
    expect(intersectPermissions(keyPermissions, rolePermissions)).toEqual(['agent_tasks:create'])
  })
})
