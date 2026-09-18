# AI Council Review

Run multi-model code review using GPT-4, Grok, Gemini, Ollama, and Claude (via your subscription).

**Arguments:** `<file_path> [flags]`

**Flags:**
- `--force` or `-f` - Force re-review (bypass cache)
- `--gemini` or `-g` - Include Gemini in the review
- `--ollama` - Include Ollama (self-hosted model)
- `--ollama-url <url>` - Ollama server URL (default: wowai-api)
- `--ollama-model <model>` - Ollama model name (default: qwen3.6:35b-mlx)
- `--power` or `-p` - Use premium models (higher cost, better results)
- `--html` - Generate a beautiful HTML report (DEFAULT: always on)
- `--no-html` - Skip HTML report generation
- `--synthesize` or `-s` - Generate AI Council Verdict (consensus synthesis)
- `--synthesizer <model>` - Model for synthesis (claude, claude-cli, gpt-4, gpt-cli, gemini, grok, grok-cli, ollama)
- `--output <path>` or `-o <path>` - Custom output path (default: `C:\AI COUNCIL\reports`)
- `--no-claude-direct` - Skip Claude Code direct review (use API key instead)
- `--scoped "<focus>"` - Run a scoped review with custom focus

**Examples:**
- `/ai-council src/MyComponent.razor --html`
- `/ai-council src/MyComponent.razor --gemini --ollama` - All 5 models
- `/ai-council src/MyComponent.razor --power` - Premium models
- `/ai-council src/MyComponent.razor --scoped "security vulnerabilities"` - Focused review
- `/ai-council` - Reviews last edited file in session

---

## Instructions

When the user runs this skill:

1. **Determine the file to review:**
   - If a file path is provided as argument, use that
   - If no argument, look at the most recently edited file in this session
   - If still unclear, ask the user which file to review

2. **Read the file content** so you can do the Claude review directly.

3. **Run the Python script WITHOUT Claude** (other models use API keys):

   **Script location:** `C:/AI COUNCIL/vscode-extension/ai_council.py`

   ```bash
   python "C:/AI COUNCIL/vscode-extension/ai_council.py" [GLOBAL_FLAGS] review "<FILE_PATH>" --no-claude [OTHER_FLAGS]
   ```

   **IMPORTANT:** Global flags (--ollama, --ollama-url, --ollama-model, --claude-cli, --gpt-cli, --grok-cli) must come BEFORE the "review" subcommand!

   Build the command:
   - Global flags (before "review"):
     - If ollama: add `--ollama`
     - If ollama-url: add `--ollama-url "<URL>"`
     - If ollama-model: add `--ollama-model "<MODEL>"`
   - Then add: `review "<FILE_PATH>" --no-claude --html --output "C:/AI COUNCIL/reports"` (HTML always goes to standard reports folder)
   - Review flags (after file path):
     - If force: add `--force`
     - If gemini: add `--gemini`
     - If power: add `--power`
     - If --no-html flag specified: remove `--html` from command
     - If synthesize: add `--synthesize`
     - If synthesizer: add `--synthesizer <MODEL>`
     - If output path: add `--output "<PATH>"`

   **For scoped reviews** (focused on specific concerns):
   ```bash
   python "C:/AI COUNCIL/vscode-extension/ai_council.py" [GLOBAL_FLAGS] scoped-review "<FILE_PATH>" --scope "<FOCUS>" --no-claude --html --output "C:/AI COUNCIL/reports" [OTHER_FLAGS]
   ```

4. **Perform Claude review directly** (uses your Claude subscription - FREE):

   Review the file you read in step 2 using this prompt:

   ```
   Review this code file and provide a JSON response with:
   - quality_score: 1-10
   - summary: Brief overview of the code quality
   - issues: Array of issues found, each with:
     - severity: "critical", "high", "medium", "low", or "info"
     - line: Line number (or null if general)
     - description: What the issue is
     - recommendation: How to fix it

   Focus on: security vulnerabilities, bugs, performance issues, code quality, best practices.
   ```

5. **Present combined results:**

```
## AI Council Review: <filename>

| Model | Score | Issues |
|-------|-------|--------|
| GPT-4 | X/10 | N issues |
| Grok  | X/10 | N issues |
| Gemini | X/10 | N issues |  (if --gemini)
| Ollama | X/10 | N issues |  (if --ollama)
| Claude | X/10 | N issues |  (via subscription)

### Consensus Issues (High Confidence)
Issues flagged by multiple models - prioritize fixing these!

### Claude Review (Your Subscription)
[Your direct review findings here]

### GPT-4 Insights
[From Python script output]

### Grok Insights
[From Python script output]

### Gemini Insights (if enabled)
[From Python script output]

### Ollama Insights (if enabled)
[From Python script output]

---
HTML Report: <path>
```

6. **Offer to fix issues:**
   After showing results, ask: "Would you like me to address any of these issues?"

---

## Advanced Commands

The AI Council supports additional workflow commands:

| Command | Description |
|---------|-------------|
| `scoped-review` | Start a focused review session with custom scope |
| `scoped-followup` | Ask follow-up questions in an existing session |
| `debate` | Run a debate round over session findings |
| `consolidate` | Generate final pruned review from debate |
| `scoped-finalize` | Have an AI write up session as review document |
| `scoped-sessions` | List past scoped review sessions |
| `scoped-resume` | Resume/display a previous session |

---

## Cost Breakdown

| Model | Cost | Source |
|-------|------|--------|
| Claude | **FREE** | Your Claude subscription (direct) |
| GPT-4 | ~$0.03 | API key |
| Grok | ~$0.02 | API key |
| Gemini | FREE | API key (free tier) |
| Ollama | FREE | Self-hosted |

**Total with all 5 models: ~$0.05** (vs ~$0.08 if Claude used API)

---

## Notes

- **Claude is FREE** when using this skill - it uses your Claude Code subscription directly
- Other models still require API keys (GPT-4, Grok) or are free (Gemini, Ollama)
- Use `--no-claude-direct` flag if you want to use Claude API key instead
- Reviews are cached by file hash - unchanged files return cached results instantly
- Use `--force` to bypass cache and get fresh reviews

## Self-Hosted Models (Ollama)

WoW AI is pre-configured as the default Ollama endpoint:
- URL: `https://wowai-api.worldofworkflows.com:9443`
- Model: `qwen3.6:35b-mlx`

## Required Environment Variables

For the non-Claude models (set in `.env` or system):
- `OPENAI_API_KEY` - For GPT-4 reviews
- `XAI_API_KEY` - For Grok reviews
- `GOOGLE_API_KEY` - For Gemini reviews (optional, free)
- Ollama auth configured in VS Code settings
