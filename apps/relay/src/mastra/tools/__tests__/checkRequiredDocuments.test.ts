import { describe, it, expect } from 'vitest';
import { checkRequiredDocuments } from '../checkRequiredDocuments.js';

describe('checkRequiredDocuments', () => {
  it('passes when all required docs present', () => {
    const r = checkRequiredDocuments(['service_book', 'ppo_form', 'salary_certificate']);
    expect(r.complete).toBe(true);
    expect(r.missing).toEqual([]);
  });
  it('reports missing docs', () => {
    const r = checkRequiredDocuments(['service_book']);
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual(['ppo_form', 'salary_certificate']);
  });
});
