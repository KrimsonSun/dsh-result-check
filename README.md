# dsh-result-check

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that checks the agent's
final answer against what its tools actually returned, before the turn ends. When the two disagree,
it sends the model back once with a short note saying what to fix.

It runs two checks. Both are plain code, with no extra model call:

| Check | Fires when | Example |
|---|---|---|
| **Unreported tool failure** | A tool call failed, no later call in the turn succeeded, and the answer never says anything failed | `web_fetch` returned HTTP 503 and the answer summarises the page anyway |
| **Unsourced number** | The answer states a number that no tool output, tool argument or user message in the session contains, at the precision the answer writes it, and that the answer's other numbers do not account for either (one arithmetic step, a table total or share, or working it writes out) | The tool reported `AC: DDX41 392 / WT 258` and the answer's table says `469 / 181` |

When a check fires, the model gets one more step with a note like this:

```text
[result-check] Before you finish, check your answer against this session's tool output. ...

These numbers in your answer appear in no tool output, tool argument or user message of this
session: 469, 181.
For each one, say which output it comes from or how you derived it, or correct it. Do not change
a number that is right.

Then give your final answer again.
```

The note appears in the conversation as a one-line notice, for example
`Result check: 2 unsourced numbers`.

## Why

This plugin comes out of [AiScientist](https://github.com/RCHENLAB/AiScientist), a research agent
for biomedical data. There, telling the model in its prompt not to misreport results did not work
reliably. Checking the answer in code did:

- A step's answer swapped two groups' cell counts and made up a per-group split no tool had
  computed. The reviewing model still accepted it with 0.95 confidence. A code check now blocks
  answers whose numbers contradict their own tool results.
- When a tool fails, the failure has to be reported as a failure, never written up as a success.

This plugin brings both rules to any dsh agent, in a general form.

## Where it fits

It works best for agents whose tools return data and whose answers report that data: analysis,
benchmarking, monitoring, research over tool output. There a wrong or invented number is the
error that matters, and most numbers in the answer come straight from a tool.

On DeepSeek analysis tasks it sent back about 1 run in 8, mostly to have the model explain a
correct multi-step number, and it caught most changed numbers (see below). For a general coding
agent it stays mostly quiet (about 1 turn in 50), but it also catches less: answers there are full
of estimates, general knowledge and multi-step arithmetic, which the check has to let through or
flag as unsourced.

## How it was tested

Besides the unit and agent-loop tests, the plugin was tested two ways: live in dsh with DeepSeek
models, and offline over real Claude Code sessions.

### DeepSeek in dsh

Twelve data-analysis tasks, run through `dsh headless` with the plugin on: single-cell counts, a
DE gene table, an RNA-seq pipeline, an access log, a weekly service report, disk usage, a
benchmark, training runs, a clinical trial, an income statement, sales data and a Chinese survey.
Tools are the shell, file reads and a local MCP data server. Several tasks hold traps: a benchmark
config that crashed, a metrics call that times out, a training run the tracking server cannot
find, a failed pipeline step next to an old report, and condition and reference labels that are
easy to swap. Each version ran 60 times, `deepseek-flash` 3 times and `deepseek-v4-pro` twice per
task. Every run records the first answer, which is what the user gets without the plugin, and the
answer after the note. Each answer was graded against the task's ground truth by Claude
subagents, which checked every computed value with Python. `eval/deepseek/` has the tasks, the
harness and the rubric.

| | 0.2.0 | 0.3.0 |
|---|---|---|
| First answers with a problem | 2 of 60 | 2 of 60 |
| …made-up numbers or hidden tool failures | 0 | 0 |
| Runs sent back | 20 (33%) | 7 (12%) |
| Numbers flagged | 37, 1 a real error | 8, 1 a real error |
| Answers the note made worse | 0 | 0 |
| Changed numbers caught | 88–89% | 89–90% |

- **DeepSeek.** Both models avoided every trap: no number for the crashed config, the
  unavailable service or the missing run, every failure reported, the old report labelled as old,
  no swapped labels. In each round one `deepseek-flash` answer had a rounding-level mistake
  (`0.76264` for 0.762633, `fell 4.1%` for 4.05%), which the plugin flagged and the model fixed,
  and one ranked wrongly while every number was right, which the plugin cannot see.
- **Noise.** 0.2.0 sent back a third of the runs, nearly always for correct numbers: table totals
  and means, shares worked out in the head, percentage points, relative changes, a thousands to
  millions rescale, an example value. 0.3.0 accepts these (see "How it decides"). The same 0.2.0
  check replayed on 0.3.0's answers would still have sent back 20 runs, so the drop is the rules,
  not the sample. 0.3.0's remaining false flags: a sum of more than two numbers with no working
  shown, a difference of two rounded values (`128.51` from 541.38 − 412.88), a unit constant
  (`1024`), a step on two cells of one table row cited below the table, and a chained equation.
- **Cost.** A false flag costs one more step, 9,000–18,000 tokens, which is a quarter to a half of
  a run. The model explained the number and kept it every time, and no answer got worse. Some final
  answers open with a short verification paragraph before the full answer again.
- **Misses.** One sourced number per first answer was changed (last digit + 1, or value × 1.2) and
  the check run again. Both versions catch 88–90% of the changes, within a point of each other on
  the same answers.
- **Limits of this test.** The tasks were written for it: clean data, clear questions, short
  sessions. 0.3.0's rules came from the false flags of the 0.2.0 round, and the 0.3.0 round is
  fresh answers to the same tasks, so the Claude Code replay below is the check on data the rules
  were not tuned on.

### Replay over Claude Code sessions

Both checks replayed offline over 2,598 turns that called a tool, from Claude Code transcripts on
one developer's machine: mostly software and infrastructure work, with some research, writing and
finance. `eval/replay-claude-code.ts` is the script. The replay follows dsh where the two
harnesses differ (see the script's header).

| | 0.1.0 | 0.2.0 | 0.3.0 |
|---|---|---|---|
| Turns sent back | 169 (6.5%) | 53 (2.0%) | 50 (1.9%) |
| …for a tool failure | 36 | 1 | 1 |
| …for numbers | 137 turns, 282 numbers | 53 turns, 81 numbers | 50 turns, 67 numbers |
| Changed numbers caught (last digit + 1) | 51% | 48% | 48% |
| Changed numbers caught (value × 1.2) | 56% | 53% | 53% |

- **Noise.** In 0.1.0, none of the 36 failure flags caught a misreported result. They were calls
  rejected before running (bad arguments, unknown tool, cancelled) or probes (a missing file, a page
  not loaded yet) that the agent worked around with another tool. A random sample of 24 flagged
  numbers held no real mistake either: 16 were correct arithmetic, 4 unit conversions, 1 general
  knowledge, 3 not quantities at all (line numbers, a status code). 0.2.0 accepts most of these:
  rejected calls, unit conversions, one-step arithmetic and line references.
- **Misses.** It catches about 85% of changes to numbers with 4 or more significant digits, about
  40% with 3, and about 10% with 1–2: a short number like `3.6` usually appears somewhere among the
  session's thousands of numbers. Long sessions catch less for the same reason. Coding sessions
  hold far more numbers than the DeepSeek tasks, hence about 50% here against 89% there.
- **Not covered.** These sessions came from Claude models in Claude Code. They held few real
  misreported numbers to find, so this measures noise and coverage, not how often a model makes
  these mistakes.

## Install

From a release tarball or a checkout (build first: `npm install && npm run build`):

```sh
dsh plugin --profile <name> add ./dsh-result-check
dsh --profile <name>
```

From GitHub. The `prepare` script builds the plugin on install, so pnpm asks you to allow it once
(see the dsh docs, "Install from GitHub"):

```sh
dsh plugin --profile <name> add github:KrimsonSun/dsh-result-check#<commit>
```

For a quick try with a dsh source checkout, add a `--patch` overlay that names the built file:

```yaml
# result-check.yml
- insert:
    - id: result-check
      name: /absolute/path/to/dsh-result-check/lib/index.js
```

```sh
pnpm dsh web --patch result-check.yml
```

## Configuration

Every key is optional. To change one, override the row by id in your profile's
`cordis.patch.yml`. A later layer replaces the whole `config`, so restate every key you set.

```yaml
- id: result-check
  config:
    failureResolvedBy: same-tool
    ignoreTools: ['read', 'glob']
```

| Key | Default | Meaning |
|---|---|---|
| `checkFailures` | `true` | Run the unreported-failure check |
| `checkNumbers` | `true` | Run the unsourced-number check |
| `numbersNeedToolCall` | `true` | Check numbers only in turns that called a tool (plain chat answers are left alone) |
| `minIntegerDigits` | `3` | Integers with fewer digits are not checked |
| `failureStatuses` | `error`, `failed`, `timeout`, `unavailable`, `dependency_missing`, `cancelled`, `blocked`, … | JSON `status` values that mean a tool failed; anything starting with `error`, `fail` or `blocked` also counts |
| `ignoreTools` | `[]` | Tool names (`*` wildcards) whose failures are ignored |
| `ignoreErrorCodes` | `*ABORTED*`, `*CANCELLED`, `*CANCELED`, `UNKNOWN_TOOL`, `INVALID_ARGS`, `TOOL_ACTIVATION_FAILED`, `AUTO_REVIEW_DENIED`, `DECLINED` | dsh error codes (`*` wildcards) for calls that never produced a result: cancelled, unknown tool, invalid arguments, declined |
| `failureResolvedBy` | `any-tool` | A failure is dealt with once a later call succeeds: of any tool, or with `same-tool` only of the same tool. Use `same-tool` for pipelines where every tool's result is reported |
| `allowDerived` | `true` | Accept a number that one arithmetic step on other numbers in the answer gives |
| `derivedScope` | `paragraph` | Where those numbers may come from: the same paragraph, or the whole `answer` (quieter, catches less) |
| `skipSubagents` | `false` | Leave subagents unchecked |
| `maxNudgesPerTurn` | `1` | Most times one turn is sent back |
| `maxListedNumbers` | `8` | Most numbers named in one note |

## How it decides

A wrong flag costs the user an extra step and teaches them to ignore the note. A missed problem
costs what it cost before the plugin existed. So when the reader is unsure, it stays quiet.

**A tool call failed** when dsh marks its result as an error, or when the result is a JSON object
whose `status` is a failure value. That covers MCP tools and most script tools. A shell command that
exits non-zero is **not** a failure, because the shell tool reports it as a normal result. A call
dsh rejected before running it (see `ignoreErrorCodes`) is neither a failure nor a success.

The failure counts as dealt with once a later call in the turn succeeds: the agent saw it and moved
on. The answer counts as mentioning it when it says something failed, in English or Chinese
("failed", "could not", "timed out", "returned 404", "no data", "失败", "无法", "超时", "缺失", …).

**A number is checked** only when the answer states it as a value:

- Checked: decimals (`0.873`), integers of 3+ digits (`1,708`), percentages (`12.5%`, and
  percentage points such as `+26.4 pp` or `11.5 个百分点`), with or without a short unit
  (`1530ms`, `3.2GB`, `1.6x`), in English or Chinese text (`共1708个细胞`).
- Skipped: code blocks and inline code, URLs, file paths and line references (`app.py:120-140`,
  `` `f` (2867) ``, `(891-894)`), versions, dates, times, `#123` references, phone numbers and
  other hyphenated digit groups, identifiers (`H100`, `x86_64`, `ISO-8601`, `HTTP 404`), section
  and step numbers, list numbering, years, round figures (`5000`, `50%`), hedged or bounded
  numbers (`about 1700`, `p < 0.05`, `约1500`, `300左右`, `300+`), examples (`e.g. 150 ms`,
  `比如 150 ms`) and confidence levels (`95% CI`).

**A number has a source** when some number in a tool output, tool-call argument or user message of
the session rounds to it at the precision it is written. `0.873` is covered by `0.87312`, `1708` by
`1707.6`, `12.5%` by `0.125`, and `0.000312` by `3.12e-4`. Sources are read loosely: numbers inside
identifiers, JSON, tables and either comma reading all count. An extra source can only prevent a
flag, never cause one. The plugin's own notes are never counted as sources.

A number with a unit also has a source in another unit: `15.6 GB` is covered by a byte count
(decimal or binary), `125 MB` by `124763103`, `2.7 hours` by `9731` seconds, `1.63M` by `1630412`,
`42.7万` by `427113`, and `$18.32M` by `18,324.1` from a table kept in thousands.

**A number is derived** when the answer's other numbers give it:

- one step (`+ − × ÷`) on two numbers in the same paragraph: `4 × 96 = 384 GB`, or `5.72 TiB left`
  next to `594.28 of 600 TiB`. A percentage may also be the relative change of two numbers less
  than a factor 2 apart (`p95 is 9.5% worse`, 97.1 vs 88.7 ms) or a complement (`the other five
  take 23.7%` next to `76.3%`);
- a table column, wherever the answer cites it: the column's total or mean, a cell's share of the
  total, or one step on two of its cells (`three services together: 30,456,293` below a table of
  the three, `地铁或公交合计 1013 人`);
- working the answer writes next to the number, which the check evaluates:
  `3,987 + 1,764 + 258 + 2,655 = 8,664`, `1.3% (1/80)`. Working that does not give the number
  keeps it flagged, even when some other combination happens to match.

Only numbers that are sourced themselves, or too small or round to be checked, may be used, so
made-up numbers cannot vouch for each other (`469`, `181` and their sum `650` are all flagged, and
so is a table total over made-up rows). A derived number can be used for the next step.

## Limits

- Derivations of more than one step that the answer does not write out (`9,005 + 7 + 12`), or
  from tool numbers the answer does not repeat, are flagged. The note asks the model to show the
  working, so a right answer gets one sentence added, not rewritten.
- Within a table, one step on two cells of a column is accepted from anywhere in the answer, but
  two cells of a row only from the same paragraph. A step on rounded numbers is compared at the
  result's precision, so `541.38 − 412.88` does not account for `128.51`.
- The check reads numbers, not conclusions: a sentence that ranks or compares wrongly while every
  number is right ("North led the half year") passes.
- Short numbers are rarely caught (see "How it was tested"), and two sourced numbers swapped with
  each other are not caught at all.
- The number check runs only on sessions the plugin has watched from turn 1. On a resumed or forked
  session it cannot see the earlier tool output, so it skips numbers rather than guess. The failure
  check is unaffected.
- The checks see what dsh records: text content of tool results and the final assistant message.
  Images and files are not read.
- dsh is a developer preview and its plugin API may change. This version declares
  `engines.dsh: >=0.2.0 <0.3.0`.

## Development

```sh
npm install
npm test                      # pure-logic tests, no dsh needed
npm run build                 # lib/index.js
npm run test:dsh -- /path/to/deepseek-harness
node eval/replay-claude-code.ts [~/.claude/projects]
```

`test:dsh` copies the plugin into a dsh source checkout (after `pnpm install` there). It runs the
agent-loop tests against dsh's scripted mock model and type-checks the plugin under dsh's settings.

`eval/replay-claude-code.ts` replays both checks over local Claude Code transcripts and prints how
often a turn would be sent back and how many changed numbers are caught (Node 23.6+). It reads the
transcripts and writes nothing.

`eval/deepseek/` runs the plugin in dsh with a DeepSeek model on the twelve analysis tasks; its
README covers setup, the grading rubric and how to compare two versions on the same answers.

## Origin

The rules and their rationale come from AiScientist (Copyright (c) 2026 Chen Lab, University of
California, Irvine; MIT License). There they are `agents/step_numbers.py` and the step acceptance
rules. This plugin is a separate TypeScript implementation for dsh.

## License

MIT
