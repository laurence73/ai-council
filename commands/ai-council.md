# AI Council Review

Run multi-model code review with GPT-4, Grok, Claude, Gemini, and Ollama.

**Same end result either way:** each paid seat can use an **API key** or your **subscription CLI** (`claude` / `codex` / `grok`). Reviews still run in parallel, then consensus / Council Verdict / fix — identical JSON shape.

**Arguments:** `<file_path> [flags]`

**Flags:**
- `--force` / `-f` — re-review (bypass cache)
- `--gemini` / `-g` — include Gemini
- `--ollama` — include Ollama
- `--ollama-url <url>` / `--ollama-model <model>`
- `--power` / `-p` — premium model names (API path)
- `--html` / `-o <path>` — HTML report
- `--synthesize` / `-s` — Council Verdict
- `--synthesizer <model>` — claude | gpt-4 | gemini | grok | ollama
- `--transport-claude api|cli|auto` — Claude seat auth (default: env / auto)
- `--transport-gpt api|cli|auto` — GPT seat via API key or `codex` CLI
- `--transport-grok api|cli|auto` — Grok seat via API key or `grok` CLI
- `--no-gpt` / `--no-claude` / `--no-grok` — disable a seat

**Examples (PowerShell):**
```powershell
cd C:\z\ai-council\vscode-extension

# Claude via subscription CLI; others via API keys if set
python ai_council.py --transport-claude cli review "C:\path\to\File.cs" --synthesize --html

# Mixed: Claude + Grok on CLI, skip GPT
python ai_council.py --transport-claude cli --transport-grok cli review ".\file.cs" --no-gpt --force

# Classic API-only (needs keys)
python ai_council.py --transport-claude api --transport-gpt api --transport-grok api review ".\file.cs"
```

---

## Instructions

When the user runs this skill:

1. **Pick the file** (argument, or last edited in session, or ask).

2. **Prefer one council run** through `ai_council.py` so every seat shares the same pipeline (parallel review → aggregate → optional synthesize → optional fix).

3. **Choose auth per seat** (do not invent a second Claude-only path outside the script unless the user asks):
   - Default for Claude/GPT/Grok: `cli` when the CLI is installed and logged in, else `api` if a key exists (`auto`).
   - Gemini / Ollama stay API / self-hosted (no subscription CLI).
   - VS Code settings: `ai-council.transport.anthropic` / `.openai` / `.xai` = `api` | `cli` | `auto`.

4. **Run (Windows):**
   ```powershell
   python "C:\z\ai-council\vscode-extension\ai_council.py" [GLOBAL_FLAGS] review "<FILE_PATH>" [REVIEW_FLAGS]
   ```
   Global flags **before** `review`: `--ollama`, `--ollama-url`, `--ollama-model`, `--transport-claude`, `--transport-gpt`, `--transport-grok`, `--db`.

5. **Present results** from the script (scores, issues, consensus, verdict). Same format whether a seat used CLI or API.

6. **Offer to fix** from consensus / verdict priorities (`fix` subcommand or extension “Fix with AI”).

---

## Cost notes

| Seat | CLI (subscription login) | API key |
|------|--------------------------|---------|
| Claude | Uses Claude Code login — no Anthropic API credits | `ANTHROPIC_API_KEY` |
| GPT | Uses `codex` login — no OpenAI API credits | `OPENAI_API_KEY` |
| Grok | Uses `grok login` — no xAI API credits | `XAI_API_KEY` |
| Gemini | n/a | Free-tier key |
| Ollama | n/a | Self-hosted / WoW AI |

CLI usage still counts against the product subscription; it just avoids a second metered API bill.

---

## Notes

- CLI seats need the binary on PATH (`claude`, `codex`, `grok`) and a prior login.
- Reviews are cached by file hash; `--force` refreshes.
- Dual auth lives in `vscode-extension/cli_transport.py` + transport settings in the VS Code extension.

## Self-hosted (Ollama)

Default WoW AI endpoint:
- URL: `https://wowai-api.worldofworkflows.com:9443`
- Model: `qwen3.6:35b-mlx`
