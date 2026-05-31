#!/usr/bin/env python3
"""Seed pension_cases into Postgres from pension_corpus.json.
Requires: DATABASE_URL env var, SEED_TENANT_ID env var.
Install dep: pip install psycopg[binary]
Runs from anywhere with DB access (local or VM)."""
import json, os, pathlib, sys

try:
    import psycopg
except ImportError:
    sys.exit("psycopg not installed. Run: pip install 'psycopg[binary]'")

TENANT_ID = os.environ.get("SEED_TENANT_ID")


def main():
    if not os.environ.get("DATABASE_URL"):
        sys.exit("DATABASE_URL not set")
    if not TENANT_ID:
        sys.exit("SEED_TENANT_ID not set (the PB-001 AG office tenant UUID)")

    corpus_path = pathlib.Path(__file__).parent / "pension_corpus.json"
    corpus = json.loads(corpus_path.read_text())

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        inserted = 0
        for c in corpus:
            # Store present_docs and field_sources inside the fields jsonb
            # so the relay run route can read them without separate columns.
            fields = dict(c["fields"])
            fields["present_docs"] = c["present_docs"]
            fields["field_sources"] = c["field_sources"]

            cur.execute(
                """INSERT INTO pension_cases
                     (tenant_id, case_ref, pensioner_name, office_code, document_ids, fields, status)
                   VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb, 'pending_review')
                   ON CONFLICT DO NOTHING""",
                (
                    TENANT_ID,
                    c["case_ref"],
                    c["pensioner_name"],
                    c["office_code"],
                    json.dumps([]),
                    json.dumps(fields),
                ),
            )
            inserted += cur.rowcount
        conn.commit()

    print(f"Seeded {inserted}/{len(corpus)} pension cases for tenant {TENANT_ID}")
    if inserted < len(corpus):
        print(f"  ({len(corpus) - inserted} already existed — ON CONFLICT DO NOTHING)")


if __name__ == "__main__":
    main()
