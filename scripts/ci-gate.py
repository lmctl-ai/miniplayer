"""Fail closed on every expected matrix leg, including missing/skipped jobs."""
import json, os, urllib.request
repo=os.environ['GITHUB_REPOSITORY'];run=os.environ['GITHUB_RUN_ID'];attempt=os.environ['GITHUB_RUN_ATTEMPT']
expected=json.loads(os.environ['EXPECTED_LEGS'])
url=f"https://api.github.com/repos/{repo}/actions/runs/{run}/attempts/{attempt}/jobs?per_page=100"
request=urllib.request.Request(url,headers={'Authorization':'Bearer '+os.environ['GH_TOKEN'],'Accept':'application/vnd.github+json'})
with urllib.request.urlopen(request) as response:jobs=json.load(response)['jobs']
rows=['| Leg | Result |','|---|---|'];ok=True
for name in expected:
    matches=[job for job in jobs if job['name']==name]
    result=matches[0].get('conclusion') if len(matches)==1 else 'missing or duplicate'
    ok=ok and result=='success'
    link=f"[{name}]({matches[0]['html_url']})" if len(matches)==1 else name
    rows.append(f'| {link} | {result} |')
summary='\n'.join(rows)+'\n';print(summary)
with open(os.environ['GITHUB_STEP_SUMMARY'],'a',encoding='utf-8') as output:output.write(summary)
raise SystemExit(0 if ok else 1)
