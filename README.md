<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/laurence73/assets@main/logos/ai-council-logo.png" alt="AI Council Logo" width="200"/>
</p>

<h1 align="center">AI Council</h1>

<p align="center">
  <strong>Multi-Model Code Review System</strong><br>
  Get parallel code reviews from GPT-4, Grok, Claude, Gemini, and Ollama - find bugs that single-model reviews miss.
</p>

<p align="center">
  <a href="#vs-code-extension">VS Code Extension</a> -
  <a href="#quick-start">Quick Start</a> -
  <a href="#free-models">Free Models</a> -
  <a href="#power-mode">Power Mode</a> -
  <a href="#self-hosted-models">Self-Hosted Models</a>
</p>

---

## VS Code Extension

**Install the AI Council extension for VS Code!**

### Features

- **Side Panel UI** - Toggle models on/off with one click
- **Real-time Progress** - Watch each model complete with live score cards
- **Council Verdict** - AI-synthesized consensus from all reviews
- **Fix with AI** - Auto-fix issues using any reviewer model
- **Toggle Persistence** - Your selected reviewers are remembered across sessions
- **Status Panel** - View configured reviewers and connected accounts
- **Free vs Paid Grouping** - Clearly separated model tiers
- **Power Mode** - One-click switch to premium models
- **HTML Reports** - Beautiful, shareable review reports

### Installation (from Release)

1. Download `ai-council-0.1.0.vsix` from [Releases](https://github.com/laurence73/ai-council/releases)
2. In VS Code: `Ctrl+Shift+P` -> "Extensions: Install from VSIX..."
3. Select the downloaded file
4. Configure API keys in Settings (`Ctrl+,` -> search "AI Council")

### Installation (from Source)

See [Developer Setup](#developer-setup) below to build and install from source.

### Screenshot

The extension adds an AI Council icon to the Activity Bar with:

- **Free Models**: Gemini, Groq/Llama, Ollama (self-hosted)
- **Paid Models**: GPT-4, Claude, Grok
- **Options**: Power Mode toggle, Synthesizer selection
- **Actions**: Review Current File, Fix with AI
- **Tools**: Status, Clear Cache, Settings

---

## The Concept

Instead of relying on a single AI for code review, AI Council runs your code through **multiple models in parallel**:

| Model | Strengths |
|-------|-----------|
| **GPT-4** | Design patterns, .NET/Java idioms, comprehensive analysis |
| **Grok** | Direct feedback, code-optimized, catches edge cases |
| **Claude** | Security focus, nuanced reasoning, detailed explanations |
| **Gemini** | Different training data, unique perspective |
| **Ollama** | Self-hosted, private, no data leaves your network |

**Consensus = High Confidence**: When multiple models agree on an issue, it's almost certainly real.

**Unique Insights = Worth Investigating**: Each model catches things others miss.

---

## Free Models

Several models have **free tiers** - perfect for getting started!

| Provider | Model | Free Tier | Get API Key |
|----------|-------|-----------|-------------|
| **Google Gemini** | gemini-2.0-flash | 1M tokens/day | [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| **Groq** | Llama 3.1 70B | 14,400 req/day | [console.groq.com](https://console.groq.com/) |
| **Ollama** | Any local model | Unlimited (local) | [ollama.ai](https://ollama.ai/) |

### Using Free Models Only

```bash
# Use only Gemini (free)
python ai_council.py review myfile.cs --gemini --no-gpt --no-claude --no-grok
```

---

## Self-Hosted Models

AI Council supports self-hosted LLMs via **Ollama** or any **OpenAI-compatible API**.

### Local Ollama

```bash
# Start Ollama locally
ollama serve

# Use with AI Council
python ai_council.py review myfile.cs --ollama --ollama-url http://localhost:11434
```

### WoW AI (World of Workflows)

Connect to WoW AI's hosted Ollama instance:

```bash
python ai_council.py review myfile.cs --ollama \
  --ollama-url https://wowai-api.worldofworkflows.com:9443 \
  --ollama-model qwen3.6:35b-mlx
```

### VS Code Settings for Self-Hosted

| Setting | Default | Description |
|---------|---------|-------------|
| `ai-council.ollamaUrl` | `https://wowai-api.worldofworkflows.com:9443` | Ollama server URL |
| `ai-council.ollamaModel` | `qwen3.6:35b-mlx` | Model to use |
| `ai-council.apiKeys.ollama` | `user:pass` | Basic auth (user:pass) or Bearer token |

Supported models on WoW AI:
- `qwen3.6:35b-mlx` (default)
- `qwen3-coder-next:latest`
- `gemma4:12b-mlx`
- `llama3.2:latest`

---

## Quick Start

### 1. Install Dependencies

```bash
pip install openai httpx anthropic google-generativeai
```

### 2. Set API Keys

**Option A: Environment Variables**

```env
OPENAI_API_KEY=sk-...
XAI_API_KEY=xai-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=...          # FREE - Gemini
GROQ_API_KEY=...            # FREE - Llama via Groq
```

**Option B: VS Code Settings** (if using extension)

`Ctrl+,` -> Search "AI Council" -> Enter keys in settings fields

### 3. Review Your First File

```bash
python ai_council.py review "path/to/your/code.cs"
```

---

## Features

### Real-Time Progress Tracking

Watch as each model completes its review:

```
============================================================
  AI Council Review: MyService.cs
  Mode: Standard
============================================================
  Models:
    - GPT-4    -> gpt-4-turbo
    - GROK     -> grok-3-mini
    - CLAUDE   -> claude-sonnet-4-5
    - OLLAMA   -> qwen3.6:35b-mlx
============================================================

  [~] GPT-4 started...
  [~] GROK started...
  [~] CLAUDE started...
  [~] OLLAMA started...
  [+] GPT-4 Score: 7/10 (15.2s) [1/4]
  [+] GROK Score: 6/10 (18.5s) [2/4]
  [+] CLAUDE Score: 7/10 (22.1s) [3/4]
  [+] OLLAMA Score: 8/10 (45.3s) [4/4]

============================================================
  Review Complete - Total Time: 45.3s
============================================================
```

### Token Usage & Cost Tracking

Know exactly what each review costs:

```
[Token Usage]
  GPT-4    1,434 in / 608 out  (~$0.0326)
  GROK     1,616 in / 544 out  (~$0.0162)
  CLAUDE   1,766 in / 1,400 out  (~$0.0263)
  OLLAMA   2,100 in / 900 out   (~$0.0000)
  ----------------------------------------
  TOTAL    6,916 in / 3,452 out  (~$0.0751)
```

### Council Verdict (AI Synthesis)

After all models complete, get an AI-synthesized verdict:

- **Consensus Score** - Weighted average across all reviewers
- **Priority Issues** - Critical findings agreed upon by multiple models
- **Disputed Items** - Where models disagree (manual review needed)
- **False Positives** - Issues likely to be non-issues

### Fix with AI

Select any reviewer to auto-fix issues:

1. Complete a review
2. Click "Fix with AI" dropdown
3. Select a model (Claude, GPT-4, etc.)
4. Review the diff and apply changes

### Beautiful HTML Reports

Generate shareable HTML reports with the `--html` flag:

```bash
python ai_council.py review myfile.cs --html
```

Reports include:
- Score cards for each model
- Council Verdict synthesis
- Consensus issues highlighted
- Token usage breakdown
- Severity-coded issues (Critical, High, Medium, Low)
- Dark theme, responsive design

---

## Power Mode

Use cutting-edge premium models for the best possible review:

```bash
python ai_council.py review myfile.cs --power
```

### Model Comparison

| Mode | OpenAI | xAI | Anthropic | Google |
|------|--------|-----|-----------|--------|
| **Standard** | gpt-4-turbo | grok-3-mini | claude-sonnet-4-5 | gemini-2.0-flash |
| **Power** | gpt-6-astra | grok-3 | claude-fable-5-1 | gemini-2.5-pro |

### Cost Comparison

| Mode | Models | Est. Cost per Review |
|------|--------|---------------------|
| Standard | 3 models | ~$0.07 |
| Power | 3 models | ~$0.30-0.50 |
| **Free only** | Gemini + Ollama | **$0.00** |

---

## CLI Reference

### Review Commands

```bash
# Standard review (GPT-4 + Grok + Claude)
python ai_council.py review <file>

# Force re-review (bypass cache)
python ai_council.py review <file> --force

# Include Gemini (4 models)
python ai_council.py review <file> --gemini

# Include Ollama (self-hosted)
python ai_council.py review <file> --ollama --ollama-url http://localhost:11434

# Use premium models
python ai_council.py review <file> --power

# Generate HTML report with synthesis
python ai_council.py review <file> --html --synthesize

# Disable specific models
python ai_council.py review <file> --no-gpt --no-claude

# Free models only
python ai_council.py review <file> --gemini --ollama --no-gpt --no-claude --no-grok
```

### Fix Commands

```bash
# Fix issues using Claude
python ai_council.py fix <file> --fixer claude

# Fix issues using GPT-4
python ai_council.py fix <file> --fixer gpt-4
```

### Flags Reference

| Flag | Short | Description |
|------|-------|-------------|
| `--force` | `-f` | Bypass cache, force fresh review |
| `--gemini` | `-g` | Include Gemini in review |
| `--ollama` | | Include Ollama (self-hosted) |
| `--ollama-url` | | Ollama server URL |
| `--ollama-model` | | Ollama model name |
| `--no-gpt` | | Disable GPT-4 reviewer |
| `--no-claude` | | Disable Claude reviewer |
| `--no-grok` | | Disable Grok reviewer |
| `--power` | `-p` | Use premium models (higher cost) |
| `--html` | | Generate HTML report |
| `--synthesize` | | Generate AI council verdict |
| `--synthesizer` | | Model to use for synthesis (claude, gpt-4, etc.) |
| `--output` | `-o` | Custom output path for HTML |
| `--issues` | | Create GitHub issues for consensus findings |
| `--issues-all` | | Create GitHub issues for ALL findings |
| `--repo` | | Target repo for issues (default: current git repo) |

---

## API Keys

### Paid Models

| Provider | Get Key | Env Variable |
|----------|---------|--------------|
| OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) | `OPENAI_API_KEY` |
| xAI (Grok) | [console.x.ai](https://console.x.ai/) | `XAI_API_KEY` |
| Anthropic | [console.anthropic.com](https://console.anthropic.com/) | `ANTHROPIC_API_KEY` |

### Free Models

| Provider | Get Key | Env Variable |
|----------|---------|--------------|
| Google Gemini | [aistudio.google.com](https://aistudio.google.com/app/apikey) | `GOOGLE_API_KEY` |
| Groq (Llama) | [console.groq.com](https://console.groq.com/) | `GROQ_API_KEY` |
| Ollama | No key needed (local) | N/A |

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

Use the `/ai-council` skill in Claude Code for multi-model reviews with a **FREE Claude review**.

### How It Works

When you run `/ai-council` from Claude Code:

1. **GPT-4, Grok, Gemini, Ollama** - Use API keys (via Python script)
2. **Claude** - Reviewed directly by Claude Code using your subscription (**FREE**)

This saves ~$0.03 per review since Claude uses your existing subscription instead of API calls.

### Installation

Copy `commands/ai-council.md` from this repo to `~/.claude/commands/`:

```bash
cp commands/ai-council.md ~/.claude/commands/
```

Or create the file manually - see `commands/ai-council.md` for the full skill.

### Usage

```
/ai-council src/MyService.cs
/ai-council src/MyService.cs --html --gemini --ollama
/ai-council src/MyService.cs --power
```

### Cost Comparison

| Model | Via Skill | Via Extension |
|-------|-----------|---------------|
| Claude | **FREE** (subscription) | ~$0.03 (API) |
| GPT-4 | ~$0.03 | ~$0.03 |
| Grok | ~$0.02 | ~$0.02 |
| Gemini | FREE | FREE |
| Ollama | FREE | FREE |

---

## Architecture

```
                    Your Code
                        |
                        v
              +------------------+
              |   AI Council     |
              |   Orchestrator   |
              +------------------+
                   |    |    |    |
         +---------+    |    |    +---------+
         v              v    v              v
    +--------+    +--------+  +--------+  +--------+
    | GPT-4  |    |  Grok  |  | Claude |  | Ollama |
    +--------+    +--------+  +--------+  +--------+
         |              |          |           |
         +------+-------+----------+-----------+
                |
                v
         +-------------+
         |  Synthesis  |
         |   Engine    |
         +-------------+
                |
    +-----------+-----------+
    v           v           v
+--------+ +----------+ +--------+
|Console | |   HTML   | |VS Code |
|Output  | |  Report  | |Extension
+--------+ +----------+ +--------+
```

---

## Files

| File | Purpose |
|------|---------|
| `ai_council.py` | Main CLI and orchestrator |
| `reviews.db` | SQLite cache (auto-created) |
| `reports/` | Generated HTML reports |
| `vscode-extension/` | VS Code extension source |
| `.env` | API keys (gitignored) |

---

## Developer Setup

Clone the repo and build the VS Code extension locally.

### Prerequisites

- Node.js 18+
- Python 3.10+
- VS Code

### Clone and Build

```bash
# Clone the repo
git clone https://github.com/laurence73/ai-council.git
cd ai-council

# Install Python dependencies
pip install openai httpx anthropic google-generativeai

# Build the VS Code extension
cd vscode-extension
npm install
npm run compile
npm run package

# Install the extension
code --install-extension ai-council-0.1.0.vsix --force
```

### Development Workflow

```bash
cd vscode-extension

# Compile TypeScript (one-time)
npm run compile

# Or watch for changes (recommended during development)
npm run watch
```

After making changes:

```bash
# Rebuild and reinstall
npm run compile && npm run package && code --install-extension ai-council-0.1.0.vsix --force
```

Then reload VS Code (`Ctrl+Shift+P` -> "Developer: Reload Window").

### Project Structure

```
ai-council/
├── ai_council.py              # Main Python CLI (also bundled in extension)
├── README.md
├── commands/                   # Claude Code skills
│   ├── ai-council.md          # /ai-council skill
│   └── add-council-reviewer.md # Guide for adding new models
└── vscode-extension/
    ├── src/
    │   ├── extension.ts       # Extension entry point
    │   └── sidePanel.ts       # Main sidebar UI and logic
    ├── ai_council.py          # Bundled Python script
    ├── package.json           # Extension manifest and settings
    └── out/                    # Compiled JS (generated)
```

### Key Files to Know

| File | Purpose |
|------|---------|
| `vscode-extension/src/sidePanel.ts` | Main UI, message handlers, review logic |
| `vscode-extension/src/extension.ts` | Extension activation, commands |
| `vscode-extension/ai_council.py` | Python backend (bundled copy) |
| `vscode-extension/package.json` | Extension settings, commands, UI config |

### Testing Changes

1. Make edits to `.ts` files
2. Run `npm run compile` (or use `npm run watch`)
3. Run `npm run package`
4. Install: `code --install-extension ai-council-0.1.0.vsix --force`
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

See `commands/add-council-reviewer.md` for a complete checklist of all files and changes needed to add a new AI reviewer.

---

## License

MIT

---

<p align="center">
  <sub>Built with multiple AIs, for reviewing code with multiple AIs.</sub>
</p>
