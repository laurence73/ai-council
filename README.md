<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/laurence73/assets@main/logos/ai-council-logo.png" alt="AI Council Logo" width="200"/>
</p>

<h1 align="center">AI Council</h1>

<p align="center">
  <strong>Multi-Model Code Review System</strong><br>
  Get parallel code reviews from GPT-4, Grok, Claude, and Gemini - find bugs that single-model reviews miss.
</p>

<p align="center">
  <a href="#vs-code-extension">VS Code Extension</a> -
  <a href="#quick-start">Quick Start</a> -
  <a href="#free-models">Free Models</a> -
  <a href="#power-mode">Power Mode</a>
</p>

---

## VS Code Extension

**Install the AI Council extension for VS Code!**

### Features

- Side panel with model toggles
- One-click code review
- Free vs Paid model grouping
- API key settings in VS Code
- Real-time progress tracking
- HTML report generation

### Installation

1. Download `ai-council-0.1.0.vsix` from [Releases](https://github.com/laurence73/ai-council/releases)
2. In VS Code: `Ctrl+Shift+P` -> "Extensions: Install from VSIX..."
3. Select the downloaded file
4. Configure API keys in Settings (`Ctrl+,` -> search "AI Council")

### Screenshot

The extension adds an AI Council icon to the Activity Bar with:

- **Free Models**: Gemini, Groq/Llama, Ollama (local)
- **Paid Models**: GPT-4, Claude, Grok, + more coming soon
- **Options**: Power Mode, HTML Report toggle
- **Actions**: Review Current File, Power Review
- **Tools**: Check Status, Clear Cache, Settings

---

## The Concept

Instead of relying on a single AI for code review, AI Council runs your code through **multiple models in parallel**:

| Model | Strengths |
|-------|-----------|
| **GPT-4** | Design patterns, .NET/Java idioms, comprehensive analysis |
| **Grok** | Direct feedback, code-optimized, catches edge cases |
| **Claude** | Security focus, nuanced reasoning, detailed explanations |
| **Gemini** | Different training data, unique perspective |

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
============================================================

  [~] GPT-4 started...
  [~] GROK started...
  [~] CLAUDE started...
  [+] GPT-4 Score: 7/10 (15.2s) [1/3]
  [+] GROK Score: 6/10 (18.5s) [2/3]
  [+] CLAUDE Score: 7/10 (22.1s) [3/3]

============================================================
  Review Complete - Total Time: 22.1s
============================================================
```

### Token Usage & Cost Tracking

Know exactly what each review costs:

```
[Token Usage]
  GPT-4    1,434 in / 608 out  (~$0.0326)
  GROK     1,616 in / 544 out  (~$0.0162)
  CLAUDE   1,766 in / 1,400 out  (~$0.0263)
  ----------------------------------------
  TOTAL    4,816 in / 2,552 out  (~$0.0751)
```

### Beautiful HTML Reports

Generate shareable HTML reports with the `--html` flag:

```bash
python ai_council.py review myfile.cs --html
```

Reports include:
- Score cards for each model
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
| **Free only** | Gemini | **$0.00** |

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

# Use premium models
python ai_council.py review <file> --power

# Generate HTML report
python ai_council.py review <file> --html

# Disable specific models
python ai_council.py review <file> --no-gpt --no-claude

# Free models only
python ai_council.py review <file> --gemini --no-gpt --no-claude --no-grok
```

### Flags Reference

| Flag | Short | Description |
|------|-------|-------------|
| `--force` | `-f` | Bypass cache, force fresh review |
| `--gemini` | `-g` | Include Gemini in review |
| `--no-gpt` | | Disable GPT-4 reviewer |
| `--no-claude` | | Disable Claude reviewer |
| `--no-grok` | | Disable Grok reviewer |
| `--power` | `-p` | Use premium models (higher cost) |
| `--html` | | Generate HTML report |
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

- [x] VS Code Extension - Basic (#22)
- [x] VS Code Extension - Side Panel UI (#24)
- [x] API Key Settings in VS Code
- [x] Free vs Paid Model Grouping

### Coming Soon - New Models

| Issue | Model | Type | Status |
|-------|-------|------|--------|
| [#30](https://github.com/laurence73/ai-council/issues/30) | Mistral Codestral | Paid | Planned |
| [#31](https://github.com/laurence73/ai-council/issues/31) | DeepSeek Coder | Paid | Planned |
| [#32](https://github.com/laurence73/ai-council/issues/32) | Qwen 2.5 Coder | Paid | Planned |
| [#33](https://github.com/laurence73/ai-council/issues/33) | Llama 3.1 (Groq) | **FREE** | Planned |
| [#34](https://github.com/laurence73/ai-council/issues/34) | Cohere Command R+ | Paid | Planned |
| [#35](https://github.com/laurence73/ai-council/issues/35) | Ollama (Local) | **FREE** | Planned |

### Future

- [ ] VS Code Extension - Diagnostics Integration (#23)
- [ ] VS Code Extension - Native TypeScript (#25)
- [ ] VS Code Extension - Language Server Protocol (#26)
- [ ] Visual Studio Extension (#27)

---

## Claude Code Integration

### Custom Slash Command

Create `~/.claude/commands/ai-council.md`:

```markdown
# AI Council Review

Run multi-model code review using GPT-4, Grok, and Claude.

**Arguments:** `<file_path> [flags]`

**Flags:**
- `--force` or `-f` - Force re-review
- `--gemini` or `-g` - Include Gemini
- `--power` or `-p` - Use premium models
- `--html` - Generate HTML report

## Instructions

Run: python "C:/AI COUNCIL/ai_council.py" review "<FILE>" <FLAGS>
```

Then use in Claude Code:

```
/ai-council src/MyService.cs --html
/ai-council src/MyService.cs --power --html
```

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
                   |    |    |
         +---------+    |    +---------+
         v              v              v
    +--------+    +--------+    +--------+
    | GPT-4  |    |  Grok  |    | Claude |
    +--------+    +--------+    +--------+
         |              |              |
         +------+-------+------+-------+
                |              |
                v              v
         +----------+    +----------+
         | Consensus|    |  SQLite  |
         | Engine   |    |  Cache   |
         +----------+    +----------+
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

## Contributing

Contributions welcome! Please open an issue first to discuss proposed changes.

---

## License

MIT

---

<p align="center">
  <sub>Built with multiple AIs, for reviewing code with multiple AIs.</sub>
</p>
