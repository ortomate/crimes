#!/usr/bin/env python3
"""Compare complete JSON reports from two built CLIs on identical roots and clock."""
import argparse
import json
import os
from pathlib import Path
import subprocess


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--before',type=Path,required=True)
    p.add_argument('--after',type=Path,required=True)
    p.add_argument('--cases',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--node',default='node')
    args=p.parse_args()
    env={**os.environ,'CI':'true','CRIMES_NOW':'2026-09-07T00:00:00Z'}
    rows=[]
    for case in json.loads(args.cases.read_text()):
        root=str(Path(case['root']).resolve())
        for command,options in [('scan',['scan',root,'--format','json']),('context',['context',case['target'],'--root',root,'--format','json']),('hook',['hook','--format','claude'])]:
            reports=[]
            for cli in [args.before,args.after]:
                stdin=json.dumps({'hook_event_name':'PreToolUse','cwd':root,'tool_input':{'file_path':case['target']}}) if command=='hook' else ''
                r=subprocess.run([args.node,str(cli.resolve()),*options],input=stdin,text=True,capture_output=True,cwd=root,env=env,timeout=180,check=True)
                reports.append(json.loads(r.stdout))
            equal=reports[0]==reports[1]
            rows.append({'case':case['id'],'command':command,'equal':equal})
            args.output.write_text(json.dumps({'reference_clock':env['CRIMES_NOW'],'rows':rows},indent=2)+'\n')
            if not equal:
                for index,report in enumerate(reports):
                    args.output.with_name(f'drift-{case["id"]}-{command}-{index}.json').write_text(json.dumps(report,indent=2)+'\n')
                raise RuntimeError(f'Report drift: {case["id"]} {command}; inspect saved reports')
            print(f'{case["id"]} {command}: identical',flush=True)


if __name__=='__main__':
    main()
