# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ogrsij/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ogrsij/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write — unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls — to a tree of files, exactly as SPEC.md specifies. Its matching tolerates wrong line numbers and drifted whitespace or indentation, and every patch applies all-or-nothing: either every file is updated, or none is. Node 22 and its standard library alone; no dependencies.

## Run it

```sh
node main.ts patch.diff
node main.ts - < patch.diff
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=z2men2sp&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
