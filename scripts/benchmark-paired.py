#!/usr/bin/env python3
"""Confirm latency changes with adjacent before/after processes and alternating order.

Use after an initial profile identifies changes or unexplained regressions.
Retain both measurements; do not replace an unfavorable first run silently.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import tempfile

spec = importlib.util.spec_from_file_location('benchmark', Path(__file__).with_name('benchmark.py'))
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['before','after','cases','output']:
        parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--node',default='node')
    parser.add_argument('--repeats',type=int,default=10)
    parser.add_argument('--commands',default='context')
    args=parser.parse_args()
    if args.repeats<2:
        parser.error('At least two repeats required')
    rows=[]
    output={'method':'Adjacent fresh before/after processes; alternating order each pair; first pair retained separately; OS cache not flushed; nested spans overlap',
            'node':subprocess.check_output([args.node,'--version'],text=True).strip(),
            'platform':platform.platform(),'logical_cpus':os.cpu_count(),'reference_clock':'2026-09-07T00:00:00Z',
            'repeats':args.repeats,'rows':rows,
            'cli_sha256':{name:benchmark.hashlib.sha256(getattr(args,name).read_bytes()).hexdigest() for name in ['before','after']}}
    observer=Path(__file__).with_name('performance-observer.mjs').resolve()
    for case in json.loads(args.cases.read_text()):
        root=Path(case['root']).resolve();source=benchmark.source_digest(root)
        for command in args.commands.split(','):
            options={'scan':['scan',str(root),'--format','json'],
                     'context':['context',case['target'],'--root',str(root),'--format','json'],
                     'hook':['hook','--format','claude']}[command]
            samples={'before':[],'after':[]}
            with tempfile.TemporaryDirectory(prefix='crimes-paired-perf-') as temp:
                path=Path(temp)/'spec.json'
                for pair in range(args.repeats+1):
                    for name in ['before','after'] if pair%2==0 else ['after','before']:
                        request={'root':str(root),'reference_clock':output['reference_clock'],
                                 'command':[args.node,'--import',str(observer),str(getattr(args,name).resolve()),*options]}
                        if command=='hook':
                            request['input']=json.dumps({'hook_event_name':'PreToolUse','cwd':str(root),'tool_input':{'file_path':case['target']}})
                        path.write_text(json.dumps(request))
                        result=subprocess.run([sys.executable,str(Path(benchmark.__file__).resolve()),'--worker',str(path)],text=True,capture_output=True,check=True,timeout=200)
                        samples[name].append(json.loads(result.stdout))
            hashes={sample['report_sha256'] for values in samples.values() for sample in values}
            if len(hashes)!=1:
                raise RuntimeError(f'Unstable or changed reports: {case["id"]} {command}')
            row={'case':case['id'],'command':command,'source':source,'identical_stable_reports':True}
            for name,values in samples.items():
                repeated=[sample['elapsed_ms'] for sample in values[1:]]
                row[name]={'first_ms':values[0]['elapsed_ms'],'median_ms':statistics.median(repeated),
                           'p95_ms':benchmark.percentile(repeated,.95),
                           'peak_rss_bytes':max(sample['peak_rss_bytes'] for sample in values),'samples':values}
            rows.append(row)
            args.output.parent.mkdir(parents=True,exist_ok=True)
            args.output.write_text(json.dumps(output,indent=2)+'\n')
            print(f"{case['id']} {command}: {row['before']['median_ms']:.0f}ms -> {row['after']['median_ms']:.0f}ms",flush=True)
        if benchmark.source_digest(root)!=source:
            raise RuntimeError(f'Corpus changed: {case["id"]}')


if __name__=='__main__':
    main()
