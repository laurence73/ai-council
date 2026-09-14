# AI Council - VS Code Extension

Multi-model code review powered by GPT-4, Grok, Claude, Gemini, and self-hosted Ollama models -
via API keys or CLI subscription logins (Claude Code, Codex, Grok CLI).

## Features

- **Review Current File / Review Current Commit** - Right-click, command palette, or the sidebar
- **Review with Scope** - Ask the council to focus on a specific question, then optionally run a
  multi-round **debate** between seats (all-to-all for 3 seats, arbiter-mediated for 4+) to reach
  consensus, then **consolidate** into one pruned final review or write it up as a doc
- **Independent API and CLI seats** - Each provider's API key and CLI subscription login are
  separate toggles, not an either/or choice - GPT API and Codex CLI can both be on as two
  distinct seats in the same review. Each CLI seat always uses whatever model that CLI is
  actually logged into/configured with - there's no in-extension model picker, and the sidebar
  shows the resolved model (or a login/setup error) next to each CLI toggle
- **Ollama / self-hosted seat** - Point at any OpenAI-compatible Ollama-style endpoint (e.g. a
  self-hosted model server) as a full seat, including arbiter eligibility
- **Power Mode** - Use premium models for deeper analysis
- **Live progress** - Real per-model progress while a review or debate round runs, not a static
  "Running..." message
- **Cost & Token Tracking** - Real token counts and cost per seat, including CLI seats; a seat
  that doesn't report usage says so honestly instead of showing a fabricated `0`
- **Consensus Detection** - High-confidence issues flagged by multiple models

## Requirements

1. **Python 3.8+** installed
2. **AI Council script** (`ai_council.py`, bundled)
3. At least one seat enabled in the sidebar - any mix of:
   - API keys (`ai-council.apiKeys.*` settings): OpenAI (GPT-4), Anthropic (Claude), xAI (Grok),
     Google (Gemini, free tier available)
   - CLI subscription logins: `claude`, `codex`, or `grok` CLI installed and logged in
   - An Ollama-compatible endpoint (`ai-council.ollamaUrl` / `ai-council.ollamaModel`)

## Installation

1. Install the extension from the VS Code Marketplace
2. Set `ai-council.scriptPath` in settings to point to `ai_council.py` (leave blank to use the bundled script)
3. Configure at least one seat: an API key, a logged-in CLI, or an Ollama endpoint

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `AI Council: Review Current File` | Standard review with all enabled seats |
| `AI Council: Review Current File (Power Mode)` | Premium models for better results |
| `AI Council: Review Current Commit` | Review the files currently staged for commit |
| `AI Council: Review with Scope` | Opens the sidebar's Review with Scope panel |
| `AI Council: Show Last Review` | Opens the most recently generated HTML report in your system browser |
| `AI Council: Clear Review Cache` | Delete all AI Council data for the workspace - review cache, Review with Scope sessions, and any debate/consolidation results not yet exported. Prompts for confirmation since this can't be undone. |

### Review with Scope

Open the sidebar, click **Review with Scope**, and describe what the council should focus on.
Once round 0 finishes, you can ask follow-ups, run a **debate** between the currently-enabled
seats (the arbiter/writer pickers reflect enabled seats immediately when the panel opens), and
**consolidate** the debate into a final pruned review or write it up as a review doc.

### Context Menu

Right-click on any code file to see AI Council options.

### Keyboard Shortcut

You can bind a keyboard shortcut to `ai-council.reviewFile` in your keybindings.

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `ai-council.pythonPath` | Path to Python | `python` |
| `ai-council.scriptPath` | Path to ai_council.py | Auto-detect (bundled script) |
| `ai-council.apiKeys.openai` / `.anthropic` / `.xai` / `.google` | API keys per provider | (none) |
| `ai-council.apiKeys.ollama` | Auth for the Ollama/self-hosted endpoint | - |
| `ai-council.ollamaUrl` | Ollama/self-hosted server URL | - |
| `ai-council.ollamaModel` | Model to use on the Ollama endpoint | - |
| `ai-council.autoReviewOnSave` | Run a full review immediately whenever a supported source file is saved. Needs the sidebar (or any AI Council command) to have run once this window session first - a save before that won't trigger a review. | `false` |
| `ai-council.reviewRubric` | What the council looks for (layer 2 of the review prompt) | Built-in default |

## Known limitations

- Ollama/self-hosted output is parsed tolerantly (messier than the API-based providers) and its
  real failures (e.g. a slow/unresponsive endpoint) are shown honestly rather than swallowed -
  if it's picked as debate arbiter/clusterer and is slow, that stage can take up to its full
  180s timeout before failing, which the UI now flags up front.
## License

MIT
