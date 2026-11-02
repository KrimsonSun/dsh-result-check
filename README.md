# dsh-result-check

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that checks the agent's
final answer against what its tools actually returned, before the turn ends. When the two disagree,
it sends the model back once with a short note saying what to fix.

It runs two checks. Both are plain code, with no extra model call:

| Check | Fires when | Example |
|---|---|---|
| **Unreported tool failure** | A tool call failed, no later call to the same tool succeeded, and the answer never says anything failed | `web_fetch` returned HTTP 503 and the answer summarises the page anyway |
| **Unsourced number** | The answer states a number that no tool output, tool argument or user message in the session contains, at the precision the answer writes it | The tool reported `AC: DDX41 392 / WT 258` and the answer's table says `469 / 181` |

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
    maxNudgesPerTurn: 1
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
| `skipSubagents` | `false` | Leave subagents unchecked |
| `maxNudgesPerTurn` | `1` | Most times one turn is sent back |
| `maxListedNumbers` | `8` | Most numbers named in one note |

## How it decides

A wrong flag costs the user an extra step and teaches them to ignore the note. A missed problem
costs what it cost before the plugin existed. So when the reader is unsure, it stays quiet.

**A tool call failed** when dsh marks its result as an error, or when the result is a JSON object
whose `status` is a failure value. That covers MCP tools and most script tools. A shell command that
exits non-zero is **not** a failure, because the shell tool reports it as a normal result.
The failure counts as resolved once a later call to the same tool succeeds. The answer counts as
mentioning it when it says something failed, in English or Chinese ("failed", "could not", "timed
out", "失败", "无法", "超时", …).

**A number is checked** only when the answer states it as a value:

- Checked: decimals (`0.873`), integers of 3+ digits (`1,708`), percentages (`12.5%`), with or
  without a short unit (`1530ms`, `3.2GB`, `1.6x`), in English or Chinese text (`共1708个细胞`).
- Skipped: code blocks and inline code, URLs, file paths, versions, dates, times, `#123`
  references, identifiers (`H100`, `x86_64`), section and step numbers, list numbering, years,
  round figures (`5000`, `50%`), and hedged or bounded numbers (`about 1700`, `p < 0.05`, `约1500`,
  `300左右`).

**A number has a source** when some number in a tool output, tool-call argument or user message of
the session rounds to it at the precision it is written. `0.873` is covered by `0.87312`, `1708` by
`1707.6`, `12.5%` by `0.125`, and `0.000312` by `3.12e-4`. Sources are read loosely: numbers inside
identifiers, JSON, tables and either comma reading all count. An extra source can only prevent a
flag, never cause one. The plugin's own notes are never counted as sources.

## Limits

- Numbers the model **derived** (a sum, a ratio, a difference) have no source and will be flagged.
  The note asks the model to show the derivation, so a right answer gets one sentence added, not
  rewritten.
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
```

`test:dsh` copies the plugin into a dsh source checkout (after `pnpm install` there). It runs the
agent-loop tests against dsh's scripted mock model and type-checks the plugin under dsh's settings.

## Origin

The rules and their rationale come from AiScientist (Copyright (c) 2026 Chen Lab, University of
California, Irvine; MIT License). There they are `agents/step_numbers.py` and the step acceptance
rules. This plugin is a separate TypeScript implementation for dsh.

## License

MIT
