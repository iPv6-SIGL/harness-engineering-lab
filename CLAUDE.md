@AGENTS.md

## Claude Code specifics

- Skills `brief-check` and `decide`, agents `builder` and `reviewer`: in
  `harness/.claude/` (copied into each app's `.claude/` by `harness plan`).
- The guard hook is wired in `<app>/.claude/settings.json`: it is active when
  you work inside an app folder.
- The repo lives in WSL: run commands through Ubuntu, not the Windows shell.
