from pathlib import Path
import re

path = Path("vscode-extension/src/sidePanel.ts")
text = path.read_text(encoding="utf-8")

def repl(old, new, label):
    global text
    c = text.count(old)
    if c == 0:
        raise SystemExit(f"FAIL: {label}")
    text = text.replace(old, new)  # all occurrences for arg flags
    print("OK", label, "x"+str(c))

# HTML: replace PAID MODELS block through Grok toggle (exact from file)
i = text.find('PAID MODELS</div>')
if i < 0:
    raise SystemExit("PAID not found")
# start at section-title div
start = text.rfind('<div class="section-title"', 0, i)
# end after enableGrok toggle-item closes — find third toggle then close
marker = 'id="enableGrok"'
m = text.find(marker, i)
# find closing </div> of toggle-item for grok - after toggle-switch closes
end = text.find('</div>', text.find('</label>', m))
end = text.find('</div>', end + 1)  # toggle-item
end = end + len('</div>')
print("HTML slice", start, end, repr(text[start:start+80]))

new_html = '''<div class="section-title" style="color: #f59e0b;">&#36; API SEATS (keys)</div>
                <div class="toggle-group">
                    <div class="toggle-item" id="toggle-enableGpt">
                        <span class="toggle-label"><span class="model-name-text" data-standard="GPT-4 API" data-power="GPT-6 API">GPT-4 API</span><span class="key-status" id="key-openai" title="API Key Status"></span></span>
                        <label class="toggle-switch gpt">
                            <input type="checkbox" id="enableGpt">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                    <div class="toggle-item" id="toggle-enableClaude">
                        <span class="toggle-label"><span class="model-name-text" data-standard="Claude API" data-power="Claude API">Claude API</span><span class="key-status" id="key-anthropic" title="API Key Status"></span></span>
                        <label class="toggle-switch claude">
                            <input type="checkbox" id="enableClaude">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                    <div class="toggle-item" id="toggle-enableGrok">
                        <span class="toggle-label"><span class="model-name-text" data-standard="Grok API" data-power="Grok API">Grok API</span><span class="key-status" id="key-xai" title="API Key Status"></span></span>
                        <label class="toggle-switch grok">
                            <input type="checkbox" id="enableGrok">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                </div>

                <div class="section-title">&#128187; CLI SEATS (subscriptions)</div>
                <div class="toggle-group">
                    <div class="toggle-item" id="toggle-enableGptCli">
                        <span class="toggle-label"><span class="model-name-text" data-standard="Codex CLI" data-power="Codex CLI">Codex CLI</span><span class="key-status" id="key-openai-cli" title="CLI Status"></span></span>
                        <label class="toggle-switch gpt">
                            <input type="checkbox" id="enableGptCli" checked>
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                    <div class="toggle-item" id="toggle-enableClaudeCli">
                        <span class="toggle-label"><span class="model-name-text" data-standard="Claude CLI" data-power="Claude CLI">Claude CLI</span><span class="key-status" id="key-anthropic-cli" title="CLI Status"></span></span>
                        <label class="toggle-switch claude">
                            <input type="checkbox" id="enableClaudeCli" checked>
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                    <div class="toggle-item" id="toggle-enableGrokCli">
                        <span class="toggle-label"><span class="model-name-text" data-standard="Grok CLI" data-power="Grok CLI">Grok CLI</span><span class="key-status" id="key-xai-cli" title="CLI Status"></span></span>
                        <label class="toggle-switch grok">
                            <input type="checkbox" id="enableGrokCli" checked>
                            <span class="toggle-slider"></span>
                        </label>
                    </div>'''

# Old structure had one toggle-group still open after grok. We closed API group and opened CLI.
# The next content was likely another toggle-item (disabled) still inside old group.
# Keep going - don't include the opening of paid section's toggle-group leftover.
# Our new_html ends inside CLI toggle-group without closing - same as old ended mid-group.

text = text[:start] + new_html + text[end:]
print("OK HTML")

# modelApiKeys
old_keys = '''        const modelApiKeys = {
            'enableGpt': { name: 'GPT-4', key: 'openai', url: 'https://platform.openai.com/api-keys' },
            'enableClaude': { name: 'Claude', key: 'anthropic', url: 'https://console.anthropic.com/' },
            'enableGrok': { name: 'Grok', key: 'xai', url: 'https://console.x.ai/' },'''

# need full object - read it
i = text.find("const modelApiKeys")
print(text[i:i+700])
