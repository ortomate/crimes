"""Recalculate CLI usage from recorded report types without changing trial evidence."""
import json


def cli_metrics(path, original_source, final_source):
    calls = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
    scans = [call for call in calls if call['exit_code'] == 0 and (call.get('report') or {}).get('type') == 'scan']
    comparable = any(a['args'] == b['args'] and a['cwd'] == b['cwd'] and
                     a['source'] == original_source and b['source'] == final_source and original_source != final_source
                     for i,a in enumerate(scans) for b in scans[i+1:])
    return {'cli_calls': len(calls), 'cli_elapsed_ms': sum(call['elapsed_ms'] for call in calls),
            'context_calls': sum((call.get('report') or {}).get('type') == 'context' for call in calls),
            'hook_contexts': sum(bool((call.get('report') or {}).get('hook_context')) for call in calls),
            'comparable_pre_post_scans': comparable}
