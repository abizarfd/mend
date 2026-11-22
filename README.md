# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/abizarfd/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/abizarfd/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. It applies an AI-written edit to a tree of text files, in four formats (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls), finding the lines each edit names at the first of three matching tiers, and writes every change or none. See SPEC.md for the whole contract.

## Run it

```sh
node main.ts [options] [PATCH]
```

`main.ts` is the CLI (Node 22, standard library only). `runner.ts` runs the trial checks beside it, and `check.ts` runs the public practice set:

```sh
node check.ts ../program/generator/practice.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=gz72ysdy&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
