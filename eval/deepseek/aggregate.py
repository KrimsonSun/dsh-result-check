"""Combine summary.jsonl (what happened) with grades/*.json (graded verdicts).

    python3 aggregate.py [summary.jsonl] [grades dir]
"""
import collections
import json
import sys
from pathlib import Path

E = Path(__file__).parent
summary = Path(sys.argv[1]) if len(sys.argv) > 1 else E / 'summary.jsonl'
grades_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else E / 'grades'
runs = {(r['model'], r['task'], r['rep']): r for r in map(json.loads, open(summary))}
grades = {}
for f in sorted(grades_dir.glob('*.json')):
    for g in json.loads(f.read_text()):
        grades[(g['model'], g['task'], g['rep'])] = g

missing = sorted(set(runs) - set(grades))
if missing:
    print('ungraded runs:', missing)


def problems(a):
    return a is not None and (a['wrong_numbers'] or a['hidden_failures'] or a['wrong_conclusions'])


for model in sorted({k[0] for k in grades}):
    keys = sorted(k for k in grades if k[0] == model)
    G = [grades[k] for k in keys]
    R = [runs[k] for k in keys]
    n = len(G)
    fired = [g for g in G if g['plugin_fired']]
    first_bad = [g for g in G if problems(g['first'])]
    final_of = lambda g: g['final'] if g['plugin_fired'] else g['first']
    final_bad = [g for g in G if problems(final_of(g))]
    kinds = collections.Counter(w['kind'] for g in G for w in g['first']['wrong_numbers'])
    hidden = [g for g in G if g['first']['hidden_failures']]
    flagged = sum(len(g['note']['numbers']) for g in fired)
    real = sum(len(g['note']['flag_real']) for g in fired)
    false = sum(len(g['note']['flag_false']) for g in fired)
    fail_part = collections.Counter(g['note']['failure_part'] for g in fired)
    effects = collections.Counter(g['effect'] for g in fired)
    caught = [g for g in first_bad if g['plugin_fired'] and (g['note']['flag_real'] or g['note']['failure_part'] == 'real')]
    wrong_values = sum(len(g['first']['wrong_numbers']) for g in G)
    wrong_flagged = sum(len(g['note']['flag_real']) for g in fired)
    tok = [r['usage'].get('totalTokens', 0) for r in R]
    tok_after = [r['usageAfter'].get('totalTokens', 0) for r, g in zip(R, G) if g['plugin_fired']]
    print(f'\n=== {model}: {n} runs')
    print(f'first answer with a problem: {len(first_bad)} ({100*len(first_bad)/n:.0f}%)  '
          f'wrong numbers {wrong_values} {dict(kinds)}, hidden failures in {len(hidden)} runs')
    print(f'final answer with a problem: {len(final_bad)} ({100*len(final_bad)/n:.0f}%)')
    print(f'plugin fired: {len(fired)} ({100*len(fired)/n:.0f}%); numbers flagged {flagged}: real {real}, false {false}; '
          f'failure part {dict(fail_part)}')
    print(f'runs with a problem that the plugin pointed at: {len(caught)} of {len(first_bad)}; wrong values flagged {wrong_flagged} of {wrong_values}')
    print(f'effect: {dict(effects)}')
    print(f'fired on a clean first answer: {sum(1 for g in fired if not problems(g["first"]))}; '
          f'clean first answer made worse: {sum(1 for g in fired if not problems(g["first"]) and problems(g["final"]))}')
    print(f'tokens per run: mean {sum(tok)/n:,.0f}; after the note (when fired): mean {sum(tok_after)/max(1,len(tok_after)):,.0f}')
    same = [(r, g) for r, g in zip(R, G) if r['replay']['sameToolFailureFlag'] and not r['replay']['anyToolFailureFlag']]
    print(f'same-tool would add a failure flag on {len(same)} runs; of those the first answer hid a failure in '
          f'{sum(1 for _, g in same if g["first"]["hidden_failures"])}')
    by_task = collections.defaultdict(lambda: [0, 0, 0, 0])
    for g in G:
        t = by_task[g['task']]
        t[0] += 1
        t[1] += bool(problems(g['first']))
        t[2] += g['plugin_fired']
        t[3] += bool(problems(final_of(g)))
    print('task: runs / first bad / fired / final bad')
    for t, v in sorted(by_task.items()):
        print(f'  {t}: {v[0]} / {v[1]} / {v[2]} / {v[3]}')
