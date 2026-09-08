# AI Council

**Multi-Model Code Review System** - Get parallel code reviews from GPT-4, Grok, and Gemini while you develop.

## The Concept

Instead of relying on a single AI for code review, AI Council runs your code through multiple models in parallel:

- **GPT-4** - Strong at design patterns, .NET/Java idioms
- **Grok** - Direct, less filtered feedback
- **Gemini** - Different training data, catches different issues

When multiple models agree on an issue = **high confidence**. Unique insights = **worth investigating**.

## Quick Start

### 1. Install Dependencies

```bash
cd "C:\AI COUNCIL"
pip install -r requirements.txt
```

### 2. Set API Keys

```powershell
# PowerShell (permanent - requires terminal restart)
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "sk-...", "User")
[Environment]::SetEnvironmentVariable("XAI_API_KEY", "xai-...", "User")
```

Or create a `.env` file (gitignored - won't be committed):
```
OPENAI_API_KEY=sk-...
XAI_API_KEY=xai-...
```

### 3. Test It

```bash
# Check status
python ai_council.py status

# Review a file
python ai_council.py review "C:\path\to\your\code.cs"

# Show cached reviews
python ai_council.py show "C:\path\to\your\code.cs"
```

## CLI Commands

```bash
# Review a file (runs GPT-4 + Grok in parallel)
python ai_council.py review <file>

# Force re-review (ignore cache)
python ai_council.py review <file> --force

# Show existing reviews
python ai_council.py show <file>

# Queue for background review
python ai_council.py queue <file>
python ai_council.py queue <file> --priority high

# Process queued reviews
python ai_council.py process

# Watch directory for changes (daemon mode)
python ai_council.py watch --path "C:\your\project"

# Check status
python ai_council.py status
```

### Windows Batch

```cmd
ai-council.bat review "path\to\file.cs"
ai-council.bat status
```

## Claude Code Integration

### Option A: Auto-Queue on Edit (Hooks)

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

Now every file Claude edits gets queued for GPT-4/Grok review!

### Option B: Query from Claude (MCP Server)

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "ai-council": {
      "command": "python",
      "args": ["C:/AI COUNCIL/mcp_server.py"],
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "XAI_API_KEY": "xai-..."
      }
    }
  }
}
```

Then Claude can call:
- `mcp__ai-council__get_reviews` - Check what other AIs think
- `mcp__ai-council__request_review` - Queue immediate review
- `mcp__ai-council__get_consensus` - Get agreement summary
- `mcp__ai-council__council_status` - Check active reviewers

## API Keys

| Model | Get Key |
|-------|---------|
| GPT-4 | https://platform.openai.com/api-keys |
| Grok | https://console.x.ai/ |
| Gemini | https://makersuite.google.com/app/apikey |

## Cost Estimate

| Model | ~Cost Per Review | Monthly (30/day) |
|-------|------------------|------------------|
| GPT-4 Turbo | ~$0.05 | ~$45 |
| Grok | ~$0.03 | ~$27 |
| Gemini Pro | ~$0.02 | ~$18 |

## Files

| File | Purpose |
|------|---------|
| `ai_council.py` | Main CLI and orchestrator |
| `queue_review.py` | Quick queue script for hooks |
| `mcp_server.py` | MCP server for Claude integration |
| `reviews.db` | SQLite database (auto-created, gitignored) |

## Architecture

```
Your Editor / Claude Code
         |
         | edits files
         v
    Git Repository
         |
         v
   AI Council Watcher
         |
    +----+----+
    v    v    v
  GPT-4 Grok Gemini
    |    |    |
    +----+----+
         v
    reviews.db
         |
    +----+----+
    v    v    v
   CLI  MCP  Dashboard
```

## License

MIT
