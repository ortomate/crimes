#!/usr/bin/env python3
"""Prepare performance case paths and deterministic, explicitly synthetic scaling inputs."""
import argparse
import json
from pathlib import Path


def generated(root, mixed):
    root.mkdir(parents=True, exist_ok=True)
    (root/'pyproject.toml').write_text('[project]\nname="benchmark-service"\nversion="0.0.0"\n')
    for directory in ['service','tests']:
        (root/directory).mkdir(exist_ok=True)
    (root/'service/__init__.py').write_text('')
    for i in range(160):
        name=f'charge_{i:03}'
        (root/'service'/f'{name}.py').write_text(f'from decimal import Decimal\n\ndef {name}(subtotal: Decimal, discount: Decimal) -> Decimal:\n    if subtotal < 0 or discount < 0:\n        raise ValueError("negative amount")\n    return max(Decimal(0), subtotal - discount)\n')
        (root/'tests'/f'test_{name}.py').write_text(f'from decimal import Decimal\nfrom service.{name} import {name}\n\ndef test_discount():\n    assert {name}(Decimal(100), Decimal(10)) == Decimal(90)\n')
        if mixed:
            (root/'web').mkdir(exist_ok=True)
            (root/'web'/f'{name}.ts').write_text(f'export function {name}(subtotal: number, discount: number): number {{\n  if (subtotal < 0 || discount < 0) throw new Error("negative amount");\n  return Math.max(0, subtotal - discount);\n}}\n')


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source-root',type=Path,required=True,help='Immutable crimes source worktree')
    p.add_argument('--fixture-root',type=Path,default=Path(__file__).resolve().parents[1])
    p.add_argument('--output-dir',type=Path,required=True)
    a=p.parse_args()
    a.output_dir=a.output_dir.resolve()
    if a.output_dir.exists():
        p.error('Use a new output directory; existing corpora are never overwritten')
    a.output_dir.mkdir(parents=True)
    specs=[('js-small','examples/messy-ts-app','src/date.ts'),
           ('js-medium','evals/fixtures/03-node-cli-tool','lib/command.js'),
           ('tsx-medium','evals/fixtures/02-react-dashboard','basics/typescript-final/components/date.tsx'),
           ('python-small','evals/fixtures/11-py-service','domain/invoicing.py'),
           ('mixed-small','evals/fixtures/13-polyglot-monorepo','packages/api/billing/plans.py')]
    cases=[{'id':id,'root':str((a.fixture_root/path).resolve()),'target':target} for id,path,target in specs]
    cases.append({'id':'crimes-source','root':str(a.source_root.resolve()),'target':'packages/core/src/scan.ts'})
    for kind in ['python','mixed']:
        root=a.output_dir/(kind+'-generated')
        generated(root,kind=='mixed')
        cases.append({'id':kind+'-generated','root':str(root),'target':'service/charge_000.py'})
    for case in cases:
        if not (Path(case['root'])/case['target']).is_file():
            raise RuntimeError(f'Missing pinned fixture target: {case}; run pnpm evals:setup first')
    (a.output_dir/'cases.json').write_text(json.dumps(cases,indent=2)+'\n')
    print(a.output_dir/'cases.json')


if __name__=='__main__':
    main()
