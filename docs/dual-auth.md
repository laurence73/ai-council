# Dual auth (API + CLI)

AI Council can fill each paid reviewer seat with either:

1. **API** — `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `XAI_API_KEY`
2. **CLI** — local `codex` / `claude` / `grok` after subscription login

Both produce the same review JSON (`issues`, `summary`, `quality_score`), so consensus, Council Verdict, and fix behaviour stay the same.

## Settings / flags

| Seat | Setting | Flag | CLI binary |
|------|---------|------|------------|
| GPT | `ai-council.transport.openai` | `--transport-gpt` | `codex` |
| Claude | `ai-council.transport.anthropic` | `--transport-claude` | `claude` |
| Grok | `ai-council.transport.xai` | `--transport-grok` | `grok` |

Values: `api` | `cli` | `auto` (prefer CLI if installed, else API key).

Env (used by the VS Code extension too):
`AI_COUNCIL_TRANSPORT_OPENAI`, `AI_COUNCIL_TRANSPORT_ANTHROPIC`, `AI_COUNCIL_TRANSPORT_XAI`.

## PowerShell smoke test

```powershell
cd C:\z\ai-council\vscode-extension
python ai_council.py --transport-claude cli review ..\test-samples\VulnerableCode.cs --no-gpt --no-grok --force
```

Login once if needed: `claude login`, `grok login`, `codex login`.
