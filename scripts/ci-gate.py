"""Require every native platform result, without eventually consistent REST calls."""
import json, os
expected=json.loads(os.environ['EXPECTED_LEGS'])
if not expected:raise SystemExit('expected legs must be nonempty')
needs=json.loads(os.environ['NEEDS_JSON'])
rows=['| Leg | Result |','|---|---|'];ok=True
for key,label in expected.items():
    result=needs.get(key,{}).get('result','missing')
    rows.append(f'| {label} | {result} |');ok=ok and result=='success'
for key in needs.keys()-expected.keys():
    rows.append(f"| {key} | unexpected leg: {needs[key].get('result')} |");ok=False
summary='\n'.join(rows)+'\n';print(summary)
with open(os.environ['GITHUB_STEP_SUMMARY'],'a',encoding='utf-8') as output:output.write(summary)
raise SystemExit(0 if ok else 1)
