# AI Council - Multi-Model Code Review

## Project Overview
VS Code extension for multi-model AI code review (GPT-4, Claude, Grok, Gemini).

## Build Commands
```bash
cd vscode-extension && npm run compile && npm run package
```

## Current Issues to Fix

(none tracked here currently)

## Debug
Open DevTools (`F12`) and check Console for `AI Council:` messages.

## API Keys (VS Code Settings only)
- `ai-council.apiKeys.openai`
- `ai-council.apiKeys.anthropic`
- `ai-council.apiKeys.xai`
- `ai-council.apiKeys.google` (FREE)

## Key Files
- `vscode-extension/src/sidePanel.ts` - Main sidebar UI and logic
- `vscode-extension/package.json` - Extension manifest
- `vscode-extension/ai_council.py` - Python review engine (the only copy that runs)
