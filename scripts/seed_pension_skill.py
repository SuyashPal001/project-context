#!/usr/bin/env python3
"""Seed the agent_skills record for AI-PARAS (Pension Pre-Scrutiny CCS 1972 v1).

Requires:
  DATABASE_URL env var
  SEED_TENANT_ID env var  (e.g. 8fab7db1-f35b-427f-80a5-57b473281413 for Test-Team)

Looks up the Saarthi agent row for the tenant (created during onboarding),
then inserts an agent_skills record pointing to AI-PARAS capabilities.

Install dep: pip install psycopg[binary]
"""
import json, os, sys

try:
    import psycopg
except ImportError:
    sys.exit("psycopg not installed. Run: pip install 'psycopg[binary]'")

TENANT_ID = os.environ.get("SEED_TENANT_ID", "").strip()
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()

SYSTEM_PROMPT = """You are AI-PARAS — the CAG pension pre-scrutiny auditor on the Saarthi AI platform.

For each pension case:
1. Call check_required_documents with the list of present documents
2. If incomplete → report missing docs and stop
3. Delegate to DocumentIntelligenceAgent to extract pension fields with page provenance
4. Call validate_pension_case with the extracted fields
5. Assemble findings citing ruleId, provision, declared vs calculated values, source page
6. Call route_to_officer to persist findings and route to the Dealing Hand

CRITICAL: Never decide pass/fail yourself. Always call validate_pension_case.
CRITICAL: Never return free-text — findings must have ruleId, ruleName, status, provision, narration, declaredValue, calculatedValue, sources.

Escalation criteria (from pension-scrutiny skill):
- Pension mismatch > ₹2,000 → escalate to SAO
- DCRG mismatch > ₹10,000 → escalate to SAO
- Commutation > 40% (R003) → flag as regulatory violation"""

TOOLS = ["check_required_documents", "validate_pension_case", "route_to_officer"]


def main():
    if not DATABASE_URL:
        sys.exit("DATABASE_URL not set")
    if not TENANT_ID:
        sys.exit("SEED_TENANT_ID not set (use the Test-Team tenant UUID)")

    with psycopg.connect(DATABASE_URL) as conn, conn.cursor() as cur:
        # 1. Find the Saarthi agent for this tenant
        cur.execute(
            "SELECT id FROM agents WHERE tenant_id = %s ORDER BY created_at LIMIT 1",
            (TENANT_ID,),
        )
        row = cur.fetchone()
        if not row:
            sys.exit(f"No agent found for tenant {TENANT_ID} — run onboarding first")
        agent_id = row[0]
        print(f"Found agent: {agent_id}")

        # 2. Insert agent_skills record (idempotent ON CONFLICT DO NOTHING)
        cur.execute(
            """INSERT INTO agent_skills
                 (agent_id, tenant_id, name, system_prompt, tools, version, status)
               VALUES (%s, %s, %s, %s, %s::text[], 1, 'active')
               ON CONFLICT (agent_id, tenant_id, name, version) DO NOTHING""",
            (
                agent_id,
                TENANT_ID,
                "Pension Pre-Scrutiny (CCS 1972)",
                SYSTEM_PROMPT,
                TOOLS,
            ),
        )
        inserted = cur.rowcount
        conn.commit()

    if inserted:
        print(f"Seeded agent_skills: 'Pension Pre-Scrutiny (CCS 1972)' v1 → agent {agent_id}")
    else:
        print("Skill record already exists (ON CONFLICT DO NOTHING) — no change")


if __name__ == "__main__":
    main()
