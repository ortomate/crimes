#!/usr/bin/env python3
"""Audit ALL completed rows from raw CLI logs, retaining originally recorded metrics.

Global flags may precede a subcommand. Report envelopes identify the command
more reliably than argv[0]. This cannot infer calls to a global or unwrapped
binary; such deviations require a separate transcript review.
"""
import argparse
import hashlib
import json
from pathlib import Path
import outcome_audit


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input-dir',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    a=p.parse_args();source=a.input_dir/'results.json'
    if a.output.resolve()==source.resolve():
        p.error('Retain raw results; choose a separate audit output')
    document=json.loads(source.read_text());changed=[]
    for row in document['rows']:
        path=a.input_dir/row['id']/'cli.jsonl'
        audited=outcome_audit.cli_metrics(path,row['original_source'],row['final_source'])
        row['recorded_cli_metrics']={key:row[key] for key in audited}
        row['cli_log_sha256']=hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
        if row['recorded_cli_metrics']!=audited:
            changed.append(row['id'])
        row.update(audited)
    document.pop('summary',None)  # The summarizer recomputes it from audited rows.
    document['post_processing']={'raw_results_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),
                                 'audit_script_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                                 'audit_helper_sha256':hashlib.sha256(Path(outcome_audit.__file__).read_bytes()).hexdigest(),
                                 'changed_rows':changed,
                                 'method':'All rows recalculated from raw report envelopes, handling global flags before the command; recorded metrics retained. Calls bypassing the instrumented binary are not inferred.'}
    a.output.parent.mkdir(parents=True,exist_ok=True)
    a.output.write_text(json.dumps(document,indent=2)+'\n')
    print(f'Audited {len(document["rows"])} rows; corrected command recognition in {len(changed)}')


if __name__=='__main__':
    main()
