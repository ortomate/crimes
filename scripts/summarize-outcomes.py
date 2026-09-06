#!/usr/bin/env python3
"""Validate complete paired outcome cells and summarize assigned conditions.

Task-resampled intervals describe this fixed synthetic suite, not a sampled
population of repositories. A constant paired difference yields no useful
empirical uncertainty estimate and is reported as null rather than zero width.
"""
import argparse
from collections import defaultdict
import json
from pathlib import Path
import random
import statistics


def interval(differences):
    if len(set(differences)) < 2:
        return None
    randomizer = random.Random(2900)
    draws = sorted(statistics.mean(randomizer.choices(differences, k=len(differences))) for _ in range(10000))
    return [round(draws[249], 4), round(draws[9749], 4)]


def summarize(rows):
    groups = []
    paired = []
    for host in sorted({r['host'] for r in rows}):
        for arm in ['without','briefing','installed']:
            sample = [r for r in rows if r['host']==host and r['arm']==arm]
            usage = defaultdict(int)
            for row in sample:
                for key,value in row['usage_reported'].items():
                    if isinstance(value,(int,float)):
                        usage[key]+=value
            groups.append({'host':host,'arm':arm,'runs':len(sample),
                           'acceptance_passes':sum(r['acceptance_passed'] for r in sample),
                           'host_completions':sum(r['run_success'] for r in sample),
                           'scope_review_flags':sum(bool(r['outside_expected_scope']) for r in sample),
                           'median_task_ms':round(statistics.median(r['task_elapsed_ms'] for r in sample)),
                           'mean_task_ms':round(statistics.mean(r['task_elapsed_ms'] for r in sample)),
                           'skill_actions':sum(r['skill_action_observed'] for r in sample),
                           'hook_contexts':sum(r['hook_contexts'] for r in sample),
                           'comparable_scans':sum(r['comparable_pre_post_scans'] for r in sample),
                           'usage_reported':dict(usage)})
        controls={(r['case'],r['repeat']):r for r in rows if r['host']==host and r['arm']=='without'}
        for arm in ['briefing','installed']:
            by_task=defaultdict(list)
            wins=losses=ties=0
            for row in [r for r in rows if r['host']==host and r['arm']==arm]:
                difference=int(row['acceptance_passed'])-int(controls[row['case'],row['repeat']]['acceptance_passed'])
                by_task[row['case']].append(difference)
                wins+=difference>0;losses+=difference<0;ties+=difference==0
            differences=[statistics.mean(values) for values in by_task.values()]
            paired.append({'host':host,'arm':arm,'wins':wins,'losses':losses,'ties':ties,
                           'tasks':len(differences),'mean_acceptance_difference':round(statistics.mean(differences),4),
                           'task_resampled_95_percent_interval':interval(differences),
                           'uncertainty_limit':'Fixed synthetic tasks are not a representative random sample; a null interval means the observed task differences supply no empirical variance estimate.'})
    return {'groups':groups,'paired_against_without':paired}


def validate(documents, expected_runs):
    comparable=['package_sha256','fixtures','harness_sha256','helpers_sha256','hosts','repeats','seed','jobs','timeout','node','python']
    for document in documents[1:]:
        for key in comparable:
            if document['metadata'][key]!=documents[0]['metadata'][key]:
                raise RuntimeError(f'Cannot pool changed inputs: {key}')
        if document['metadata'].get('cli_metrics_sha256')!=documents[0]['metadata'].get('cli_metrics_sha256'):
            raise RuntimeError('Cannot pool changed inputs: cli_metrics_sha256')
    rows=[row for document in documents for row in document['rows']]
    keys={(r['host'],r['case'],r['arm'],r['repeat']) for r in rows}
    if len(rows)!=expected_runs or len(keys)!=len(rows):
        raise RuntimeError('Incomplete or duplicate outcome matrix')
    repeats=documents[0]['metadata']['repeats']
    hosts=set(documents[0]['metadata']['hosts'])
    cases={row['case'] for row in rows}
    expected={(host,case,arm,repeat) for host in hosts for case in cases
              for arm in ['without','briefing','installed'] for repeat in range(1,repeats+1)}
    if keys!=expected:
        raise RuntimeError('Missing or unexpected paired cell')
    return rows


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('inputs',type=Path,nargs='+')
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--expected-runs',type=int,default=216)
    a=p.parse_args()
    documents=[json.loads(path.read_text()) for path in a.inputs]
    rows=validate(documents,a.expected_runs)
    output={'metadata':documents[0]['metadata'],
            'post_processing':[d.get('post_processing') for d in documents],
            'partitions':[{'cases_sha256':d['metadata']['cases_sha256'],
                           'cases':sorted({r['case'] for r in d['rows']}),
                           'holdout':sorted({r['holdout'] for r in d['rows']})} for d in documents],
            'runs':len(rows),**summarize(rows),
            'rows':[{k:v for k,v in row.items() if k!='acceptance'} for row in sorted(rows,key=lambda r:r['id'])],
            'limits':['Purpose-built small repositories; not independently reported edits.',
                      'Assigned-condition analysis includes missed activation and failed host runs.',
                      'Scope flags require reviewing patches; they are not confirmed regressions.',
                      'Provider usage field definitions differ across hosts; do not combine them.',
                      'Concurrent host trials make task time descriptive, not isolated model or scanner latency.']}
    a.output.parent.mkdir(parents=True,exist_ok=True)
    a.output.write_text(json.dumps(output,indent=2)+'\n')
    print(json.dumps({key:output[key] for key in ['runs','groups','paired_against_without']},indent=2))


if __name__=='__main__':
    main()
