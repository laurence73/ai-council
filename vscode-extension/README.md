# AI Council - VS Code Extension

Multi-model code review powered by GPT-4, Grok, Claude, and Gemini.

## Features

- **Review Current File** - Right-click or use command palette
- **Power Mode** - Use premium models for deeper analysis
- **Inline Diagnostics** - See issues highlighted directly in your code
- **Cost Tracking** - Know exactly what each review costs
- **Consensus Detection** - High-confidence issues flagged by multiple models

## Requirements

1. **Python 3.8+** installed
2. **AI Council script** (`ai_council.py`)
3. **API Keys** set as environment variables:
   - `OPENAI_API_KEY` - For GPT-4
   - `XAI_API_KEY` - For Grok
   - `ANTHROPIC_API_KEY` - For Claude
   - `GOOGLE_API_KEY` - For Gemini (optional)

## Installation

1. Install the extension from the VS Code Marketplace
2. Set `ai-council.scriptPath` in settings to point to `ai_council.py`
3. Ensure API keys are set in your environment

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `AI Council: Review Current File` | Standard review with GPT-4, Grok, Claude |
| `AI Council: Review Current File (Power Mode)` | Premium models for better results |
| `AI Council: Show Last Review` | Show previous review results |
| `AI Council: Clear Review Cache` | Clear cached reviews |

### Context Menu

Right-click on any code file to see AI Council options.

### Keyboard Shortcut

You can bind a keyboard shortcut to `ai-council.reviewFile` in your keybindings.

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `ai-council.pythonPath` | Path to Python | `python` |
| `ai-council.scriptPath` | Path to ai_council.py | Auto-detect |
| `ai-council.includeGemini` | Include Gemini in reviews | `false` |
| `ai-council.autoReviewOnSave` | Auto-queue files on save | `false` |
| `ai-council.showInlineHints` | Show inline issue hints | `true` |
| `ai-council.defaultMode` | Default review mode | `standard` |

## Cost Estimates

| Mode | Models | Cost per Review |
|------|--------|-----------------|
| Standard | GPT-4-turbo, Grok-3-mini, Claude Sonnet | ~$0.07 |
| Power | GPT-6-Astra, Grok-3, Claude Fable 5.1 | ~$0.35 |

## License

MIT
