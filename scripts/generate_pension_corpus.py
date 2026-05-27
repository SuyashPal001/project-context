#!/usr/bin/env python3
"""Generate the 5-case synthetic pension corpus for the AI-PARAS demo.
Config-driven: edit CASES to change the demo set. No external dependencies."""
import json, pathlib

CASES = [
    # 1. Harbhajan Singh — R002 fail (declared != calculated). Live-run climax case.
    {
        "case_ref": "PPO/PB/2019/00847",
        "pensioner_name": "Sh. Harbhajan Singh (Retd. Naib Tehsildar)",
        "office_code": "PB-001",
        "present_docs": ["service_book", "ppo_form", "salary_certificate"],
        "fields": {
            "qualifying_service_years": 33, "last_pay": 54360,
            "declared_pension": 23400, "commutation_amount": 0, "declared_dcrg": 448470,
        },
        "field_sources": {
            "last_pay":                 {"sourceDoc": "Service Book", "sourcePage": 4},
            "qualifying_service_years": {"sourceDoc": "Service Book", "sourcePage": 2},
            "declared_pension":         {"sourceDoc": "PPO Form",     "sourcePage": 1},
        },
    },
    # 2. Kulwinder Kaur — all pass (clean). declared_pension == round(last_pay*service/66)
    {
        "case_ref": "PPO/PB/2021/01134",
        "pensioner_name": "Smt. Kulwinder Kaur (Retd. Clerk Grade-I)",
        "office_code": "PB-001",
        "present_docs": ["service_book", "ppo_form", "salary_certificate"],
        "fields": {
            "qualifying_service_years": 30, "last_pay": 41250,
            "declared_pension": 18750, "commutation_amount": 5000, "declared_dcrg": 309375,
        },
        "field_sources": {
            "last_pay":                 {"sourceDoc": "Service Book", "sourcePage": 3},
            "qualifying_service_years": {"sourceDoc": "Service Book", "sourcePage": 2},
        },
    },
    # 3. Gurpreet Singh — R003 fail (commutation 47% > 40%).
    {
        "case_ref": "PPO/PB/2020/00512",
        "pensioner_name": "Sh. Gurpreet Singh (Retd. Asst. Engineer)",
        "office_code": "PB-001",
        "present_docs": ["service_book", "ppo_form", "salary_certificate"],
        "fields": {
            "qualifying_service_years": 28, "last_pay": 70800,
            "declared_pension": 30036, "commutation_amount": 14117, "declared_dcrg": 495600,
        },
        "field_sources": {
            "declared_pension":    {"sourceDoc": "PPO Form", "sourcePage": 1},
            "commutation_amount":  {"sourceDoc": "PPO Form", "sourcePage": 2},
        },
    },
    # 4. Mohan Lal — R001 fail (only 8 years service).
    {
        "case_ref": "PPO/PB/2022/00298",
        "pensioner_name": "Sh. Mohan Lal (Retd. Peon)",
        "office_code": "PB-001",
        "present_docs": ["service_book", "ppo_form", "salary_certificate"],
        "fields": {
            "qualifying_service_years": 8, "last_pay": 22000,
            "declared_pension": 2667, "commutation_amount": 0, "declared_dcrg": 44000,
        },
        "field_sources": {
            "qualifying_service_years": {"sourceDoc": "Service Book", "sourcePage": 2},
        },
    },
    # 5. Rajwinder Kaur — all pass (clean). declared_pension == round(last_pay*service/66)
    {
        "case_ref": "PPO/PB/2021/00876",
        "pensioner_name": "Smt. Rajwinder Kaur (Retd. Steno)",
        "office_code": "PB-001",
        "present_docs": ["service_book", "ppo_form", "salary_certificate"],
        "fields": {
            "qualifying_service_years": 25, "last_pay": 39600,
            "declared_pension": 15000, "commutation_amount": 4000, "declared_dcrg": 247500,
        },
        "field_sources": {
            "last_pay": {"sourceDoc": "Service Book", "sourcePage": 3},
        },
    },
]


def main():
    out = pathlib.Path(__file__).parent / "pension_corpus.json"
    out.write_text(json.dumps(CASES, indent=2, ensure_ascii=False))

    # Sanity print of R002 calc for each case
    print(f"{'Case Ref':<28} {'Declared':>10} {'Calc R002':>10}  Match?")
    print("-" * 60)
    for c in CASES:
        f = c["fields"]
        calc = round(f["last_pay"] * f["qualifying_service_years"] / 66)
        match = "MATCH ✓" if abs(f["declared_pension"] - calc) < 100 else "MISMATCH ✗"
        print(f'{c["case_ref"]:<28} {f["declared_pension"]:>10,} {calc:>10,}  {match}')

    print(f"\nWrote {out} ({len(CASES)} cases)")


if __name__ == "__main__":
    main()
