# DeepSeek eval

Runs the plugin inside DeepSeek Harness on twelve data-analysis tasks with a real DeepSeek model,
and records, for every run, the first answer (what the user gets without the plugin), the
plugin's note and the answer after it. The README's "How it was tested" reports the results.

The tasks cover single-cell counts, a DE gene table, an RNA-seq pipeline, an access log, a weekly
service report, disk usage, a benchmark, training runs, a clinical trial, an income statement,
sales data and a Chinese survey. Some contain traps: a benchmark config that crashed, a metrics
call that times out, a training run the tracking server cannot find, a failed pipeline step next
to an old report, and condition and reference labels that are easy to swap. Data behind the MCP
tools is served by `mcp-server.mjs` and is not in the workspace, so the model can reach it only
through the tools.

## Setup

1. `npm install` here (the MCP server's dependencies), then `python3 make_tasks.py` to write
   `tasks/` and `mcp-data/` with the ground truth.
2. Build the plugin (`npm install && npm run build` at the repository root).
3. Make a headless profile that loads it, and put the key in that home's `.env`:

   ```sh
   export DSH_HOME=/path/to/a/dsh/home
   dsh --profile result-check-eval --from-default-profile headless --help
   dsh plugin --profile result-check-eval add /path/to/dsh-result-check
   echo 'DEEPSEEK_API_KEY=sk-…' > "$DSH_HOME/.env" && chmod 600 "$DSH_HOME/.env"
   ```

## Run

```sh
DSH_HOME=… DSH_CMD=dsh node run.mjs deepseek-flash 3     # 12 tasks × 3 runs
DSH_HOME=… DSH_CMD=dsh node run.mjs deepseek-v4-pro 2
node extract.mjs                                         # summary.jsonl and review/<task>.md
```

`DSH_CMD` is anything that runs the dsh CLI, for example a script that starts it from a source
checkout. A run with `meta.json` is skipped, so `run.mjs` can be resumed.

## Grade and compare

- `GRADING.md` is the rubric. Each answer is checked against the truth in `tasks/<task>/task.json`
  and the data. The published numbers were graded by Claude subagents, one per two tasks, which
  verified every computed value with Python. `aggregate.py` combines `grades/*.json` with
  `summary.jsonl`.
- `node replay.mjs <src dir>` replays the number check of any version of `src/` on the recorded
  sessions (it reads the full tool results from the session log, as the plugin does), so two
  versions can be compared on the same answers.
- `node inject.mjs <old src> <new src>` changes one sourced number per answer (last digit + 1, or
  × 1.2) and reports how often each version flags it.
