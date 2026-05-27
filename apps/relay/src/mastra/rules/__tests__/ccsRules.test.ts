import { describe, it, expect } from 'vitest';
import { evaluateRules, type RuleInput } from '../ccsRules.js';

const base: RuleInput = {
  qualifying_service_years: 33,
  last_pay: 54360,
  declared_pension: 27180,
  commutation_amount: 0,
  declared_dcrg: 0,
};

describe('evaluateRules', () => {
  it('passes R002 when declared matches the formula', () => {
    const results = evaluateRules(base);
    const r002 = results.find(r => r.ruleId === 'R002')!;
    expect(r002.status).toBe('pass');
  });

  it('fails R002 when declared pension is wrong', () => {
    const results = evaluateRules({ ...base, declared_pension: 23400 });
    const r002 = results.find(r => r.ruleId === 'R002')!;
    expect(r002.status).toBe('fail');
    expect(r002.calculated).toBe(27180);
    expect(r002.provision).toBe('CCS Pension Rules 1972, Rule 49(1)');
  });

  it('fails R001 when service under 10 years', () => {
    const results = evaluateRules({ ...base, qualifying_service_years: 8 });
    expect(results.find(r => r.ruleId === 'R001')!.status).toBe('fail');
  });

  it('fails R003 when commutation exceeds 40%', () => {
    const results = evaluateRules({ ...base, commutation_amount: 27180 * 0.47 });
    expect(results.find(r => r.ruleId === 'R003')!.status).toBe('fail');
  });

  it('returns cannot_evaluate when a required input is missing', () => {
    const partial = { ...base };
    delete (partial as Record<string, unknown>).last_pay;
    const r002 = evaluateRules(partial as RuleInput).find(r => r.ruleId === 'R002')!;
    expect(r002.status).toBe('cannot_evaluate');
  });
});
