import importlib.util
import json
import copy
from pathlib import Path
import tempfile
import unittest
import outcome_support as helpers
import outcome_audit

spec = importlib.util.spec_from_file_location('outcomes', Path(__file__).with_name('eval-outcomes.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

spec_summary = importlib.util.spec_from_file_location('outcome_summary', Path(__file__).with_name('summarize-outcomes.py'))
reporting = importlib.util.module_from_spec(spec_summary)
spec_summary.loader.exec_module(reporting)

spec_comparison = importlib.util.spec_from_file_location('comparison', Path(__file__).with_name('compare-analysis.py'))
comparison = importlib.util.module_from_spec(spec_comparison)
spec_comparison.loader.exec_module(comparison)


class OutcomeMethods(unittest.TestCase):
    def test_balanced_order_and_complete_unique_matrix(self):
        cases = [{'id': str(i)} for i in range(12)]
        work = runner.schedule(cases, ['codex', 'claude'], 3, 2900)
        self.assertEqual(len(work), 216)
        self.assertEqual(len({(c['id'],h,a,r) for c,h,a,r in work}), 216)
        for case in cases:
            for host in ['codex','claude']:
                orders = [[a for c,h,a,r in work if c==case and h==host and r==repeat] for repeat in [1,2,3]]
                for position in range(3):
                    self.assertEqual({order[position] for order in orders}, set(runner.ARMS))
        self.assertEqual(work, runner.schedule(cases, ['codex','claude'], 3, 2900))

    def test_prose_or_failed_commands_are_not_skill_activation(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'host.jsonl'
            records=[{'type':'item.completed','item':{'type':'agent_message','text':'I read skills/crimes/SKILL.md'}},
                     {'type':'item.completed','item':{'type':'command_execution','command':'cat .agents/skills/crimes/SKILL.md','exit_code':1}},
                     {'type':'turn.completed','usage':{'input_tokens':50,'cached_input_tokens':30}}]
            path.write_text('\n'.join(json.dumps(r) for r in records))
            result=helpers.transcript_metrics(path,'codex')
            self.assertFalse(result['skill_action_observed'])
            self.assertEqual(result['usage_reported']['input_tokens'],50)
            self.assertTrue(result['successful_completion_event'])

    def test_pre_post_requires_original_and_final_source_and_same_scope(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'cli.jsonl'
            def row(source,args):
                return {'args':args,'source':source,'cwd':'/root','exit_code':0,'elapsed_ms':1,'report':{'type':'scan'}}
            rows=[row('mid',['scan','--format','json']),row('final',['scan','--format','json'])]
            path.write_text('\n'.join(json.dumps(r) for r in rows))
            self.assertFalse(helpers.cli_metrics(path,'original','final')['comparable_pre_post_scans'])
            rows.insert(0,row('original',['scan','--files','src/a.js','--format','json']))
            path.write_text('\n'.join(json.dumps(r) for r in rows))
            self.assertFalse(helpers.cli_metrics(path,'original','final')['comparable_pre_post_scans'])
            rows.insert(0,row('original',['scan','--format','json']))
            path.write_text('\n'.join(json.dumps(r) for r in rows))
            self.assertTrue(helpers.cli_metrics(path,'original','final')['comparable_pre_post_scans'])

    def test_inventory_detects_deletion_addition_and_ignores_installed_dependencies(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'source.js').write_text('original')
            before=helpers.inventory(root)
            (root/'source.js').unlink();(root/'new.js').write_text('changed')
            (root/'node_modules').mkdir();(root/'node_modules/ignored').write_text('package')
            after=helpers.inventory(root)
            self.assertEqual(set(before),{'source.js'})
            self.assertEqual(set(after),{'new.js'})

    def test_wrapper_hash_tracks_added_sources_and_matches_inventory(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp);root=base/'project';root.mkdir()
            installed=base/'installed';(installed/'crimes/dist').mkdir(parents=True)
            (installed/'crimes/dist/index.js').write_text('console.log(JSON.stringify({report_type:"scan"}))')
            (root/'original.js').write_text('first')
            log=base/'cli.jsonl'
            binary=helpers.install_wrapper(root,installed,log)
            snapshots=[]
            for step in range(3):
                if step==1:
                    (root/'new.py').write_text('new source')
                if step==2:
                    (root/'original.js').unlink()
                snapshots.append(helpers.source_digest(root))
                helpers.run([binary,'scan','--format','json'],root)
            self.assertEqual(len(set(snapshots)),3)
            self.assertEqual([json.loads(line)['source'] for line in log.read_text().splitlines()],snapshots)

    def test_pooling_rejects_duplicates_missing_host_and_changed_inputs(self):
        metadata={key:'fixed' for key in ['package_sha256','fixtures','harness_sha256','helpers_sha256','seed','jobs','timeout','node','python']}
        metadata.update(hosts={'codex':{},'claude':{}},repeats=1)
        rows=[{'host':host,'case':'one','arm':arm,'repeat':1} for host in metadata['hosts'] for arm in runner.ARMS]
        document={'metadata':metadata,'rows':rows}
        self.assertEqual(reporting.validate([document],6),rows)
        with self.assertRaisesRegex(RuntimeError,'Incomplete or duplicate'):
            reporting.validate([document,document],12)
        with self.assertRaisesRegex(RuntimeError,'paired cell'):
            reporting.validate([{**document,'rows':rows[:3]}],3)
        changed=copy.deepcopy(document);changed['metadata']['package_sha256']='different'
        with self.assertRaisesRegex(RuntimeError,'changed inputs'):
            reporting.validate([document,changed],12)

    def test_paired_summary_counts_mixed_outcomes_without_erasing_failures(self):
        rows=[]
        for case,control,treated in [('one',False,True),('two',True,False),('three',True,True)]:
            for arm in runner.ARMS:
                rows.append({'host':'codex','case':case,'arm':arm,'repeat':1,
                             'acceptance_passed':control if arm=='without' else treated,
                             'usage_reported':{'input_tokens':10},'run_success':arm!='installed',
                             'outside_expected_scope':[],'task_elapsed_ms':100,
                             'skill_action_observed':False,'hook_contexts':0,'comparable_pre_post_scans':False})
        result=reporting.summarize(rows)
        self.assertEqual(result['groups'][2]['host_completions'],0)
        self.assertEqual(result['groups'][2]['acceptance_passes'],2)
        for paired in result['paired_against_without']:
            self.assertEqual((paired['wins'],paired['losses'],paired['ties']),(1,1,1))
            self.assertEqual(paired['mean_acceptance_difference'],0)
            self.assertLess(paired['task_resampled_95_percent_interval'][0],0)
            self.assertGreater(paired['task_resampled_95_percent_interval'][1],0)
        self.assertIsNone(reporting.interval([0,0,0]))

    def test_declared_prose_changes_cannot_hide_missing_findings_or_coverage_drift(self):
        before={'agent_guidance':['Read old advice'], 'findings':[{'fingerprint':'one'}], 'coverage':{'files_total':5}, 'hook':{'additionalContext':'Advice: Read old advice'}}
        changed=comparison.apply_expected_text_changes(before,{'Read old advice':'Read new advice'})
        self.assertEqual(changed['agent_guidance'],['Read new advice'])
        self.assertEqual(changed['hook']['additionalContext'],'Advice: Read new advice')
        self.assertEqual(changed['findings'],before['findings'])
        self.assertEqual(changed['coverage'],before['coverage'])
        self.assertNotEqual(changed,{**changed,'findings':[]})
        self.assertNotEqual(changed,{**changed,'coverage':{'files_total':4}})
        self.assertEqual(before['agent_guidance'],['Read old advice'])

    def test_usage_audit_recognizes_global_options_and_excludes_help(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'cli.jsonl'
            def row(args,source,report):
                return {'args':args,'source':source,'cwd':'/root','exit_code':0,'elapsed_ms':1,'report':report}
            records=[row(['scan','--help'],'original',None),
                     row(['--no-skill-update','context','a.js'],'original',{'type':'context'}),
                     row(['--no-skill-update','scan','--format','json'],'original',{'type':'scan'}),
                     row(['--no-skill-update','scan','--format','json'],'final',{'type':'scan'})]
            path.write_text('\n'.join(json.dumps(r) for r in records))
            audited=outcome_audit.cli_metrics(path,'original','final')
            self.assertTrue(audited['comparable_pre_post_scans'])
            self.assertEqual(audited['context_calls'],1)
            records[-1]['source']='intermediate'
            path.write_text('\n'.join(json.dumps(r) for r in records))
            self.assertFalse(outcome_audit.cli_metrics(path,'original','final')['comparable_pre_post_scans'])


if __name__=='__main__':
    unittest.main()
