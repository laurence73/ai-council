# Add AI Council Reviewer

Add a new AI model reviewer to the AI Council VS Code extension.

## Files to Modify

---

### 1. Python Backend: `vscode-extension/ai_council.py`

#### A. Add to DEFAULT_CONFIG models (~line 69)
```python
"models": {
    # ... existing models ...
    "newmodel": {"enabled": False, "api_key_env": "NEWMODEL_API_KEY"}
}
```

#### B. Add to MODEL_CONFIGS (~line 78)
```python
MODEL_CONFIGS = {
    "standard": {
        # ... existing models ...
        "newmodel": "model-name-standard",
    },
    "power": {
        # ... existing models ...
        "newmodel": "model-name-power",
    }
}
```

#### C. Add to API_PRICING (~line 94)
```python
API_PRICING = {
    # ... existing models ...
    "newmodel": {"input": 0.00, "output": 0.00},  # Cost per 1M tokens
}
API_PRICING_POWER = {
    # ... existing models ...
    "newmodel": {"input": 0.00, "output": 0.00},
}
```

#### D. Create Reviewer Class (after existing reviewer classes ~line 880)
```python
class NewModelReviewer:
    """NewModel reviewer"""

    def __init__(self, api_key: str, model: str = "default-model"):
        if not HAS_HTTPX:
            raise ImportError("httpx package not installed")
        self.api_key = api_key
        self.base_url = "https://api.newmodel.com"
        self.model = model

    async def _call_api(self, prompt: str) -> str:
        """Direct API call for synthesis/fixing"""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.base_url}/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json"
                    },
                    json={
                        "model": self.model,
                        "messages": [{"role": "user", "content": prompt}]
                    },
                    timeout=120.0
                )
                data = response.json()
                return data["choices"][0]["message"]["content"]
        except Exception as e:
            raise Exception(f"NewModel API call failed: {str(e)}")

    async def review(self, code: str, file_path: str) -> dict:
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.base_url}/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json"
                    },
                    json={
                        "model": self.model,
                        "messages": [
                            {"role": "system", "content": REVIEW_SYSTEM_PROMPT + "\n\nRespond with ONLY valid JSON."},
                            {"role": "user", "content": f"File: {file_path}\n\n```\n{code}\n```"}
                        ]
                    },
                    timeout=120.0
                )
                data = response.json()
                content = data["choices"][0]["message"]["content"]

                # Parse JSON response
                if "```json" in content:
                    content = content.split("```json")[1].split("```")[0]
                result = json.loads(content)

                # Add token usage if available
                if "usage" in data:
                    result["_usage"] = {
                        "input_tokens": data["usage"].get("prompt_tokens", 0),
                        "output_tokens": data["usage"].get("completion_tokens", 0)
                    }
                return result
        except Exception as e:
            return {"error": str(e), "issues": [], "quality_score": 0}
```

#### E. Add to AICouncil __init__ (~line 960)
```python
def __init__(self, ..., enable_newmodel: bool = False, ...):
    # In the model enable section:
    if enable_newmodel:
        self.config["models"]["newmodel"]["enabled"] = True
    # In the disable section (if using --no-newmodel pattern):
    if not enable_newmodel:
        self.config["models"]["newmodel"]["enabled"] = False
```

#### F. Add to _setup_reviewers method (~line 1000)
```python
if models.get("newmodel", {}).get("enabled"):
    api_key = os.environ.get(models["newmodel"]["api_key_env"])
    if api_key:
        try:
            model_name = model_names["newmodel"]
            self.reviewers["newmodel"] = NewModelReviewer(api_key, model=model_name)
            print(f"[+] NewModel reviewer enabled ({model_name})")
        except ImportError as e:
            print(f"[-] NewModel disabled: {e}")
```

#### G. Add to synthesis_order (~line 1168)
```python
synthesis_order = ['claude', 'gpt-4', 'gemini', 'grok', 'newmodel']
```

#### H. Add to HTML report model_class chain (~lines 1615, 1643, 1765)
Update the ternary chain to include newmodel:
```python
model_class = "gpt" if "gpt" in model.lower() else ("grok" if "grok" in model.lower() else ("claude" if "claude" in model.lower() else ("ollama" if "ollama" in model.lower() else ("newmodel" if "newmodel" in model.lower() else "gemini"))))
```

#### I. Add to HTML report emoji mapping (~line 1766)
```python
emoji = "🧠" if "gpt" in model.lower() else ("⚡" if "grok" in model.lower() else ("🔮" if "claude" in model.lower() else ("🦙" if "ollama" in model.lower() else ("🆕" if "newmodel" in model.lower() else "💎"))))
```

#### J. Add to HTML report CSS (~line 1466)
```python
.score-card.newmodel {{ border-top: 4px solid #COLOR; }}
```

#### K. Add to HTML report usage CSS (~line 1533)
```python
.usage-model.newmodel {{ color: #COLOR; }}
```

#### L. Add CLI arguments (~line 1850)
```python
# For enable flag:
review_parser.add_argument("--newmodel", action="store_true", help="Include NewModel")
# OR for disable flag (if enabled by default):
review_parser.add_argument("--no-newmodel", action="store_true", help="Disable NewModel reviewer")
```

#### M. Add to --synthesizer and --fixer choices (~lines 1865, 1870)
```python
review_parser.add_argument("--synthesizer", choices=['claude', 'gpt-4', 'gemini', 'grok', 'ollama', 'newmodel'], ...)
fix_parser.add_argument("--fixer", choices=['claude', 'gpt-4', 'gemini', 'grok', 'ollama', 'newmodel'], ...)
```

#### N. Add to main() argument parsing (~line 1890)
```python
enable_newmodel = getattr(args, 'newmodel', False)
# OR for disable pattern:
disable_newmodel = getattr(args, 'no_newmodel', False)

# Pass to AICouncil constructor:
council = AICouncil(
    # ... existing params ...
    enable_newmodel=enable_newmodel,  # or: enable_newmodel=not disable_newmodel
)
```

---

### 2. TypeScript Frontend: `vscode-extension/src/sidePanel.ts`

#### A. Add to ReviewOptions interface (~line 6)
```typescript
interface ReviewOptions {
    // ... existing ...
    enableNewmodel: boolean;
}
```

#### B. Add to message handlers (~lines 72, 106)
```typescript
case 'review':
    await this._runReview({
        // ... existing ...
        enableNewmodel: message.enableNewmodel,
    });
```

#### C. Add to apiKeys object in _runReview (~line 305)
```typescript
const apiKeys = {
    // ... existing ...
    NEWMODEL_API_KEY: config.get<string>('apiKeys.newmodel') || '',
};
```

#### D. Add to enabledModelsList (~line 318)
```typescript
if (options.enableNewmodel) { enabledModelsList.push('newmodel'); }
```

#### E. Add to args building (~line 340)
```typescript
if (options.enableNewmodel) { args.push('--newmodel'); }
// OR for disable pattern:
if (!options.enableNewmodel) { args.push('--no-newmodel'); }
```

#### F. Add to model name parsing in stdout handlers (~lines 388, 414, 430, 462, 478)
```typescript
else if (modelName.includes('newmodel')) { modelKey = 'newmodel'; }
```

#### G. Add toggle CSS (~line 1250)
```css
.toggle-switch.newmodel input:checked + .toggle-slider {
    background: linear-gradient(135deg, #COLOR 0%, #DARKER 100%);
    border-color: #COLOR;
}
```

#### H. Add model-card CSS (~line 1519)
```css
.model-card.newmodel { border-left-color: #COLOR; }
```

#### I. Add model-icon CSS (~line 1562)
```css
.model-icon.newmodel { background: linear-gradient(135deg, #COLOR, #DARKER); }
```

#### J. Add HTML toggle in model selection (~line 2000)
```html
<div class="toggle-item" id="toggle-enableNewmodel">
    <span class="toggle-label"><span class="model-name-text" data-standard="NewModel" data-power="NewModel Pro">NewModel</span><span class="key-status" id="key-newmodel"></span></span>
    <label class="toggle-switch newmodel">
        <input type="checkbox" id="enableNewmodel">
        <span class="toggle-slider"></span>
    </label>
</div>
```

#### K. Add to dropdown options (~lines 2082, 2091)
```html
<!-- Council Verdict by dropdown -->
<option value="newmodel">NewModel</option>

<!-- Fix Code with dropdown -->
<option value="newmodel">NewModel</option>
```

#### L. Add to modelApiKeys (~line 2175)
```javascript
'enableNewmodel': { name: 'NewModel', key: 'newmodel', url: 'https://api.newmodel.com/keys' }
```

#### M. Add to getModelConfig (~line 2212)
```javascript
enableNewmodel: document.getElementById('enableNewmodel').checked,
```

#### N. Add to runReview enabledModels list (~line 2235)
```javascript
if (config.enableNewmodel) enabledModels.push('NewModel');
```

#### O. Add to modelConfig in startReviewPanel (~line 2359)
```javascript
const modelConfig = {
    // ... existing ...
    'newmodel': { name: 'NewModel', icon: 'N', class: 'newmodel' }
};
```

#### P. Add to modelToKey (~line 2520)
```javascript
const modelToKey = {
    // ... existing ...
    'enableNewmodel': 'newmodel'
};
```

---

### 3. Package.json: `vscode-extension/package.json`

#### A. Add to keywords array (~line 14)
```json
"keywords": [
    // ... existing ...
    "newmodel"
],
```

#### B. Add settings under `contributes.configuration.properties` (~line 83)
```json
"ai-council.apiKeys.newmodel": {
    "type": "string",
    "default": "",
    "description": "NewModel API Key. Get yours at: https://..."
}
```

---

## Rebuild Extension
```bash
cd vscode-extension && npm run compile && npm run package
code --install-extension ai-council-0.1.0.vsix --force
```

---

## Checklist

- [ ] DEFAULT_CONFIG models
- [ ] MODEL_CONFIGS standard/power
- [ ] API_PRICING / API_PRICING_POWER
- [ ] Reviewer class with `_call_api` and `review` methods
- [ ] AICouncil __init__ parameter
- [ ] _setup_reviewers initialization
- [ ] synthesis_order list
- [ ] HTML model_class ternary chain (3 places)
- [ ] HTML emoji mapping
- [ ] HTML CSS (.score-card, .usage-model)
- [ ] CLI arguments (--newmodel or --no-newmodel)
- [ ] --synthesizer choices
- [ ] --fixer choices
- [ ] main() argument parsing
- [ ] TypeScript ReviewOptions interface
- [ ] TypeScript message handlers
- [ ] TypeScript apiKeys object
- [ ] TypeScript enabledModelsList
- [ ] TypeScript args building
- [ ] TypeScript stdout model name parsing (5 places)
- [ ] CSS toggle-switch
- [ ] CSS model-card
- [ ] CSS model-icon
- [ ] HTML toggle element
- [ ] HTML dropdown options (2 places)
- [ ] JS modelApiKeys
- [ ] JS getModelConfig
- [ ] JS runReview enabledModels
- [ ] JS modelConfig in startReviewPanel
- [ ] JS modelToKey
- [ ] package.json keywords
- [ ] package.json API key setting
