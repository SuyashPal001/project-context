import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export type RuleInput = Record<string, number>;

export interface RuleResult {
  ruleId: string;
  ruleName: string;
  status: 'pass' | 'fail' | 'cannot_evaluate';
  provision: string;
  inputs: string[];
  declared: number | null;
  calculated: number | null;
  message: string;
}

interface RawRule {
  id: string; name: string; check: string; error: string; provision: string; inputs: string[];
}

const RULES_PATH = process.env.CCS_RULES_PATH
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../../ai-service/rules/pension/ccs_rules_1972.json');

let cached: RawRule[] | null = null;
function loadRules(): RawRule[] {
  if (!cached) cached = (JSON.parse(readFileSync(RULES_PATH, 'utf8')) as { rules: RawRule[] }).rules;
  return cached;
}

// Safe arithmetic evaluator: numbers, identifiers, + - * / ( ), abs(), min(), and one top-level comparison.
function evalArith(expr: string, vars: RuleInput): number {
  const tokens = expr.match(/min|abs|[A-Za-z_][A-Za-z0-9_]*|[0-9]+\.?[0-9]*|[+\-*/(),]/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  function parseExpr(): number {
    let v = parseTerm();
    while (peek() === '+' || peek() === '-') { const op = next(); const r = parseTerm(); v = op === '+' ? v + r : v - r; }
    return v;
  }
  function parseTerm(): number {
    let v = parseFactor();
    while (peek() === '*' || peek() === '/') { const op = next(); const r = parseFactor(); v = op === '*' ? v * r : v / r; }
    return v;
  }
  function parseFactor(): number {
    const t = next();
    if (t === '(') { const v = parseExpr(); next(); return v; }
    if (t === 'abs') { next(); const v = parseExpr(); next(); return Math.abs(v); }
    if (t === 'min') { next(); const a = parseExpr(); next(); const b = parseExpr(); next(); return Math.min(a, b); }
    if (t === '-') return -parseFactor();
    if (/^[0-9]/.test(t)) return parseFloat(t);
    if (!(t in vars)) throw new Error(`missing:${t}`);
    return vars[t];
  }
  return parseExpr();
}

function evalCheck(check: string, vars: RuleInput): boolean {
  const m = check.match(/^(.+?)\s*(>=|<=|<|>|==)\s*(.+)$/);
  if (!m) throw new Error('bad check');
  const lhs = evalArith(m[1], vars), rhs = evalArith(m[3], vars);
  switch (m[2]) {
    case '>=': return lhs >= rhs;
    case '<=': return lhs <= rhs;
    case '<':  return lhs < rhs;
    case '>':  return lhs > rhs;
    case '==': return lhs === rhs;
    default:   return false;
  }
}

export function evaluateRules(input: RuleInput): RuleResult[] {
  return loadRules().map((rule) => {
    const missing = rule.inputs.some(k => !(k in input) || typeof input[k] !== 'number');
    if (missing) {
      return {
        ruleId: rule.id, ruleName: rule.name, status: 'cannot_evaluate', provision: rule.provision,
        inputs: rule.inputs, declared: null, calculated: null, message: 'Missing required input.',
      };
    }
    let passed: boolean;
    try { passed = evalCheck(rule.check, input); }
    catch {
      return {
        ruleId: rule.id, ruleName: rule.name, status: 'cannot_evaluate', provision: rule.provision,
        inputs: rule.inputs, declared: null, calculated: null, message: 'Could not evaluate.',
      };
    }

    // Surface declared vs calculated for calculation rules (used by "show the math" UI).
    let declared: number | null = null, calculated: number | null = null;
    if (rule.id === 'R002') {
      declared = input.declared_pension;
      calculated = Math.round(input.last_pay * input.qualifying_service_years / 66);
    }
    if (rule.id === 'R004') {
      declared = input.declared_dcrg;
      calculated = Math.round(input.last_pay * Math.min(input.qualifying_service_years, 33) * 0.25);
    }

    return {
      ruleId: rule.id, ruleName: rule.name, status: passed ? 'pass' : 'fail', provision: rule.provision,
      inputs: rule.inputs, declared, calculated,
      message: passed ? `${rule.name}: pass.` : rule.error
        .replace('{calculated}', String(calculated))
        .replace('{calculated_dcrg}', String(calculated))
        .replace('{limit}', String(Math.round((input.declared_pension ?? 0) * 0.4)))
        .replace(/\{(\w+)\}/g, (_, k) => String(input[k] ?? '')),
    };
  });
}
