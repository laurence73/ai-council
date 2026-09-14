# AI Council Review

Run multi-model code review with GPT-4, Grok, Claude, Gemini, and Ollama.

**Independent seats:** each provider's API key and CLI subscription login (`claude` / `codex` / `grok`) are separate seats, not an either/or choice — both can run in the same review. Reviews still run in parallel, then consensus / Council Verdict / fix — identical JSON shape regardless of which seat produced it.

**Arguments:** `<file_path> [flags]`

**Flags:**
- `--force` / `-f` — re-review (bypass cache)
- `--gemini` / `-g` — include Gemini
- `--ollama` — include Ollama
- `--ollama-url <url>` / `--ollama-model <model>`
- `--power` / `-p` — premium API model names (affects API seats only; CLI seats always use whatever model that CLI login already resolves to)
- `--html` / `-o <path>` — HTML report
- `--synthesize` / `-s` — Council Verdict
- `--synthesizer <model>` — claude | gpt-4 | gemini | grok | ollama
- `--gpt-cli` / `--claude-cli` / `--grok-cli` — enable that provider's CLI seat (global flags, must precede `review`)
- `--no-gpt` / `--no-claude` / `--no-grok` — disable that provider's API seat (all three API seats are on by default)

**Examples (PowerShell):**
```powershell
cd C:\z\ai-council\vscode-extension

# Claude via subscription CLI only; GPT/Grok API seats stay on if keys are set
python ai_council.py --claude-cli review "C:\path\to\File.cs" --synthesize --html

# Claude API + Claude CLI as two separate seats, skip GPT
python ai_council.py --claude-cli review ".\file.cs" --no-gpt --force

# API-only (needs keys), all three providers
python ai_council.py review ".\file.cs"
```

---

## Instructions

When the user runs this skill:

1. **Pick the file** (argument, or last edited in session, or ask).

2. **Prefer one council run** through `ai_council.py` so every seat shares the same pipeline (parallel review → aggregate → optional synthesize → optional fix).

3. **Choose seats** (do not invent a second Claude-only path outside the script unless the user asks):
   - GPT/Claude/Grok API seats are on by default if a key is configured; disable with `--no-gpt` / `--no-claude` / `--no-grok`.
   - Add a CLI seat for a provider with `--gpt-cli` / `--claude-cli` / `--grok-cli` when that CLI is installed and logged in - this is additive, not a replacement for the API seat.
   - Gemini / Ollama stay API / self-hosted (no subscription CLI).

4. **Run (Windows):**
   ```powershell
   python "C:\z\ai-council\vscode-extension\ai_council.py" [GLOBAL_FLAGS] review "<FILE_PATH>" [REVIEW_FLAGS]
   ```
   Global flags **before** `review`: `--ollama`, `--ollama-url`, `--ollama-model`, `--gpt-cli`, `--claude-cli`, `--grok-cli`, `--db`.

5. **Present results** from the script (scores, issues, consensus, verdict). Same format whether a seat used CLI or API.

6. **Offer to fix** from consensus / verdict priorities (`fix` subcommand or extension "Fix with AI").

---

## Cost notes

| Seat | CLI (subscription login) | API key |
|------|--------------------------|---------|
| Claude | Uses Claude Code login — no Anthropic API credits | `ANTHROPIC_API_KEY` |
| GPT | Uses `codex` login — no OpenAI API credits | `OPENAI_API_KEY` |
| Grok | Uses `grok login` — no xAI API credits | `XAI_API_KEY` |
| Gemini | n/a | Free-tier key |
| Ollama | n/a | Self-hosted |

CLI usage still counts against the product subscription; it just avoids a second metered API bill.

---

## Notes

- CLI seats need the binary on PATH (`claude`, `codex`, `grok`) and a prior login. A CLI seat always uses that login's own default model - there is no model override from this skill or the extension.
- Reviews are cached by file hash, power mode, resolved model ID, and rubric hash; `--force` refreshes.
- Independent-seat logic lives in `vscode-extension/cli_transport.py`.

## Self-hosted (Ollama)

No default endpoint is bundled - pass `--ollama-url` and `--ollama-model` explicitly (or configure `ai-council.ollamaUrl` / `ai-council.ollamaModel` in VS Code settings).
