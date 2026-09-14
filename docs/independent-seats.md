# Independent API + CLI seats

AI Council can fill a provider's seat with an API key, a CLI subscription login, or both at once - each is its own independent seat, not an either/or choice.

1. **API seat** — `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `XAI_API_KEY`, on by default with no enabling flag needed; disable with `--no-gpt` / `--no-claude` / `--no-grok`
2. **CLI seat** — local `codex` / `claude` / `grok` after subscription login, enabled via `--gpt-cli` / `--claude-cli` / `--grok-cli`

Both produce the same review JSON (`issues`, `summary`, `quality_score`), so consensus, Council Verdict, and fix behaviour stay the same. Enabling both an API seat and a CLI seat for the same provider runs them as two distinct reviewers in the same council.

A CLI seat always uses whatever model that CLI is actually logged into - there is no in-extension model override. The sidebar shows the resolved model (or a login/setup error) next to each CLI toggle.

## Flags

| Seat | API flag | CLI flag | CLI binary |
|------|----------|----------|------------|
| GPT | `--no-gpt` (disable; on by default) | `--gpt-cli` | `codex` |
| Claude | `--no-claude` (disable; on by default) | `--claude-cli` | `claude` |
| Grok | `--no-grok` (disable; on by default) | `--grok-cli` | `grok` |

CLI seat flags are global (must precede the subcommand).

## PowerShell smoke test

```powershell
cd C:\z\ai-council\vscode-extension
python ai_council.py --claude-cli review ..\test-samples\VulnerableCode.cs --no-gpt --no-grok --force
```

Login once if needed: `claude login`, `grok login`, `codex login`.
