<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/laurence73/assets@main/logos/ai-council-logo.png" alt="AI Council Logo" width="200"/>
</p>

<h1 align="center">AI Council</h1>

<p align="center">
  <strong>Multi-Model Code Review System</strong><br>
  Get parallel code reviews from GPT-4, Grok, Claude, and Gemini - via API keys or your existing
  CLI subscriptions - plus any self-hosted Ollama-compatible model. Find bugs that single-model
  reviews miss.
</p>

<p align="center">
  <a href="#vs-code-extension">VS Code Extension</a> -
  <a href="#independent-seats">Independent Seats</a> -
  <a href="#power-mode">Power Mode</a> -
  <a href="#self-hosted-models">Self-Hosted Models</a> -
  <a href="#developer-setup">Developer Setup</a>
</p>

---

## VS Code Extension

**This is the primary way to use AI Council.** Everything below runs through
`vscode-extension/ai_council.py`, the extension's bundled Python engine - there is no separate
root-level CLI script.

### Features

- **Independent API + CLI seats** - Each provider's API key and CLI subscription login are
  separate toggles; both can run in the same review as distinct seats
- **Review Current File / Review Current Commit / Review with Scope** - from the sidebar,
  command palette, editor context menu, or Explorer
- **Debate + Consolidate** - Review with Scope can run a multi-round debate between seats to
  reach consensus, then consolidate into one pruned final review or a doc
- **Real-time Progress** - Watch each seat complete with live score cards
- **Council Verdict** - AI-synthesized consensus from all reviews
- **Fix with AI** - Auto-fix issues using any reviewer seat
- **Power Mode** - One-click switch to premium API models
- **HTML Reports** - Shareable review reports, opened in your browser
- **Ollama / self-hosted seat** - Any OpenAI-compatible endpoint, no bundled default

### Installation (from Release)

1. Download the `.vsix` from [Releases](https://github.com/laurence73/ai-council/releases)
2. In VS Code: `Ctrl+Shift+P` -> "Extensions: Install from VSIX..."
3. Select the downloaded file
4. Configure at least one seat in Settings (`Ctrl+,` -> search "AI Council")

### Installation (from Source)

See [Developer Setup](#developer-setup) below.

Full extension documentation (commands, settings, Review with Scope walkthrough) lives in
[`vscode-extension/README.md`](vscode-extension/README.md) - this file covers the project as a
whole.

---

## The Concept

Instead of relying on a single AI for code review, AI Council runs your code through **multiple
models in parallel**:

| Model | Strengths |
|-------|-----------|
| **GPT-4** | Design patterns, .NET/Java idioms, comprehensive analysis |
| **Grok** | Direct feedback, code-optimized, catches edge cases |
| **Claude** | Security focus, nuanced reasoning, detailed explanations |
| **Gemini** | Different training data, unique perspective |
| **Ollama** | Self-hosted, private, no data leaves your network |

**Consensus = High Confidence**: When multiple models agree on an issue, it's worth prioritizing.
Matching is by the first 50 characters of each issue's description, not a semantic
comparison - two differently-worded reports of the same bug can be counted as separate issues,
and two unrelated issues that happen to open with similar wording can be merged into one.

**Unique Insights = Worth Investigating**: Each model catches things others miss.

---

## Independent Seats

A provider's API key and its CLI subscription login are two separate, independently-enableable
seats - not an either/or choice. GPT API and Codex CLI can both be on in the same review.

- **API seats** (GPT-4, Claude, Grok, Gemini) - on by default from the raw `ai_council.py` CLI
  if a key is configured (disable with `--no-gpt` / `--no-claude` / `--no-grok`); the VS Code
  sidebar's own fresh-install toggle defaults are the other way around (CLI seats on, API seats
  off), since a developer's CLI subscription login is more often already set up than an API key
- **CLI seats** (Codex, Claude CLI, Grok CLI) - opt-in from the raw CLI (`--gpt-cli` /
  `--claude-cli` / `--grok-cli`), on by default in the sidebar; by default a CLI seat uses
  whatever model that CLI is actually logged into, but the raw CLI accepts an explicit
  `--claude-cli-model` / `--gpt-cli-model` / `--grok-cli-model` override per seat (the sidebar
  has no equivalent setting - it always uses the CLI's own default)
- **Ollama seat** - point at any OpenAI-compatible endpoint

If you already pay for a Claude, ChatGPT, or X subscription that includes CLI access, its
CLI seat costs nothing extra to run alongside (or instead of) that provider's API seat.

See [`docs/independent-seats.md`](docs/independent-seats.md) for the CLI flags.

---

## Power Mode

Switches API seats (GPT-4, Claude, Grok, Gemini) to premium model variants for deeper analysis.
CLI seats are unaffected - by default they use whatever model that CLI login resolves to, unless
overridden with `--claude-cli-model` / `--gpt-cli-model` / `--grok-cli-model`.

```bash
cd vscode-extension
python ai_council.py review myfile.cs --power
```

---

## Self-Hosted Models

AI Council supports self-hosted LLMs via **Ollama** or any **OpenAI-compatible API**. No default
endpoint is bundled - you provide the URL.

```bash
# Start Ollama locally
ollama serve

# Use with AI Council
cd vscode-extension
python ai_council.py --ollama --ollama-url http://localhost:11434 review myfile.cs
```

Or configure `ai-council.ollamaUrl` / `ai-council.ollamaModel` / `ai-council.apiKeys.ollama` in
VS Code settings.

---

## CLI Reference

All commands run from `vscode-extension/`:

```bash
cd vscode-extension
```

### Review Commands

```bash
# Standard review - GPT-4, Claude, Grok API seats (on by default)
python ai_council.py review <file>

# Force re-review (bypass cache)
python ai_council.py review <file> --force

# Include Gemini
python ai_council.py review <file> --gemini

# Add a CLI seat alongside the API seats
python ai_council.py --claude-cli review <file>

# Include Ollama (self-hosted)
python ai_council.py --ollama --ollama-url http://localhost:11434 review <file>

# Premium API models
python ai_council.py review <file> --power

# HTML report with Council Verdict synthesis
python ai_council.py review <file> --html --synthesize

# Disable specific API seats
python ai_council.py review <file> --no-gpt --no-claude
```

### Fix Commands

```bash
python ai_council.py fix <file> --fixer claude
python ai_council.py fix <file> --fixer gpt-4
```

### Flags Reference

| Flag | Short | Description |
|------|-------|-------------|
| `--force` | `-f` | Bypass cache, force fresh review |
| `--gemini` | `-g` | Include Gemini in review |
| `--ollama` | | Include Ollama (self-hosted, global flag) |
| `--ollama-url` | | Ollama server URL (global flag) |
| `--ollama-model` | | Ollama model name (global flag) |
| `--gpt-cli` / `--claude-cli` / `--grok-cli` | | Add that provider's CLI seat (global flags) |
| `--gpt-cli-model` / `--claude-cli-model` / `--grok-cli-model` | | Override the model a CLI seat uses instead of its login's default (global flags) |
| `--no-gpt` / `--no-claude` / `--no-grok` | | Disable that provider's API seat |
| `--power` | `-p` | Premium API models (higher cost) |
| `--html` | | Generate HTML report |
| `--synthesize` | | Generate AI Council Verdict |
| `--synthesizer` | | Seat to write the synthesis |
| `--output` | `-o` | Custom output path for HTML |

Global flags (`--ollama*`, `--*-cli`) must precede the subcommand.

---

## API Keys

| Provider | Get Key | Env Variable |
|----------|---------|--------------|
| OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) | `OPENAI_API_KEY` |
| xAI (Grok) | [console.x.ai](https://console.x.ai/) | `XAI_API_KEY` |
| Anthropic | [console.anthropic.com](https://console.anthropic.com/) | `ANTHROPIC_API_KEY` |

### Free Models

| Provider | Get Key | Env Variable |
|----------|---------|--------------|
| Google Gemini | [aistudio.google.com](https://aistudio.google.com/app/apikey) | `GOOGLE_API_KEY` |
| Ollama | No key needed (local) | N/A |

Groq/Llama is tracked as issue #33 but not yet implemented - there's no
`ai-council.apiKeys.groq` setting or reviewer, and the sidebar shows it as a disabled item.

---

## Roadmap

### Completed

- [x] VS Code Extension - Side Panel UI
- [x] API Key Settings in VS Code
- [x] Free vs Paid Model Grouping
- [x] Real-time Progress Cards
- [x] Council Verdict Synthesis
- [x] Fix with AI
- [x] Toggle State Persistence
- [x] Ollama/Self-hosted Model Support
- [x] Status Panel with Account Info
- [x] Power Mode Toggle
- [x] CLI Subscription Seats - Claude/Codex/Grok CLIs as independent seats alongside API keys

### Coming Soon

| Feature | Status |
|---------|--------|
| Mistral Codestral | Planned |
| DeepSeek Coder | Planned |
| Qwen 2.5 Coder | Planned |
| Cohere Command R+ | Planned |
| VS Code Diagnostics Integration | Planned |

---

## Claude Code Integration

Use the `/ai-council` skill in Claude Code for multi-model reviews from within a Claude Code
session. See [`commands/ai-council.md`](commands/ai-council.md) for the full skill and flags.

```bash
cp commands/ai-council.md ~/.claude/commands/
```

```
/ai-council src/MyService.cs
/ai-council src/MyService.cs --html --gemini --claude-cli
```

---

## Files

| File | Purpose |
|------|---------|
| `vscode-extension/ai_council.py` | Main CLI and orchestrator (the only copy that runs) |
| `vscode-extension/cli_transport.py` | CLI-seat subprocess handling (claude/codex/grok) |
| `vscode-extension/` | VS Code extension source and bundled Python engine |
| `.ai-council/reviews.db` | SQLite cache (auto-created per workspace) |
| `.ai-council/reports/` | Generated HTML reports (auto-created per workspace) |

---

## Developer Setup

Clone the repo and build the VS Code extension locally.

### Prerequisites

- Node.js 18+
- Python 3.10+
- VS Code

### Clone and Build

```bash
git clone https://github.com/laurence73/ai-council.git
cd ai-council/vscode-extension

pip install -r ../requirements.txt

npm install
npm run compile
npm run package

code --install-extension ai-council-0.1.0.vsix --force
```

### Development Workflow

```bash
cd vscode-extension
npm run compile   # one-time
npm run watch      # or watch for changes
```

After making changes:

```bash
npm run compile && npm run package && code --install-extension ai-council-0.1.0.vsix --force
```

Then reload VS Code (`Ctrl+Shift+P` -> "Developer: Reload Window").

### Project Structure

```
ai-council/
├── README.md
├── commands/                       # Claude Code skills
│   ├── ai-council.md               # /ai-council skill
│   └── add-council-reviewer.md     # Guide for adding new models
├── docs/
│   └── independent-seats.md        # Independent API/CLI seat reference
└── vscode-extension/
    ├── src/
    │   ├── extension.ts            # Extension entry point - delegates to the sidebar
    │   └── sidePanel.ts            # Sidebar UI, message handlers, review logic
    ├── ai_council.py               # Python backend (the only copy that runs)
    ├── cli_transport.py            # CLI-seat subprocess handling
    ├── package.json                # Extension manifest and settings
    └── out/                        # Compiled JS (generated)
```

### Key Files to Know

| File | Purpose |
|------|---------|
| `vscode-extension/src/sidePanel.ts` | Main UI, message handlers, review logic, the only spawn path |
| `vscode-extension/src/extension.ts` | Extension activation, commands - delegates to sidePanel |
| `vscode-extension/ai_council.py` | Python backend |
| `vscode-extension/cli_transport.py` | CLI-seat (claude/codex/grok) subprocess handling |
| `vscode-extension/package.json` | Extension settings, commands, menu wiring |

### Testing Changes

1. Make edits to `.ts` files
2. `npm run compile` (or `npm run watch`)
3. `npm run package`
4. `code --install-extension ai-council-0.1.0.vsix --force`
5. Reload VS Code window
6. Test in the AI Council sidebar

### Debugging

- Open DevTools: `Ctrl+Shift+I` or `F12`
- Check Console for `AI Council:` log messages
- Extension Host logs show Python output

---

## Contributing

Contributions welcome! Please open an issue first to discuss proposed changes.

### Adding a New Model

See `commands/add-council-reviewer.md` for a complete checklist of all files and changes needed
to add a new AI reviewer.

---

## License

MIT

---

<p align="center">
  <sub>Built with multiple AIs, for reviewing code with multiple AIs.</sub>
</p>
