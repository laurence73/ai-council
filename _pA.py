from pathlib import Path
import re, textwrap

path = Path("vscode-extension/src/sidePanel.ts")
text = path.read_text(encoding="utf-8")
orig = text

def must_replace(old, new, label):
    global text
    if old not in text:
        raise SystemExit(f"FAIL: {label}")
    text = text.replace(old, new, 1)
    print("OK", label)

# --- ReviewOptions ---
must_replace(
'''interface ReviewOptions {
    enableGpt: boolean;
    enableClaude: boolean;
    enableGrok: boolean;
    enableGemini: boolean;
    enableOllama: boolean;
    powerMode: boolean;
    synthesizer: string;
}''',
'''interface ReviewOptions {
    enableGpt: boolean;
    enableClaude: boolean;
    enableGrok: boolean;
    enableGptCli: boolean;
    enableClaudeCli: boolean;
    enableGrokCli: boolean;
    enableGemini: boolean;
    enableOllama: boolean;
    powerMode: boolean;
    synthesizer: string;
}''',
"ReviewOptions")

# --- default toggles ---
must_replace(
'''        return this._context.globalState.get('ai-council.toggleStates', {
            enableGpt: true,
            enableClaude: true,
            enableGrok: true,
            enableGemini: false,''',
'''        return this._context.globalState.get('ai-council.toggleStates', {
            enableGpt: false,
            enableClaude: false,
            enableGrok: false,
            enableGptCli: true,
            enableClaudeCli: true,
            enableGrokCli: true,
            enableGemini: false,''',
"default toggles")

# --- config listener ---
must_replace(
'''            if (e.affectsConfiguration('ai-council.apiKeys')) {
                this._sendApiKeyStatus();
            }''',
'''            if (e.affectsConfiguration('ai-council.apiKeys') || e.affectsConfiguration('ai-council.transport')) {
                this._sendApiKeyStatus();
            }''',
"config listener")

# --- message handler checkApiKey ---
must_replace(
'''                case 'checkApiKey':
                    await this._checkApiKey(message.modelId, message.name, message.key, message.url, message.free);
                    break;''',
'''                case 'checkApiKey':
                    await this._checkApiKey(message.modelId, message.name, message.key, message.url, message.free, message.kind);
                    break;''',
"checkApiKey handler")

# --- _checkApiKey ---
must_replace(
'''    private async _checkApiKey(modelId: string, name: string, key: string, url: string, free?: boolean) {
        const config = vscode.workspace.getConfiguration('ai-council');

        // Check if API key exists in VS Code settings
        const settingsKey = config.get<string>(`apiKeys.${key}`) || '';
        const hasKey = Boolean(settingsKey.trim());

        if (!hasKey) {
            const freeNote = free ? ' (FREE tier available!)' : '';
            const result = await vscode.window.showWarningMessage(
                `${name} requires an API key${freeNote}`,
                'Open Settings',
                'Get API Key'
            );

            if (result === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', `ai-council.apiKeys.${key}`);
            } else if (result === 'Get API Key') {
                vscode.env.openExternal(vscode.Uri.parse(url));
            }

            // Uncheck the toggle since key is missing
            this._view?.webview.postMessage({
                type: 'uncheckModel',
                modelId: modelId
            });
        }
    }''',
'''    private async _cliOnPath(bin: string): Promise<boolean> {
        const { execFile } = await import('child_process');
        return new Promise((resolve) => {
            const cmd = process.platform === 'win32' ? 'where' : 'which';
            execFile(cmd, [bin], { windowsHide: true }, (err) => resolve(!err));
        });
    }

    private async _checkApiKey(modelId: string, name: string, key: string, url: string, free?: boolean, kind?: string) {
        const config = vscode.workspace.getConfiguration('ai-council');
        const seatKind = kind || 'api';

        if (seatKind === 'cli') {
            const binMap: Record<string, string> = { openai: 'codex', anthropic: 'claude', xai: 'grok' };
            const bin = binMap[key];
            const ok = bin ? await this._cliOnPath(bin) : false;
            if (!ok) {
                await vscode.window.showWarningMessage(
                    `${name} needs the ${bin || 'CLI'} app on PATH (and logged in)`
                );
                this._view?.webview.postMessage({ type: 'uncheckModel', modelId });
            }
            return;
        }

        const settingsKey = config.get<string>(`apiKeys.${key}`) || '';
        const hasKey = Boolean(settingsKey.trim());

        if (!hasKey) {
            const freeNote = free ? ' (FREE tier available!)' : '';
            const result = await vscode.window.showWarningMessage(
                `${name} needs an API key${freeNote}`,
                'Open Settings',
                'Get API Key'
            );

            if (result === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', `ai-council.apiKeys.${key}`);
            } else if (result === 'Get API Key') {
                vscode.env.openExternal(vscode.Uri.parse(url));
            }

            this._view?.webview.postMessage({
                type: 'uncheckModel',
                modelId: modelId
            });
        }
    }''',
"_checkApiKey")

# --- _sendApiKeyStatus ---
old_send = '''    private async _sendApiKeyStatus() {
        const config = vscode.workspace.getConfiguration('ai-council');
        const modelKeys = ['openai', 'anthropic', 'xai', 'google', 'groq'];
        const keyStatus: Record<string, boolean> = {};
        const orgInfo: Record<string, string | null> = {};

        for (const key of modelKeys) {
            const settingsKey = config.get<string>(`apiKeys.${key}`) || '';
            keyStatus[key] = Boolean(settingsKey.trim());
        }

        // Special handling for Ollama - check URL configuration (API key is optional)
        const ollamaUrl = config.get<string>('ollamaUrl') || '';
        keyStatus['ollama'] = Boolean(ollamaUrl.trim());

        // Fetch org info for OpenAI if key exists
        const openaiKey = config.get<string>('apiKeys.openai') || '';
        if (openaiKey.trim()) {
            orgInfo.openai = await this._fetchOpenAIOrg(openaiKey.trim());
        }

        console.log('AI Council: Sending API key status', keyStatus, 'org info', orgInfo);

        if (this._view) {
            this._view.webview.postMessage({
                type: 'apiKeyStatus',
                status: keyStatus,
                orgInfo: orgInfo
            });
        }
    }'''

new_send = '''    private async _sendApiKeyStatus() {
        const config = vscode.workspace.getConfiguration('ai-council');
        const modelKeys = ['openai', 'anthropic', 'xai', 'google', 'groq'];
        const keyStatus: Record<string, boolean> = {};
        const orgInfo: Record<string, string | null> = {};
        const seatMeta: Record<string, string> = {};

        for (const key of modelKeys) {
            const settingsKey = config.get<string>(`apiKeys.${key}`) || '';
            keyStatus[key] = Boolean(settingsKey.trim());
            seatMeta[key] = keyStatus[key] ? 'api' : 'missing';
        }

        const cliBins: Record<string, string> = {
            'openai-cli': 'codex',
            'anthropic-cli': 'claude',
            'xai-cli': 'grok',
        };
        for (const [statusKey, bin] of Object.entries(cliBins)) {
            const ok = await this._cliOnPath(bin);
            keyStatus[statusKey] = ok;
            seatMeta[statusKey] = ok ? 'cli' : 'missing';
        }

        const ollamaUrl = config.get<string>('ollamaUrl') || '';
        keyStatus['ollama'] = Boolean(ollamaUrl.trim());

        const openaiKey = config.get<string>('apiKeys.openai') || '';
        if (openaiKey.trim()) {
            orgInfo.openai = await this._fetchOpenAIOrg(openaiKey.trim());
        }

        console.log('AI Council: Sending seat status', keyStatus, seatMeta);

        if (this._view) {
            this._view.webview.postMessage({
                type: 'apiKeyStatus',
                status: keyStatus,
                seatMeta: seatMeta,
                orgInfo: orgInfo
            });
        }
    }'''
must_replace(old_send, new_send, "_sendApiKeyStatus")

path.write_text(text, encoding="utf-8")
print("phase A ok, delta", len(text) - len(orig))
