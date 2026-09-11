# AI Council Review

Run multi-model code review using GPT-4, Grok, Claude, Gemini, and Ollama (self-hosted).

**Arguments:** `<file_path> [flags]`

**Flags:**
- `--force` or `-f` - Force re-review (bypass cache)
- `--gemini` or `-g` - Include Gemini in the review
- `--ollama` - Include Ollama (self-hosted model)
- `--ollama-url <url>` - Ollama server URL (default: wowai-api)
- `--ollama-model <model>` - Ollama model name (default: qwen3.6:35b-mlx)
- `--power` or `-p` - Use premium models (higher cost, better results)
- `--html` - Generate a beautiful HTML report
- `--synthesize` - Generate AI Council Verdict (consensus synthesis)
- `--synthesizer <model>` - Model for synthesis (claude, gpt-4, gemini, grok, ollama)
- `--output <path>` or `-o <path>` - Custom output path for HTML report
- `--issues` - Create GitHub issues for consensus findings
- `--issues-all` - Create GitHub issues for ALL findings
- `--repo <owner/repo>` - Target repo for issues (default: current git repo)

**Examples:**
- `/ai-council C:\RUBI\RUBI1\RUBI.Core.Services\NodeService.cs`
- `/ai-council src/MyComponent.razor --force`
- `/ai-council src/MyComponent.razor --html --synthesize` - HTML with Council Verdict
- `/ai-council src/MyComponent.razor --gemini --ollama --html` - All 5 models + HTML
- `/ai-council src/MyComponent.razor --ollama` - Include self-hosted Ollama
- `/ai-council src/MyComponent.razor --power` - Use premium models
- `/ai-council src/MyComponent.razor --issues` - Create GitHub issues for findings
- `/ai-council` - Reviews last edited file in session

---

## Instructions

When the user runs this skill:

1. **Determine the file to review:**
   - If a file path is provided as argument, use that
   - If no argument, look at the most recently edited file in this session
   - If still unclear, ask the user which file to review

2. **Parse the flags:**
   - Check if `--force` or `-f` is in arguments
   - Check if `--gemini` or `-g` is in arguments
   - Check if `--ollama` is in arguments
   - Check if `--ollama-url` is in arguments (followed by URL)
   - Check if `--ollama-model` is in arguments (followed by model name)
   - Check if `--power` or `-p` is in arguments
   - Check if `--html` is in arguments
   - Check if `--synthesize` is in arguments
   - Check if `--synthesizer` is in arguments (followed by model name)
   - Check if `--output` or `-o` is in arguments (followed by a path)
   - Check if `--issues` is in arguments
   - Check if `--issues-all` is in arguments
   - Check if `--repo` is in arguments (followed by owner/repo)

3. **Run the AI Council review:**
   ```bash
   python "C:/AI COUNCIL/ai_council.py" [GLOBAL_FLAGS] review "<FILE_PATH>" [REVIEW_FLAGS]
   ```

   **IMPORTANT:** Global flags (--ollama, --ollama-url, --ollama-model) must come BEFORE the "review" subcommand!

   Build the command:
   - Global flags (before "review"):
     - If ollama: add `--ollama`
     - If ollama-url: add `--ollama-url "<URL>"`
     - If ollama-model: add `--ollama-model "<MODEL>"`
   - Then add: `review "<FILE_PATH>"`
   - Review flags (after file path):
     - If force: add `--force`
     - If gemini: add `--gemini`
     - If power: add `--power`
     - If html: add `--html`
     - If synthesize: add `--synthesize`
     - If synthesizer: add `--synthesizer <MODEL>`
     - If output path: add `--output "<PATH>"`
     - If issues: add `--issues`
     - If issues-all: add `--issues-all`
     - If repo specified: add `--repo "<REPO>"`

4. **Show detailed results:**
   ```bash
   python "C:/AI COUNCIL/ai_council.py" show "<FILE_PATH>"
   ```

5. **Present the results to the user:**
   - Show a summary table comparing model findings
   - Highlight **consensus issues** (multiple models agree) - these are HIGH CONFIDENCE
   - List **unique insights** from each model
   - Include the quality scores from each model
   - If HTML was generated, tell the user the file path and offer to open it

6. **Offer to fix issues:**
   After showing results, ask: "Would you like me to address any of these issues?"

   If yes, run:
   ```bash
   python "C:/AI COUNCIL/ai_council.py" fix "<FILE_PATH>" --fixer <MODEL>
   ```

---

## Output Format

Present results like this:

```
## AI Council Review: <filename>

| Model | Score | Issues |
|-------|-------|--------|
| GPT-4 | X/10 | N issues |
| Grok  | X/10 | N issues |
| Claude | X/10 | N issues |
| Gemini | X/10 | N issues |  (if --gemini)
| Ollama | X/10 | N issues |  (if --ollama)

### Consensus Issues (High Confidence)
Issues flagged by multiple models - prioritize fixing these!
- [SEVERITY] Line X: Description

### GPT-4 Insights
- [SEVERITY] Line X: Description

### Grok Insights
- [SEVERITY] Line X: Description

### Claude Insights
- [SEVERITY] Line X: Description

### Gemini Insights  (if --gemini)
- [SEVERITY] Line X: Description

### Ollama Insights  (if --ollama)
- [SEVERITY] Line X: Description

---
HTML Report: <path>  (if --html)

Would you like me to address any of these issues?
```

---

## Notes

- **Default (GPT-4 + Grok + Claude):** 3 models by default (~$0.07/review)
- **With Gemini (--gemini):** Adds Google's perspective
- **With Ollama (--ollama):** Adds self-hosted model (FREE, private)
- **Power Mode (--power):** Premium models (GPT-6 Astra, Grok-3, Claude Fable 5.1, Gemini 2.5 Pro) - ~$0.30-0.50/review
- **Synthesize (--synthesize):** AI-generated Council Verdict with consensus analysis
- Reviews are cached by file hash - unchanged files return cached results instantly
- Use `--force` to bypass cache and get fresh reviews
- All models run in parallel for speed
- Typical review takes 10-30 seconds depending on file size

## Self-Hosted Models (Ollama)

WoW AI is pre-configured as the default Ollama endpoint:
- URL: `https://wowai-api.worldofworkflows.com:9443`
- Model: `qwen3.6:35b-mlx`
- Auth: Basic auth (pre-configured in VS Code settings)

Available models on WoW AI:
- `qwen3.6:35b-mlx` (default)
- `qwen3-coder-next:latest`
- `gemma4:12b-mlx`
- `llama3.2:latest`

## Required Environment Variables

These should be set in VS Code Settings or `C:\AI COUNCIL\.env`:
- `OPENAI_API_KEY` - For GPT-4 reviews
- `XAI_API_KEY` - For Grok reviews
- `ANTHROPIC_API_KEY` - For Claude reviews
- `GOOGLE_API_KEY` - For Gemini reviews (optional)
- Ollama auth is configured in VS Code settings (ai-council.apiKeys.ollama)
