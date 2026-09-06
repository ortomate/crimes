#!/usr/bin/env python3
"""Compare complete JSON reports from two built CLIs on identical roots and clock."""
import argparse
import json
import os
from pathlib import Path
import subprocess


def apply_expected_text_changes(report, changes):
    """Replace only declared complete prose strings; retain every other byte of JSON data."""
    encoded=json.dumps(report,ensure_ascii=False)
    for before,after in changes.items():
        encoded=encoded.replace(json.dumps(before,ensure_ascii=False)[1:-1],json.dumps(after,ensure_ascii=False)[1:-1])
    return json.loads(encoded)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--before',type=Path,required=True)
    p.add_argument('--after',type=Path,required=True)
    p.add_argument('--cases',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--node',default='node')
    p.add_argument('--expected-text-changes',type=Path,help='Explicit old-to-new prose map; exact equality is still reported separately')
    args=p.parse_args()
    env={**os.environ,'CI':'true','CRIMES_NOW':'2026-09-07T00:00:00Z'}
    changes=json.loads(args.expected_text_changes.read_text()) if args.expected_text_changes else {}
    if not isinstance(changes,dict) or any(not isinstance(k,str) or not k or not isinstance(v,str) for k,v in changes.items()):
        p.error('Expected a map of nonempty source prose to replacement prose')
    rows=[]
    for case in json.loads(args.cases.read_text()):
        root=str(Path(case['root']).resolve())
        for command,options in [('scan',['scan',root,'--format','json']),('context',['context',case['target'],'--root',root,'--format','json']),('hook',['hook','--format','claude'])]:
            reports=[]
            for cli in [args.before,args.after]:
                stdin=json.dumps({'hook_event_name':'PreToolUse','cwd':root,'tool_input':{'file_path':case['target']}}) if command=='hook' else ''
                r=subprocess.run([args.node,str(cli.resolve()),*options],input=stdin,text=True,capture_output=True,cwd=root,env=env,timeout=180,check=True)
                reports.append(json.loads(r.stdout))
            exact_equal=reports[0]==reports[1]
            equal=apply_expected_text_changes(reports[0],changes)==reports[1]
            rows.append({'case':case['id'],'command':command,'equal':exact_equal,'equal_with_declared_text_changes':equal})
            args.output.write_text(json.dumps({'reference_clock':env['CRIMES_NOW'],'expected_text_changes':changes,'rows':rows},indent=2)+'\n')
            if not equal:
                for index,report in enumerate(reports):
                    args.output.with_name(f'drift-{case["id"]}-{command}-{index}.json').write_text(json.dumps(report,indent=2)+'\n')
                raise RuntimeError(f'Report drift: {case["id"]} {command}; inspect saved reports')
            status='identical' if exact_equal else 'only declared prose differs'
            print(f'{case["id"]} {command}: {status}',flush=True)


if __name__=='__main__':
    main()
