import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import outcome_support as helpers

spec = importlib.util.spec_from_file_location('outcomes', Path(__file__).with_name('eval-outcomes.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


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


if __name__=='__main__':
    unittest.main()
