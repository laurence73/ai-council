<p align="center">
  <img src="https://cdn.jsdelivr.net/gh/laurence73/assets@main/logos/ai-council-logo.png" alt="AI Council Logo" width="200"/>
</p>

<h1 align="center">AI Council</h1>

<p align="center">
  <strong>Multi-Model Code Review System</strong><br>
  Get parallel code reviews from GPT-4, Grok, Claude, and Gemini - find bugs that single-model reviews miss.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> -
  <a href="#features">Features</a> -
  <a href="#power-mode">Power Mode</a> -
  <a href="#claude-code-integration">Claude Code Integration</a>
</p>

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

## Quick Start

### 1. Install Dependencies

```bash
pip install openai httpx anthropic
```

### 2. Set API Keys

Create a `.env` file in the AI Council directory:

```env
OPENAI_API_KEY=sk-...
XAI_API_KEY=xai-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=...          # Optional, for Gemini
```

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

Power mode shows a warning before running:

```
[!] POWER MODE ENABLED - Using premium models (higher cost)
    Estimated cost: ~$0.30-0.50 per review

[+] GPT-4 reviewer enabled (gpt-6-astra)
[+] Grok reviewer enabled (grok-3)
[+] Claude reviewer enabled (claude-fable-5-1)
```

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

# Combine flags
python ai_council.py review <file> --power --html --force

# Custom output path for HTML
python ai_council.py review <file> --html --output "C:/reports/my-review.html"
```

### Other Commands

```bash
# Show cached reviews for a file
python ai_council.py show <file>

# Check system status
python ai_council.py status

# Queue file for background review
python ai_council.py queue <file> --priority high

# Process queued reviews
python ai_council.py process

# Watch directory for changes
python ai_council.py watch --path "C:\your\project"
```

### Flags Reference

| Flag | Short | Description |
|------|-------|-------------|
| `--force` | `-f` | Bypass cache, force fresh review |
| `--gemini` | `-g` | Include Gemini in review |
| `--power` | `-p` | Use premium models (higher cost) |
| `--html` | | Generate HTML report |
| `--output` | `-o` | Custom output path for HTML |
| `--issues` | | Create GitHub issues for consensus findings |
| `--issues-all` | | Create GitHub issues for ALL findings |
| `--repo` | | Target repo for issues (default: current git repo) |

---

## Auto-Create GitHub Issues

Automatically create GitHub issues for problems found during code review:

```bash
# Create issues in current repo (consensus findings only)
python ai_council.py review myfile.cs --issues

# Create issues in a specific repo
python ai_council.py review myfile.cs --issues --repo owner/repo

# Create issues for ALL findings (not just consensus)
python ai_council.py review myfile.cs --issues-all
```

Issues are created with:
- Severity-based labels (critical, high, medium, low)
- File path and line number
- Full description and recommendation
- List of models that found the issue

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

### Auto-Queue on Edit (Hooks)

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "^(Edit|Write)$",
        "command": "python \"C:/AI COUNCIL/queue_review.py\" \"$TOOL_INPUT_file_path\""
      }
    ]
  }
}
```

Now every file Claude edits automatically gets queued for multi-model review!

---

## Model Pricing

### Standard Models (Default)

| Provider | Model | Input (per 1M) | Output (per 1M) |
|----------|-------|----------------|-----------------|
| OpenAI | gpt-4-turbo | $10.00 | $30.00 |
| xAI | grok-3-mini | $5.00 | $15.00 |
| Anthropic | claude-sonnet-4-5 | $3.00 | $15.00 |
| Google | gemini-2.0-flash | $0.075 | $0.30 |

### Power Models (`--power`)

| Provider | Model | Input (per 1M) | Output (per 1M) |
|----------|-------|----------------|-----------------|
| OpenAI | gpt-6-astra | $5.00 | $20.00 |
| xAI | grok-3 | $3.00 | $15.00 |
| Anthropic | claude-fable-5-1 | $10.00 | $50.00 |
| Google | gemini-2.5-pro | $1.25 | $10.00 |

---

## API Keys

| Provider | Get Key | Env Variable |
|----------|---------|--------------|
| OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) | `OPENAI_API_KEY` |
| xAI (Grok) | [console.x.ai](https://console.x.ai/) | `XAI_API_KEY` |
| Anthropic | [console.anthropic.com](https://console.anthropic.com/) | `ANTHROPIC_API_KEY` |
| Google | [makersuite.google.com](https://makersuite.google.com/app/apikey) | `GOOGLE_API_KEY` |

---

## Monthly Cost Estimates

### Per Review (typical 500-line file)

| Mode | Models | Cost |
|------|--------|------|
| Standard (3 models) | GPT-4 + Grok + Claude | ~$0.07 |
| Standard + Gemini | All 4 models | ~$0.08 |
| Power (3 models) | Astra + Grok-3 + Fable | ~$0.35 |
| Power + Gemini | All 4 premium | ~$0.45 |

### Monthly Usage

| Reviews/Day | Standard | Power |
|-------------|----------|-------|
| 10 | ~$21/month | ~$105/month |
| 30 | ~$63/month | ~$315/month |
| 50 | ~$105/month | ~$525/month |

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
|Console | |   HTML   | | Claude |
|Output  | |  Report  | |  Code  |
+--------+ +----------+ +--------+
```

---

## Files

| File | Purpose |
|------|---------|
| `ai_council.py` | Main CLI and orchestrator |
| `reviews.db` | SQLite cache (auto-created) |
| `reports/` | Generated HTML reports |
| `.env` | API keys (gitignored) |

---

## Roadmap

See [GitHub Issues](https://github.com/laurence73/ai-council/issues) for planned features:

- [ ] VS Code Extension - Basic (#22)
- [ ] VS Code Extension - Diagnostics Integration (#23)
- [ ] VS Code Extension - Side Panel UI (#24)
- [ ] VS Code Extension - Native TypeScript (#25)
- [ ] VS Code Extension - Language Server Protocol (#26)
- [ ] Visual Studio Extension (#27)

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
