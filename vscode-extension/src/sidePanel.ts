import * as vscode from 'vscode';
import * as path from 'path';
import * as https from 'https';
import { spawn } from 'child_process';

// Windows CommandLineToArgvW-compatible quoting for a shell-string spawn() call: backslashes
// are only special when they immediately precede a double quote (or run to the end of the
// argument, right before the closing quote) - in that case they must be doubled, and the
// quote escaped. Naive `.replace(/"/g, '\\"')` corrupts a trailing backslash and silently
// truncates on embedded newlines (e.g. multi-line scope/question text from a <textarea>).
function winQuoteArg(value: string): string {
    const normalized = value.replace(/\r?\n/g, ' ');
    let result = '';
    let backslashes = 0;
    for (const ch of normalized) {
        if (ch === '\\') {
            backslashes++;
            continue;
        }
        if (ch === '"') {
            result += '\\'.repeat(backslashes * 2 + 1) + '"';
            backslashes = 0;
            continue;
        }
        result += '\\'.repeat(backslashes) + ch;
        backslashes = 0;
    }
    result += '\\'.repeat(backslashes * 2);
    return '"' + result + '"';
}

interface ReviewOptions {
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
}

interface ModelResult {
    score: number;
    issues: number;
    error?: boolean;
}

// Maps a raw model name from ai_council.py's stdout (e.g. "CLAUDE-CLI", "GPT-4") to the key
// used in modelResults / the webview's card IDs. CLI seats keep their -cli suffix (distinct
// card from the API seat); everything else collapses to the bare API-seat key.
function normalizeModelKey(rawName: string): string {
    const modelName = rawName.toLowerCase();
    if (modelName.endsWith('-cli')) { return modelName; }
    if (modelName.includes('gpt')) { return 'gpt-4'; }
    if (modelName.includes('claude')) { return 'claude'; }
    if (modelName.includes('grok')) { return 'grok'; }
    if (modelName.includes('gemini')) { return 'gemini'; }
    return modelName;
}

// Shared stdout-line parser for every command that runs ai_council.py's ProgressTracker
// (review, scoped-review, scoped-followup all print the same "[+] MODEL Score: N/10 (Xs)
// [i/total]" / "[!] MODEL ERROR" / "[MODEL] Score: N/10 | Issues: N" lines). Extracted once so
// review and scoped-review can't drift out of sync with each other's parsing again.
function parseModelProgressLine(text: string, modelResults: Record<string, ModelResult>): { model: string; data: ModelResult } | null {
    const scoreMatch = text.match(/\[\+\]\s+([\w-]+)\s+Score:\s*(\d+(?:\.\d+)?)\/10/i);
    if (scoreMatch) {
        const modelKey = normalizeModelKey(scoreMatch[1]);
        const score = parseFloat(scoreMatch[2]);
        if (!modelResults[modelKey]) {
            modelResults[modelKey] = { score, issues: 0 };
        } else {
            modelResults[modelKey].score = score;
        }
        return { model: modelKey, data: { score, issues: modelResults[modelKey].issues || 0, error: false } };
    }

    const issuesMatch = text.match(/\[([\w-]+)\]\s+Score:\s*\d+(?:\.\d+)?\/10\s*\|\s*Issues:\s*(\d+)/i);
    if (issuesMatch) {
        const modelKey = normalizeModelKey(issuesMatch[1]);
        const issues = parseInt(issuesMatch[2]);
        if (modelResults[modelKey]) {
            modelResults[modelKey].issues = issues;
        }
        return null;
    }

    const errorMatch = text.match(/\[!\]\s+([\w-]+)\s+ERROR/i);
    if (errorMatch) {
        const modelKey = normalizeModelKey(errorMatch[1]);
        modelResults[modelKey] = { score: 0, issues: 0, error: true };
        return { model: modelKey, data: { score: 0, issues: 0, error: true } };
    }

    return null;
}

// Full-stdout re-scan for anything the line-by-line parser missed (especially cached rounds,
// which never emit a live "[~] MODEL started..." line but still print in "Detailed Results").
function rescanModelResults(stdout: string, modelResults: Record<string, ModelResult>) {
    const allScoreMatches = stdout.matchAll(/\[\+\]\s+([\w-]+)\s+Score:\s*(\d+(?:\.\d+)?)\/10/gi);
    for (const match of allScoreMatches) {
        const modelKey = normalizeModelKey(match[1]);
        const score = parseFloat(match[2]);
        if (!modelResults[modelKey] || modelResults[modelKey].error) {
            modelResults[modelKey] = { score, issues: 0 };
        }
    }

    const allIssuesMatches = stdout.matchAll(/\[([\w-]+)\]\s+Score:\s*\d+(?:\.\d+)?\/10\s*\|\s*Issues:\s*(\d+)/gi);
    for (const match of allIssuesMatches) {
        const modelKey = normalizeModelKey(match[1]);
        const issues = parseInt(match[2]);
        if (modelResults[modelKey]) {
            modelResults[modelKey].issues = issues;
        }
    }
}

export class AiCouncilSidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'ai-council.sidebar';
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _context: vscode.ExtensionContext;

    constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this._extensionUri = extensionUri;
        this._context = context;
    }

    private _saveToggleStates(toggles: Record<string, boolean>) {
        this._context.globalState.update('ai-council.toggleStates', toggles);
    }

    private _getToggleStates(): Record<string, boolean> {
        return this._context.globalState.get('ai-council.toggleStates', {
            enableGpt: false,
            enableClaude: false,
            enableGrok: false,
            enableGptCli: true,
            enableClaudeCli: true,
            enableGrokCli: true,
            enableGemini: false,
            enableOllama: false,
            powerMode: false
        });
    }

    private _getScriptPath(): string {
        const config = vscode.workspace.getConfiguration('ai-council');
        const customPath = config.get<string>('scriptPath');

        // If user specified a custom path, use that
        if (customPath && customPath.trim()) {
            return customPath;
        }

        // Otherwise use the bundled script in the extension folder
        return path.join(this._extensionUri.fsPath, 'ai_council.py');
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlContent(webviewView.webview);

        // Send API key status when webview becomes visible
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._sendApiKeyStatus();
            }
        });

        // Listen for settings changes and update API key status
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('ai-council.apiKeys') || e.affectsConfiguration('ai-council.transport')) {
                this._sendApiKeyStatus();
            }
        });

        // Send initial API key status after a short delay (webview needs to initialize)
        setTimeout(() => this._sendApiKeyStatus(), 100);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'review':
                    await this._runReview({
                        enableGpt: message.enableGpt,
                        enableClaude: message.enableClaude,
                        enableGrok: message.enableGrok,
                        enableGptCli: !!message.enableGptCli,
                        enableClaudeCli: !!message.enableClaudeCli,
                        enableGrokCli: !!message.enableGrokCli,
                        enableGemini: message.enableGemini,
                        enableOllama: message.enableOllama,
                        powerMode: message.powerMode,
                        synthesizer: message.synthesizer || 'auto'
                    });
                    break;
                case 'saveCliModel':
                    await vscode.workspace.getConfiguration('ai-council').update(
                        `cliModels.${message.provider}`,
                        message.model,
                        vscode.ConfigurationTarget.Global
                    );
                    break;
                case 'listGrokModels':
                    await this._listGrokModels();
                    break;
                case 'checkApiKey':
                    await this._checkApiKey(message.modelId, message.name, message.key, message.url, message.free, message.kind);
                    break;
                case 'clearCacheConfirmed':
                    await this._clearCacheConfirmed();
                    break;
                case 'showStatus':
                    await this._showStatus(message.toggles);
                    break;
                case 'openSettings':
                    vscode.commands.executeCommand('workbench.action.openSettings', 'ai-council');
                    break;
                case 'webviewReady':
                    // Webview is ready to receive messages
                    this._sendApiKeyStatus();
                    this._sendCacheSize();
                    this._listGrokModels();
                    // Send saved toggle states
                    const savedToggles = this._getToggleStates();
                    this._view?.webview.postMessage({ type: 'restoreToggles', toggles: savedToggles });
                    break;
                case 'saveToggles':
                    // Save toggle states when user changes them
                    this._saveToggleStates(message.toggles);
                    break;
                case 'reviewCommit':
                    await this._reviewCommit({
                        enableGpt: message.enableGpt,
                        enableClaude: message.enableClaude,
                        enableGrok: message.enableGrok,
                        enableGptCli: !!message.enableGptCli,
                        enableClaudeCli: !!message.enableClaudeCli,
                        enableGrokCli: !!message.enableGrokCli,
                        enableGemini: message.enableGemini,
                        enableOllama: message.enableOllama,
                        powerMode: message.powerMode,
                        synthesizer: message.synthesizer || 'auto'
                    });
                    break;
                case 'openReport':
                    if (message.path) {
                        vscode.env.openExternal(vscode.Uri.file(message.path));
                    } else if (this._currentReportPath) {
                        vscode.env.openExternal(vscode.Uri.file(this._currentReportPath));
                    }
                    break;
                case 'openReviewDoc':
                    if (message.path) {
                        const doc = await vscode.workspace.openTextDocument(message.path);
                        await vscode.window.showTextDocument(doc);
                    }
                    break;
                case 'scopedReview':
                    this._scopedReview(message.scope, message.modelConfig);
                    break;
                case 'scopedFollowup':
                    this._scopedFollowup(message.sessionId, message.question, message.modelConfig);
                    break;
                case 'scopedFinalize':
                    this._scopedFinalize(message.sessionId, message.writer, message.modelConfig);
                    break;
                case 'runDebate':
                    this._runDebate(message.sessionId, message.arbiter, message.modelConfig);
                    break;
                case 'runConsolidate':
                    this._runConsolidate(message.sessionId, message.modelConfig);
                    break;
                case 'cancelReview':
                    this._cancelReview();
                    break;
                case 'fixCode':
                    this._fixCode(message.fixer, message.reportPath, message.modelConfig);
                    break;
            }
        });
    }

    public updateStatus(status: string, isLoading: boolean = false) {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'statusUpdate',
                status,
                isLoading
            });
        }
    }

    public updateResults(results: any) {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'resultsUpdate',
                results
            });
        }
    }

    private _currentReportPath: string = '';
    private _currentProcess: any = null;
    private _isReviewing: boolean = false;

    private _cancelReview() {
        if (this._currentProcess) {
            const pid = this._currentProcess.pid;
            console.log('AI Council: Cancelling review, killing process', pid);

            // On Windows, we need to kill the process tree since shell: true creates a cmd.exe wrapper
            if (process.platform === 'win32' && pid) {
                spawn(`taskkill /pid ${pid} /f /t`, [], { shell: true });
            } else {
                this._currentProcess.kill('SIGTERM');
            }

            this._currentProcess = null;
            this._isReviewing = false;
            this.updateStatus('Review cancelled', false);
            if (this._view) {
                this._view.webview.postMessage({ type: 'reviewCancelled' });
            }
        } else {
            console.log('AI Council: No process to cancel');
        }
    }

    private async _fixCode(fixer: string, reportPath: string, modelConfig?: { enableGptCli?: boolean; enableClaudeCli?: boolean; enableGrokCli?: boolean }) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No file open to fix');
            this._view?.webview.postMessage({ type: 'fixComplete', success: false });
            return;
        }

        const filePath = editor.document.uri.fsPath;
        const originalContent = editor.document.getText();

        this.updateStatus(`Fixing code with ${fixer.toUpperCase()}...`, true);

        const config = vscode.workspace.getConfiguration('ai-council');
        const pythonPath = config.get<string>('pythonPath') || 'python';
        const scriptPath = this._getScriptPath();

        // Get API keys
        const apiKeys = {
            OPENAI_API_KEY: config.get<string>('apiKeys.openai') || '',
            ANTHROPIC_API_KEY: config.get<string>('apiKeys.anthropic') || '',
            XAI_API_KEY: config.get<string>('apiKeys.xai') || '',
            GOOGLE_API_KEY: config.get<string>('apiKeys.google') || '',
            GROQ_API_KEY: config.get<string>('apiKeys.groq') || '',
            AI_COUNCIL_TRANSPORT_OPENAI: config.get<string>('transport.openai') || 'auto',
            AI_COUNCIL_TRANSPORT_ANTHROPIC: config.get<string>('transport.anthropic') || 'auto',
            AI_COUNCIL_TRANSPORT_XAI: config.get<string>('transport.xai') || 'auto',
            AI_COUNCIL_CLI_MODEL_OPENAI: config.get<string>('cliModels.openai') || '',
            AI_COUNCIL_CLI_MODEL_ANTHROPIC: config.get<string>('cliModels.anthropic') || 'sonnet',
            AI_COUNCIL_CLI_MODEL_XAI: config.get<string>('cliModels.xai') || '',
            AI_COUNCIL_REVIEW_RUBRIC: config.get<string>('reviewRubric') || '',
        };

        // CLI seat flags are global (must precede the subcommand) in ai_council.py's argparse -
        // without these, self.reviewers never gets a claude-cli/gpt-cli/grok-cli entry to fix with.
        const args = [`"${scriptPath}"`];
        if (modelConfig?.enableGptCli) { args.push('--gpt-cli'); }
        if (modelConfig?.enableClaudeCli) { args.push('--claude-cli'); }
        if (modelConfig?.enableGrokCli) { args.push('--grok-cli'); }
        args.push('fix', `"${filePath}"`, '--fixer', fixer);
        if (reportPath) {
            args.push('--report', `"${reportPath}"`);
        }

        const command = `${pythonPath} ${args.join(' ')}`;
        console.log('AI Council: Running fix command:', command);

        const fixProcess = spawn(command, [], {
            shell: true,
            env: { ...process.env, ...apiKeys }
        });

        let stdout = '';
        let stderr = '';

        fixProcess.stdout?.on('data', (data) => { stdout += data.toString(); });
        fixProcess.stderr?.on('data', (data) => { stderr += data.toString(); });

        fixProcess.on('close', async (code) => {
            if (code === 0 && stdout.trim()) {
                try {
                    // The script outputs the fixed code
                    const fixedContent = stdout;

                    // Create a temp file with the fixed content
                    const fs = require('fs');
                    const tempDir = require('os').tmpdir();
                    const fileName = path.basename(filePath);
                    const fixedPath = path.join(tempDir, `${fileName}.fixed`);

                    fs.writeFileSync(fixedPath, fixedContent, 'utf-8');

                    // Open diff view
                    const originalUri = editor.document.uri;
                    const fixedUri = vscode.Uri.file(fixedPath);

                    await vscode.commands.executeCommand('vscode.diff',
                        originalUri,
                        fixedUri,
                        `${fileName} ↔ Fixed by ${fixer.toUpperCase()}`
                    );

                    this.updateStatus('Fix complete - review changes in diff view', false);
                    vscode.window.showInformationMessage(
                        'AI Council: Review the suggested fixes in the diff view. Copy changes you want to keep.',
                        'Got it'
                    );
                } catch (e) {
                    console.error('AI Council: Error showing diff:', e);
                    this.updateStatus('Fix failed', false);
                }
            } else {
                const errorMsg = stderr || 'Unknown error';
                console.error('AI Council fix error:', errorMsg);
                vscode.window.showErrorMessage(`AI Council: Fix failed - ${errorMsg.substring(0, 100)}`);
                this.updateStatus('Fix failed', false);
            }

            this._view?.webview.postMessage({ type: 'fixComplete', success: code === 0 });
        });

        fixProcess.on('error', (err) => {
            console.error('AI Council fix error:', err);
            vscode.window.showErrorMessage(`AI Council: ${err.message}`);
            this.updateStatus('Fix failed', false);
            this._view?.webview.postMessage({ type: 'fixComplete', success: false });
        });
    }

    private async _runReview(options: ReviewOptions) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            this.updateStatus('No file open', false);
            vscode.window.showWarningMessage('Open a file to review');
            return;
        }

        const filePath = editor.document.uri.fsPath;
        const fileName = path.basename(filePath);
        const fileBaseName = path.basename(filePath, path.extname(filePath));
        const config = vscode.workspace.getConfiguration('ai-council');
        const pythonPath = config.get<string>('pythonPath') || 'python';
        const scriptPath = this._getScriptPath();

        // Get workspace folder for saving report in .ai-council/reports
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath || path.dirname(filePath);
        const reportsDir = path.join(workspaceRoot, '.ai-council', 'reports');

        // Ensure reports directory exists
        const fs = require('fs');
        if (!fs.existsSync(reportsDir)) {
            fs.mkdirSync(reportsDir, { recursive: true });
        }

        // Clean filename: remove ai-council prefix if present, truncate long names
        let cleanName = fileBaseName.replace(/^ai-council-/, '').replace(/-\d{4}-\d{2}-\d{2}T[\d-]+$/, '');
        if (cleanName.length > 30) cleanName = cleanName.substring(0, 30);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const reportPath = path.join(reportsDir, `review-${cleanName}-${timestamp}.html`);
        this._currentReportPath = reportPath;

        // Get API keys from VS Code settings only
        const apiKeys = {
            OPENAI_API_KEY: config.get<string>('apiKeys.openai') || '',
            ANTHROPIC_API_KEY: config.get<string>('apiKeys.anthropic') || '',
            XAI_API_KEY: config.get<string>('apiKeys.xai') || '',
            GOOGLE_API_KEY: config.get<string>('apiKeys.google') || '',
            GROQ_API_KEY: config.get<string>('apiKeys.groq') || '',
            OLLAMA_API_KEY: config.get<string>('apiKeys.ollama') || '',
            AI_COUNCIL_TRANSPORT_OPENAI: config.get<string>('transport.openai') || 'auto',
            AI_COUNCIL_TRANSPORT_ANTHROPIC: config.get<string>('transport.anthropic') || 'auto',
            AI_COUNCIL_TRANSPORT_XAI: config.get<string>('transport.xai') || 'auto',
            AI_COUNCIL_CLI_MODEL_OPENAI: config.get<string>('cliModels.openai') || '',
            AI_COUNCIL_CLI_MODEL_ANTHROPIC: config.get<string>('cliModels.anthropic') || 'sonnet',
            AI_COUNCIL_CLI_MODEL_XAI: config.get<string>('cliModels.xai') || '',
            AI_COUNCIL_REVIEW_RUBRIC: config.get<string>('reviewRubric') || '',
            OLLAMA_URL: config.get<string>('ollamaUrl') || 'https://wowcentral.worldofworkflows.com',
        };

        // Build list of enabled models
        const enabledModelsList: string[] = [];
        if (options.enableGpt) { enabledModelsList.push('gpt-4'); }
        if (options.enableClaude) { enabledModelsList.push('claude'); }
        if (options.enableGrok) { enabledModelsList.push('grok'); }
        if (options.enableGptCli) { enabledModelsList.push('gpt-cli'); }
        if (options.enableClaudeCli) { enabledModelsList.push('claude-cli'); }
        if (options.enableGrokCli) { enabledModelsList.push('grok-cli'); }
        if (options.enableGemini) { enabledModelsList.push('gemini'); }
        if (options.enableOllama) { enabledModelsList.push('ollama'); }

        // Send start message to webview
        if (this._view) {
            this._view.webview.postMessage({
                type: 'reviewStart',
                fileName: fileName,
                models: enabledModelsList
            });
        }

        // Use workspace .ai-council folder for database
        const aiCouncilDir = path.join(workspaceRoot, '.ai-council');
        const dbPath = path.join(aiCouncilDir, 'reviews.db');

        // Build command args - global flags BEFORE subcommand
        const args = [`"${scriptPath}"`, '--db', `"${dbPath}"`];

        // Add ollama global flags BEFORE the subcommand
        if (options.enableOllama) {
            args.push('--ollama');
            const ollamaUrl = config.get<string>('ollamaUrl');
            if (ollamaUrl) {
                args.push('--ollama-url', `"${ollamaUrl}"`);
            }
            const ollamaModel = config.get<string>('ollamaModel');
            if (ollamaModel) {
                args.push('--ollama-model', ollamaModel);
            }
        }

        // CLI seat flags are global (must precede the subcommand) in ai_council.py's argparse
        if (options.enableGptCli) { args.push('--gpt-cli'); }
        if (options.enableClaudeCli) { args.push('--claude-cli'); }
        if (options.enableGrokCli) { args.push('--grok-cli'); }

        // Add subcommand and its arguments
        args.push('review', `"${filePath}"`, '--html', '--output', `"${reportPath}"`, '--synthesize');
        if (options.synthesizer && options.synthesizer !== 'auto') {
            args.push('--synthesizer', options.synthesizer);
        }
        if (options.powerMode) { args.push('--power'); }
        if (options.enableGemini) { args.push('--gemini'); }
        if (!options.enableGpt) { args.push('--no-gpt'); }
        if (!options.enableClaude) { args.push('--no-claude'); }
        if (!options.enableGrok) { args.push('--no-grok'); }

        // Pass API keys via environment
        this._isReviewing = true;
        const command = `${pythonPath} ${args.join(' ')}`;
        const reviewProcess = spawn(command, [], {
            shell: true,
            env: { ...process.env, ...apiKeys }
        });
        this._currentProcess = reviewProcess;

        // Track results for each model
        const modelResults: Record<string, ModelResult> = {};

        let stdout = '';
        let stderr = '';

        // Parse output in real-time for progress updates
        reviewProcess.stdout?.on('data', (data) => {
            const text = data.toString();
            stdout += text;
            console.log('AI Council stdout:', text.substring(0, 200));

            const update = parseModelProgressLine(text, modelResults);
            if (update && this._view) {
                this._view.webview.postMessage({ type: 'reviewProgress', model: update.model, data: update.data });
            }
        });

        reviewProcess.stderr?.on('data', (data) => {
            const text = data.toString();
            stderr += text;
            console.log('AI Council stderr:', text.substring(0, 200));
        });

        reviewProcess.on('close', (code) => {
            this._isReviewing = false;
            this._currentProcess = null;

            rescanModelResults(stdout, modelResults);

            console.log('AI Council: Process closed with code', code, 'results:', JSON.stringify(modelResults));

            if (code === 0) {
                this.updateStatus('', false);  // Clear status bar - panel shows the result

                // Send completion to webview
                if (this._view) {
                    this._view.webview.postMessage({
                        type: 'reviewComplete',
                        results: modelResults,
                        reportPath: reportPath
                    });
                }
            } else if (code !== null) {  // null means killed/cancelled
                this.updateStatus('', false);  // Clear status bar - panel shows the error
                const errorMsg = stderr || stdout || 'Unknown error';
                vscode.window.showErrorMessage(`AI Council: ${errorMsg.substring(0, 200)}`);
                console.error('AI Council error:', errorMsg);

                // Tell the panel to show failure state
                if (this._view) {
                    this._view.webview.postMessage({
                        type: 'reviewFailed',
                        error: errorMsg.substring(0, 100)
                    });
                }
            }
        });

        reviewProcess.on('error', (err) => {
            this.updateStatus('Review failed', false);
            vscode.window.showErrorMessage(`AI Council: ${err.message}`);
        });
    }

    private async _reviewCommit(options: ReviewOptions) {
        // Get workspace folder
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        const workspacePath = workspaceFolders[0].uri.fsPath;
        this.updateStatus('Checking staged files...', true);

        // Get staged files using git
        const gitProcess = spawn('git diff --cached --name-only', [], {
            cwd: workspacePath,
            shell: true
        });

        let stdout = '';
        let stderr = '';
        gitProcess.stdout?.on('data', (data) => { stdout += data.toString(); });
        gitProcess.stderr?.on('data', (data) => { stderr += data.toString(); });

        gitProcess.on('close', async (code) => {
            if (code !== 0) {
                this.updateStatus('Git error', false);
                vscode.window.showErrorMessage(`Git error: ${stderr || 'Not a git repository?'}`);
                return;
            }

            // Parse staged files
            const stagedFiles = stdout.trim().split('\n').filter(f => f.trim());

            if (stagedFiles.length === 0) {
                this.updateStatus('No staged files', false);
                vscode.window.showWarningMessage('No files staged for commit. Use `git add` first.');
                return;
            }

            // Filter to supported file types
            const supportedExtensions = ['.cs', '.razor', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.cpp', '.c'];
            const reviewableFiles = stagedFiles.filter(f =>
                supportedExtensions.some(ext => f.toLowerCase().endsWith(ext))
            );

            if (reviewableFiles.length === 0) {
                this.updateStatus('No reviewable files', false);
                vscode.window.showWarningMessage(`${stagedFiles.length} staged file(s) but none are supported code files.`);
                return;
            }

            // Count enabled models
            const enabledModels = [options.enableGpt, options.enableClaude, options.enableGrok, options.enableGptCli, options.enableClaudeCli, options.enableGrokCli, options.enableGemini, options.enableOllama].filter(Boolean).length;

            // Show QuickPick for file selection
            const quickPick = vscode.window.createQuickPick();
            quickPick.title = `AI Council: Review ${reviewableFiles.length} staged file(s)`;
            quickPick.placeholder = 'Select files to review (Enter to confirm, Esc to cancel)';
            quickPick.canSelectMany = true;
            quickPick.items = reviewableFiles.map(f => ({
                label: path.basename(f),
                description: path.dirname(f),
                picked: true  // All selected by default
            }));

            // Select all by default
            quickPick.selectedItems = quickPick.items;

            const selectedFiles = await new Promise<string[]>((resolve) => {
                quickPick.onDidAccept(() => {
                    const selected = quickPick.selectedItems.map(item => {
                        const dir = item.description || '';
                        return dir ? `${dir}/${item.label}` : item.label;
                    });
                    quickPick.hide();
                    resolve(selected);
                });
                quickPick.onDidHide(() => {
                    resolve([]);
                });
                quickPick.show();
            });

            if (selectedFiles.length === 0) {
                this.updateStatus('Cancelled', false);
                return;
            }

            // Update reviewable files to only selected ones
            const filesToReview = selectedFiles;

            // Review each file
            const config = vscode.workspace.getConfiguration('ai-council');
            const pythonPath = config.get<string>('pythonPath') || 'python';
            const scriptPath = this._getScriptPath();

            const apiKeys = {
                OPENAI_API_KEY: config.get<string>('apiKeys.openai') || '',
                ANTHROPIC_API_KEY: config.get<string>('apiKeys.anthropic') || '',
                XAI_API_KEY: config.get<string>('apiKeys.xai') || '',
                GOOGLE_API_KEY: config.get<string>('apiKeys.google') || '',
                GROQ_API_KEY: config.get<string>('apiKeys.groq') || '',
                AI_COUNCIL_TRANSPORT_OPENAI: config.get<string>('transport.openai') || 'auto',
                AI_COUNCIL_TRANSPORT_ANTHROPIC: config.get<string>('transport.anthropic') || 'auto',
                AI_COUNCIL_TRANSPORT_XAI: config.get<string>('transport.xai') || 'auto',
            AI_COUNCIL_CLI_MODEL_OPENAI: config.get<string>('cliModels.openai') || '',
            AI_COUNCIL_CLI_MODEL_ANTHROPIC: config.get<string>('cliModels.anthropic') || 'sonnet',
            AI_COUNCIL_CLI_MODEL_XAI: config.get<string>('cliModels.xai') || '',
            AI_COUNCIL_REVIEW_RUBRIC: config.get<string>('reviewRubric') || '',
            };

            let completed = 0;
            let failed = 0;

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

            // Use workspace .ai-council folder for database and reports
            const aiCouncilDir = path.join(workspacePath, '.ai-council');
            const reportsDir = path.join(aiCouncilDir, 'reports');
            const dbPath = path.join(aiCouncilDir, 'reviews.db');

            // Ensure reports directory exists
            const fs = require('fs');
            if (!fs.existsSync(reportsDir)) {
                fs.mkdirSync(reportsDir, { recursive: true });
            }

            for (const file of filesToReview) {
                const fullPath = path.join(workspacePath, file);
                const fileName = path.basename(file, path.extname(file));
                // Clean filename for report
                let cleanName = fileName.replace(/^ai-council-/, '');
                if (cleanName.length > 30) cleanName = cleanName.substring(0, 30);
                const reportPath = path.join(reportsDir, `review-${cleanName}-${timestamp}.html`);
                completed++;
                this.updateStatus(`Reviewing ${completed}/${filesToReview.length}: ${path.basename(file)}...`, true);

                // Build command args - always generate HTML and synthesize
                // CLI seat flags are global (must precede the subcommand) in ai_council.py's argparse
                const args = [`"${scriptPath}"`, '--db', `"${dbPath}"`];
                if (options.enableGptCli) { args.push('--gpt-cli'); }
                if (options.enableClaudeCli) { args.push('--claude-cli'); }
                if (options.enableGrokCli) { args.push('--grok-cli'); }
                args.push('review', `"${fullPath}"`, '--html', '--output', `"${reportPath}"`, '--synthesize');
                if (options.synthesizer && options.synthesizer !== 'auto') {
                    args.push('--synthesizer', options.synthesizer);
                }
                if (options.powerMode) { args.push('--power'); }
                if (options.enableGemini) { args.push('--gemini'); }
                if (!options.enableGpt) { args.push('--no-gpt'); }
                if (!options.enableClaude) { args.push('--no-claude'); }
                if (!options.enableGrok) { args.push('--no-grok'); }

                // Run review and wait for completion
                await new Promise<void>((resolve) => {
                    const cmd = `${pythonPath} ${args.join(' ')}`;
                    const reviewProcess = spawn(cmd, [], {
                        shell: true,
                        env: { ...process.env, ...apiKeys }
                    });

                    reviewProcess.on('close', (code) => {
                        if (code !== 0) { failed++; }
                        resolve();
                    });

                    reviewProcess.on('error', () => {
                        failed++;
                        resolve();
                    });
                });
            }

            // Final status
            const statusMsg = failed > 0
                ? `Completed ${completed - failed}/${filesToReview.length} reviews (${failed} failed)`
                : `Completed ${completed} reviews`;

            this.updateStatus(statusMsg, false);
            vscode.window.showInformationMessage(`AI Council: ${statusMsg}`);
        });
    }

    // Deletes the whole reviews.db, not a selective eviction - debate_rounds/consolidations
    // aren't disposable (re-convene continuity, avoids re-rolling a non-deterministic LLM call).
    // Confirmation is handled in the webview modal.
    private async _clearCacheConfirmed() {
        const dbPath = this._getWorkspaceDbPath();
        if (!dbPath) {
            this.updateStatus('No workspace open', false);
            return;
        }

        try {
            await vscode.workspace.fs.delete(vscode.Uri.file(dbPath));
            this.updateStatus('Cache cleared', false);
            this._sendCacheSize();
        } catch (err) {
            this.updateStatus('No cache to clear', false);
        }
    }

    private async _listGrokModels() {
        // grok is the only one of the three CLIs that exposes a real model-listing
        // command; Claude and Codex have no equivalent, so their pickers stay free-text.
        const proc = spawn('grok models', [], { shell: true });
        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (d) => { stdout += d.toString(); });
        proc.stderr?.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
            if (code !== 0 || !stdout.trim()) {
                if (this._view) {
                    this._view.webview.postMessage({ type: 'grokModelsResult', ok: false, error: (stderr || 'grok models returned no output').substring(0, 200) });
                }
                return;
            }
            // Lines look like "  * grok-4.6 (default)" / "  - grok-4.5"
            const models: string[] = [];
            let defaultModel: string | null = null;
            for (const line of stdout.split('\n')) {
                const m = line.match(/^\s*[*-]\s*([\w.-]+)(\s*\(default\))?/);
                if (m) {
                    models.push(m[1]);
                    if (m[2]) { defaultModel = m[1]; }
                }
            }
            if (this._view) {
                this._view.webview.postMessage({ type: 'grokModelsResult', ok: models.length > 0, models, defaultModel, error: models.length ? undefined : 'Could not parse grok models output' });
            }
        });
        proc.on('error', (err) => {
            if (this._view) {
                this._view.webview.postMessage({ type: 'grokModelsResult', ok: false, error: err.message });
            }
        });
    }

    private _getWorkspaceDbPath(): string | null {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return null;
        }
        return path.join(workspaceFolders[0].uri.fsPath, '.ai-council', 'reviews.db');
    }

    private _getApiKeysEnv(): Record<string, string> {
        const config = vscode.workspace.getConfiguration('ai-council');
        return {
            OPENAI_API_KEY: config.get<string>('apiKeys.openai') || '',
            ANTHROPIC_API_KEY: config.get<string>('apiKeys.anthropic') || '',
            XAI_API_KEY: config.get<string>('apiKeys.xai') || '',
            GOOGLE_API_KEY: config.get<string>('apiKeys.google') || '',
            GROQ_API_KEY: config.get<string>('apiKeys.groq') || '',
            OLLAMA_API_KEY: config.get<string>('apiKeys.ollama') || '',
            AI_COUNCIL_TRANSPORT_OPENAI: config.get<string>('transport.openai') || 'auto',
            AI_COUNCIL_TRANSPORT_ANTHROPIC: config.get<string>('transport.anthropic') || 'auto',
            AI_COUNCIL_TRANSPORT_XAI: config.get<string>('transport.xai') || 'auto',
            AI_COUNCIL_CLI_MODEL_OPENAI: config.get<string>('cliModels.openai') || '',
            AI_COUNCIL_CLI_MODEL_ANTHROPIC: config.get<string>('cliModels.anthropic') || 'sonnet',
            AI_COUNCIL_CLI_MODEL_XAI: config.get<string>('cliModels.xai') || '',
            AI_COUNCIL_REVIEW_RUBRIC: config.get<string>('reviewRubric') || '',
            OLLAMA_URL: config.get<string>('ollamaUrl') || '',
        };
    }

    private _runJsonCommand(args: string[]): Promise<{ result?: any; error?: string }> {
        const config = vscode.workspace.getConfiguration('ai-council');
        const pythonPath = config.get<string>('pythonPath') || 'python';
        const command = `${pythonPath} ${args.join(' ')}`;
        console.log('AI Council: Running scoped command:', command);

        return new Promise((resolve) => {
            const proc = spawn(command, [], { shell: true, env: { ...process.env, ...this._getApiKeysEnv() } });
            let stdout = '';
            let stderr = '';
            proc.stdout?.on('data', (d) => { stdout += d.toString(); });
            proc.stderr?.on('data', (d) => { stderr += d.toString(); });
            proc.on('close', () => {
                const line = stdout.trim().split('\n').pop() || '';
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.error) {
                        resolve({ error: parsed.error });
                    } else {
                        resolve({ result: parsed });
                    }
                } catch (e) {
                    resolve({ error: (stderr || stdout || 'No output').substring(0, 300) });
                }
            });
            proc.on('error', (err) => resolve({ error: err.message }));
        });
    }

    // Same as _runJsonCommand, but also streams the "[DEBATE]"/"[CONSOLIDATE]" stderr stage
    // markers live instead of leaving the UI on one static "Running..." string for the whole call.
    private _runJsonCommandWithProgress(args: string[], progressMessageType: string): Promise<{ result?: any; error?: string }> {
        const config = vscode.workspace.getConfiguration('ai-council');
        const pythonPath = config.get<string>('pythonPath') || 'python';
        const command = `${pythonPath} ${args.join(' ')}`;
        console.log('AI Council: Running scoped command (live):', command);

        return new Promise((resolve) => {
            const proc = spawn(command, [], { shell: true, env: { ...process.env, ...this._getApiKeysEnv() } });
            let stdout = '';
            let stderr = '';
            let stderrBuf = '';
            proc.stdout?.on('data', (d) => { stdout += d.toString(); });
            proc.stderr?.on('data', (d) => {
                const text = d.toString();
                stderr += text;
                stderrBuf += text;
                const lines = stderrBuf.split('\n');
                stderrBuf = lines.pop() || '';
                for (const line of lines) {
                    const match = line.match(/^\[(DEBATE|CONSOLIDATE)\]\s*(.+)$/);
                    if (match && this._view) {
                        this._view.webview.postMessage({ type: progressMessageType, text: match[2] });
                    }
                }
            });
            proc.on('close', () => {
                const line = stdout.trim().split('\n').pop() || '';
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.error) {
                        resolve({ error: parsed.error });
                    } else {
                        resolve({ result: parsed });
                    }
                } catch (e) {
                    resolve({ error: (stderr || stdout || 'No output').substring(0, 300) });
                }
            });
            proc.on('error', (err) => resolve({ error: err.message }));
        });
    }

    // Global flags (must precede the subcommand) in ai_council.py's argparse: CLI seats and
    // Ollama. Mirrors _runReview's args-building exactly - this was previously duplicated as
    // a CLI-seats-only helper, which silently dropped Gemini/Ollama and gave no way to turn
    // OFF an API seat that has a key configured, for every scoped-review command.
    private _modelSeatGlobalArgs(modelConfig?: Partial<ReviewOptions>): string[] {
        const args: string[] = [];
        const config = vscode.workspace.getConfiguration('ai-council');
        if (modelConfig?.enableOllama) {
            args.push('--ollama');
            const ollamaUrl = config.get<string>('ollamaUrl');
            if (ollamaUrl) { args.push('--ollama-url', `"${ollamaUrl}"`); }
            const ollamaModel = config.get<string>('ollamaModel');
            if (ollamaModel) { args.push('--ollama-model', ollamaModel); }
        }
        if (modelConfig?.enableGptCli) { args.push('--gpt-cli'); }
        if (modelConfig?.enableClaudeCli) { args.push('--claude-cli'); }
        if (modelConfig?.enableGrokCli) { args.push('--grok-cli'); }
        return args;
    }

    // Subcommand-level flags that follow the scoped-* subcommand name.
    private _modelSeatSubcommandArgs(modelConfig?: Partial<ReviewOptions>): string[] {
        const args: string[] = [];
        if (modelConfig?.enableGemini) { args.push('--gemini'); }
        if (modelConfig && !modelConfig.enableGpt) { args.push('--no-gpt'); }
        if (modelConfig && !modelConfig.enableClaude) { args.push('--no-claude'); }
        if (modelConfig && !modelConfig.enableGrok) { args.push('--no-grok'); }
        if (modelConfig?.powerMode) { args.push('--power'); }
        return args;
    }

    // Spawns a scoped-review/scoped-followup command with LIVE progress (same mechanism as
    // _runReview: parse "[+] MODEL Score:..." lines as they stream, post reviewProgress for
    // each model card), then reads the structured result back from --json-output once the
    // process closes. Unlike _runJsonCommand, this never blocks the UI with no feedback until
    // the whole run finishes.
    private async _runScopedCommandWithProgress(
        args: string[],
        resultMessageType: string,
        progressMessageType: string
    ): Promise<void> {
        const config = vscode.workspace.getConfiguration('ai-council');
        const pythonPath = config.get<string>('pythonPath') || 'python';
        const jsonOutputPath = path.join(require('os').tmpdir(), `ai-council-scoped-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
        const fullArgs = [...args, '--json-output', `"${jsonOutputPath}"`];
        const command = `${pythonPath} ${fullArgs.join(' ')}`;
        console.log('AI Council: Running scoped command (live):', command);

        const modelResults: Record<string, ModelResult> = {};
        let stdout = '';
        let stderr = '';

        const proc = spawn(command, [], { shell: true, env: { ...process.env, ...this._getApiKeysEnv() } });

        proc.stdout?.on('data', (d) => {
            const text = d.toString();
            stdout += text;
            const update = parseModelProgressLine(text, modelResults);
            if (update && this._view) {
                this._view.webview.postMessage({ type: progressMessageType, model: update.model, data: update.data });
            }
        });
        proc.stderr?.on('data', (d) => { stderr += d.toString(); });

        await new Promise<void>((resolve) => {
            proc.on('close', () => resolve());
            proc.on('error', (err) => { stderr += err.message; resolve(); });
        });

        rescanModelResults(stdout, modelResults);

        const fs = require('fs');
        let result: any = undefined;
        let error: string | undefined;
        try {
            const raw = fs.readFileSync(jsonOutputPath, 'utf-8');
            fs.unlinkSync(jsonOutputPath);
            const parsed = JSON.parse(raw);
            if (parsed.error) {
                error = parsed.error;
            } else {
                result = parsed;
            }
        } catch (e) {
            error = (stderr || stdout || 'No output').substring(0, 300);
        }

        this._view?.webview.postMessage({ type: resultMessageType, result, error, liveModelResults: modelResults });
    }

    private async _scopedReview(scope: string, modelConfig?: Partial<ReviewOptions>) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            this._view?.webview.postMessage({ type: 'scopedReviewResult', error: 'No file open to review' });
            return;
        }
        const filePath = editor.document.uri.fsPath;
        const scriptPath = this._getScriptPath();
        const dbPath = this._getWorkspaceDbPath();
        if (!dbPath) {
            this._view?.webview.postMessage({ type: 'scopedReviewResult', error: 'No workspace folder open' });
            return;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath || path.dirname(filePath);
        const reportsDir = path.join(workspaceRoot, '.ai-council', 'reports');
        const fs = require('fs');
        if (!fs.existsSync(reportsDir)) { fs.mkdirSync(reportsDir, { recursive: true }); }
        const fileBaseName = path.basename(filePath, path.extname(filePath)).substring(0, 30);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const reportPath = path.join(reportsDir, `scoped-review-${fileBaseName}-${timestamp}.html`);

        const models: string[] = [];
        if (modelConfig?.enableGpt) { models.push('gpt-4'); }
        if (modelConfig?.enableClaude) { models.push('claude'); }
        if (modelConfig?.enableGrok) { models.push('grok'); }
        if (modelConfig?.enableGptCli) { models.push('gpt-cli'); }
        if (modelConfig?.enableClaudeCli) { models.push('claude-cli'); }
        if (modelConfig?.enableGrokCli) { models.push('grok-cli'); }
        if (modelConfig?.enableGemini) { models.push('gemini'); }
        if (modelConfig?.enableOllama) { models.push('ollama'); }
        this._view?.webview.postMessage({ type: 'scopedRoundStart', roundNum: 0, models });

        const args = [`"${scriptPath}"`, '--db', `"${dbPath}"`, ...this._modelSeatGlobalArgs(modelConfig),
            'scoped-review', `"${filePath}"`, '--scope', winQuoteArg(scope),
            ...this._modelSeatSubcommandArgs(modelConfig), '--html', '--output', `"${reportPath}"`];

        await this._runScopedCommandWithProgress(args, 'scopedReviewResult', 'scopedRoundProgress');
    }

    private async _scopedFollowup(sessionId: string, question: string, modelConfig?: Partial<ReviewOptions>) {
        const dbPath = this._getWorkspaceDbPath();
        if (!dbPath) {
            this._view?.webview.postMessage({ type: 'scopedFollowupResult', error: 'No workspace folder open' });
            return;
        }
        const scriptPath = this._getScriptPath();

        const workspaceFolders = vscode.workspace.workspaceFolders;
        const reportsDir = workspaceFolders?.[0]?.uri.fsPath ? path.join(workspaceFolders[0].uri.fsPath, '.ai-council', 'reports') : undefined;
        let reportArgs: string[] = [];
        if (reportsDir) {
            const fs = require('fs');
            if (!fs.existsSync(reportsDir)) { fs.mkdirSync(reportsDir, { recursive: true }); }
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const reportPath = path.join(reportsDir, `scoped-followup-${sessionId.slice(0, 8)}-${timestamp}.html`);
            reportArgs = ['--html', '--output', `"${reportPath}"`];
        }

        const models: string[] = [];
        if (modelConfig?.enableGpt) { models.push('gpt-4'); }
        if (modelConfig?.enableClaude) { models.push('claude'); }
        if (modelConfig?.enableGrok) { models.push('grok'); }
        if (modelConfig?.enableGptCli) { models.push('gpt-cli'); }
        if (modelConfig?.enableClaudeCli) { models.push('claude-cli'); }
        if (modelConfig?.enableGrokCli) { models.push('grok-cli'); }
        if (modelConfig?.enableGemini) { models.push('gemini'); }
        if (modelConfig?.enableOllama) { models.push('ollama'); }
        this._view?.webview.postMessage({ type: 'scopedRoundStart', models });

        const args = [`"${scriptPath}"`, '--db', `"${dbPath}"`, ...this._modelSeatGlobalArgs(modelConfig),
            'scoped-followup', '--session', `"${sessionId}"`, '--question', winQuoteArg(question),
            ...this._modelSeatSubcommandArgs(modelConfig), ...reportArgs];

        await this._runScopedCommandWithProgress(args, 'scopedFollowupResult', 'scopedRoundProgress');
    }

    private async _scopedFinalize(sessionId: string, writer: string, modelConfig?: Partial<ReviewOptions>) {
        const dbPath = this._getWorkspaceDbPath();
        if (!dbPath) {
            this._view?.webview.postMessage({ type: 'scopedFinalizeResult', error: 'No workspace folder open' });
            return;
        }
        const scriptPath = this._getScriptPath();

        const args = [`"${scriptPath}"`, '--db', `"${dbPath}"`, ...this._modelSeatGlobalArgs(modelConfig),
            'scoped-finalize', '--session', `"${sessionId}"`,
            ...this._modelSeatSubcommandArgs(modelConfig), '--json'];
        if (writer) {
            args.push('--writer', writer);
        }

        const { result, error } = await this._runJsonCommand(args);
        this._view?.webview.postMessage({ type: 'scopedFinalizeResult', result, error });
    }

    private async _runDebate(sessionId: string, arbiter: string | null, modelConfig?: Partial<ReviewOptions>) {
        const dbPath = this._getWorkspaceDbPath();
        if (!dbPath) {
            this._view?.webview.postMessage({ type: 'debateResult', error: 'No workspace folder open' });
            return;
        }
        const scriptPath = this._getScriptPath();

        const args = [`"${scriptPath}"`, '--db', `"${dbPath}"`, ...this._modelSeatGlobalArgs(modelConfig),
            'debate', '--session', `"${sessionId}"`, '--json'];
        if (arbiter) {
            args.push('--mode', 'arbiter', '--arbiter', arbiter);
        }

        const { result, error } = await this._runJsonCommandWithProgress(args, 'debateProgress');
        this._view?.webview.postMessage({ type: 'debateResult', result, error });
    }

    private async _runConsolidate(sessionId: string, modelConfig?: Partial<ReviewOptions>) {
        const dbPath = this._getWorkspaceDbPath();
        if (!dbPath) {
            this._view?.webview.postMessage({ type: 'consolidateResult', error: 'No workspace folder open' });
            return;
        }
        const scriptPath = this._getScriptPath();

        const args = [`"${scriptPath}"`, '--db', `"${dbPath}"`, ...this._modelSeatGlobalArgs(modelConfig),
            'consolidate', '--session', `"${sessionId}"`, '--json'];

        const { result, error } = await this._runJsonCommandWithProgress(args, 'debateProgress');
        this._view?.webview.postMessage({ type: 'consolidateResult', result, error });
    }

    private async _sendCacheSize() {
        const dbPath = this._getWorkspaceDbPath();
        if (!dbPath) {
            if (this._view) {
                this._view.webview.postMessage({ type: 'cacheSize', size: null });
            }
            return;
        }

        try {
            const stat = await vscode.workspace.fs.stat(vscode.Uri.file(dbPath));
            const sizeKB = Math.round(stat.size / 1024);
            const sizeStr = sizeKB >= 1024 ? `${(sizeKB / 1024).toFixed(1)} MB` : `${sizeKB} KB`;

            if (this._view) {
                this._view.webview.postMessage({
                    type: 'cacheSize',
                    size: sizeStr
                });
            }
        } catch (err) {
            // File doesn't exist
            if (this._view) {
                this._view.webview.postMessage({
                    type: 'cacheSize',
                    size: null
                });
            }
        }
    }

    private async _showStatus(toggles?: { gpt: boolean; claude: boolean; grok: boolean; gptCli?: boolean; claudeCli?: boolean; grokCli?: boolean; gemini: boolean; ollama: boolean }) {
        const config = vscode.workspace.getConfiguration('ai-council');
        const pythonPath = config.get<string>('pythonPath') || 'python';
        const scriptPath = this._getScriptPath();
        const dbPath = this._getWorkspaceDbPath();

        // Get API keys from VS Code settings
        const apiKeys = {
            OPENAI_API_KEY: config.get<string>('apiKeys.openai') || '',
            ANTHROPIC_API_KEY: config.get<string>('apiKeys.anthropic') || '',
            XAI_API_KEY: config.get<string>('apiKeys.xai') || '',
            GOOGLE_API_KEY: config.get<string>('apiKeys.google') || '',
            GROQ_API_KEY: config.get<string>('apiKeys.groq') || '',
            OLLAMA_API_KEY: config.get<string>('apiKeys.ollama') || '',
            AI_COUNCIL_TRANSPORT_OPENAI: config.get<string>('transport.openai') || 'auto',
            AI_COUNCIL_TRANSPORT_ANTHROPIC: config.get<string>('transport.anthropic') || 'auto',
            AI_COUNCIL_TRANSPORT_XAI: config.get<string>('transport.xai') || 'auto',
            AI_COUNCIL_CLI_MODEL_OPENAI: config.get<string>('cliModels.openai') || '',
            AI_COUNCIL_CLI_MODEL_ANTHROPIC: config.get<string>('cliModels.anthropic') || 'sonnet',
            AI_COUNCIL_CLI_MODEL_XAI: config.get<string>('cliModels.xai') || '',
            AI_COUNCIL_REVIEW_RUBRIC: config.get<string>('reviewRubric') || '',
            OLLAMA_URL: config.get<string>('ollamaUrl') || '',
        };

        // Send loading state
        if (this._view) {
            this._view.webview.postMessage({ type: 'statusPanel', loading: true });
        }

        // Start org info fetch immediately
        console.log('AI Council: Starting org info fetch...');
        const orgInfoPromise = this._fetchAllOrgInfo(apiKeys);

        // Build args - global flags must come BEFORE the subcommand
        const ollamaUrl = config.get<string>('ollamaUrl');
        const ollamaModel = config.get<string>('ollamaModel');
        let args = [`"${scriptPath}"`];

        // Add db path if available
        if (dbPath) {
            args.push('--db', `"${dbPath}"`);
        }

        // Add ollama flags BEFORE the subcommand (ollama is global)
        if (ollamaUrl && apiKeys.OLLAMA_API_KEY) {
            args.push('--ollama');
            args.push('--ollama-url', `"${ollamaUrl}"`);
            if (ollamaModel) {
                args.push('--ollama-model', ollamaModel);
            }
        }

        // Add subcommand LAST
        args.push('status');

        console.log('AI Council: Status command args:', args);

        // Build selected reviewers list from toggles (for display, not for Python)
        const selectedReviewers: string[] = [];
        if (toggles?.gpt && apiKeys.OPENAI_API_KEY) selectedReviewers.push('gpt-4');
        if (toggles?.claude && apiKeys.ANTHROPIC_API_KEY) selectedReviewers.push('claude');
        if (toggles?.grok && apiKeys.XAI_API_KEY) selectedReviewers.push('grok');
        if (toggles?.gptCli) selectedReviewers.push('gpt-cli');
        if (toggles?.claudeCli) selectedReviewers.push('claude-cli');
        if (toggles?.grokCli) selectedReviewers.push('grok-cli');
        if (toggles?.gemini && apiKeys.GOOGLE_API_KEY) selectedReviewers.push('gemini');
        if (toggles?.ollama && ollamaUrl && apiKeys.OLLAMA_API_KEY) {
            selectedReviewers.push(`ollama (${ollamaModel || 'default'})`);
        }

        // Wrap process in a promise
        const statusPromise = new Promise<Record<string, string>>((resolve) => {
            const cmd = `${pythonPath} ${args.join(' ')}`;
            console.log('AI Council: Running status command:', cmd);
            const statusProcess = spawn(cmd, [], {
                shell: true,
                env: { ...process.env, ...apiKeys }
            });

            let output = '';
            statusProcess.stdout?.on('data', (data) => {
                output += data.toString();
            });

            let stderr = '';
            statusProcess.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            statusProcess.on('close', (code) => {
                console.log('AI Council: Status command exit code:', code);
                console.log('AI Council: Status stdout:', output);
                if (stderr) {
                    console.log('AI Council: Status stderr:', stderr);
                }
                const lines = output.trim().split('\n').filter(l => l.trim());
                const status: Record<string, string> = {
                    database: '',
                    reviewers: '',
                    pending: ''
                };

                for (const line of lines) {
                    if (line.includes('Database:')) {
                        status.database = line.split('Database:')[1]?.trim() || 'Unknown';
                    } else if (line.includes('Reviewers:')) {
                        status.reviewers = line.split('Reviewers:')[1]?.trim() || 'None';
                    } else if (line.includes('Pending')) {
                        status.pending = line.split(':')[1]?.trim() || '0';
                    }
                }
                resolve(status);
            });
        });

        // Wait for both to complete
        const [status, orgInfo] = await Promise.all([statusPromise, orgInfoPromise]);

        // Override reviewers with our computed list from toggles
        status.reviewers = selectedReviewers.length > 0 ? selectedReviewers.join(', ') : 'None selected';

        console.log('AI Council: Got status and orgInfo:', JSON.stringify(orgInfo));

        // DEBUG: If orgInfo is empty but we have an OpenAI key, something went wrong with the fetch
        if (apiKeys.OPENAI_API_KEY && !orgInfo.openai) {
            console.log('AI Council: WARNING - OpenAI key present but no org info fetched');
            // Fallback: just show "Connected" if we have a key
            orgInfo.openai = 'Connected';
        }

        if (this._view) {
            console.log('AI Council: Sending to webview - orgInfo:', JSON.stringify(orgInfo));
            this._view.webview.postMessage({
                type: 'statusPanel',
                loading: false,
                status,
                orgInfo
            });
        }
    }

    private async _fetchAllOrgInfo(apiKeys: Record<string, string>): Promise<Record<string, string | null>> {
        const orgInfo: Record<string, string | null> = {};

        console.log('AI Council: _fetchAllOrgInfo called, has OpenAI key:', !!apiKeys.OPENAI_API_KEY);

        // Fetch OpenAI org if key exists
        if (apiKeys.OPENAI_API_KEY) {
            orgInfo.openai = await this._fetchOpenAIOrg(apiKeys.OPENAI_API_KEY);
            console.log('AI Council: OpenAI org result:', orgInfo.openai);
        }

        // Add more providers here as they become available

        return orgInfo;
    }

    private async _cliOnPath(bin: string): Promise<boolean> {
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
    }

    private async _fetchOpenAIOrg(apiKey: string): Promise<string | null> {
        return new Promise((resolve) => {
            const options = {
                hostname: 'api.openai.com',
                path: '/v1/me',
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 5000
            };

            console.log('AI Council: Fetching OpenAI account info...');

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    console.log('AI Council: OpenAI response status:', res.statusCode);
                    try {
                        const json = JSON.parse(data);
                        console.log('AI Council: OpenAI response:', JSON.stringify(json).substring(0, 200));

                        // /v1/me returns { email, name, ... }
                        const email = json.email;

                        if (email) {
                            console.log('AI Council: Found OpenAI account:', email);
                            resolve(email);
                        } else {
                            resolve(null);
                        }
                    } catch (e) {
                        console.log('AI Council: OpenAI parse error:', e);
                        resolve(null);
                    }
                });
            });

            req.on('error', (e) => {
                console.log('AI Council: OpenAI request error:', e);
                resolve(null);
            });
            req.on('timeout', () => {
                console.log('AI Council: OpenAI request timeout');
                req.destroy();
                resolve(null);
            });
            req.end();
        });
    }

    private async _fetchAnthropicInfo(apiKey: string): Promise<string | null> {
        // Anthropic doesn't have a public org endpoint, but we can validate the key
        // by checking if it starts with expected prefix
        if (apiKey.startsWith('sk-ant-')) {
            return 'Valid Key';
        }
        return null;
    }

    private async _sendApiKeyStatus() {
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
            const cliModels = {
                openai: config.get<string>('cliModels.openai') || '',
                anthropic: config.get<string>('cliModels.anthropic') || 'sonnet',
                xai: config.get<string>('cliModels.xai') || '',
            };
            this._view.webview.postMessage({
                type: 'apiKeyStatus',
                status: keyStatus,
                seatMeta: seatMeta,
                orgInfo: orgInfo,
                cliModels: cliModels
            });
        }
    }

    private _getHtmlContent(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Council</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            padding: 12px;
        }

        .header {
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .header-top {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            margin-bottom: 4px;
        }

        .header .logo {
            opacity: 0.9;
            flex-shrink: 0;
        }

        .header h2 {
            font-size: 16px;
            font-weight: 600;
            color: var(--vscode-foreground);
            margin: 0;
        }

        .header .subtitle {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            text-align: center;
        }

        .section {
            margin-bottom: 16px;
        }

        .section-title {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
            letter-spacing: 0.5px;
        }

        .collapsible-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            cursor: pointer;
            padding: 8px 0;
            margin-bottom: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
            user-select: none;
        }

        .collapsible-header:hover {
            opacity: 0.8;
        }

        .collapsible-title {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            color: var(--vscode-foreground);
            letter-spacing: 0.5px;
        }

        .collapsible-arrow {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            transition: transform 0.2s ease;
        }

        .collapsible-header.collapsed .collapsible-arrow {
            transform: rotate(-90deg);
        }

        .collapsible-content {
            overflow: hidden;
            transition: max-height 0.25s ease-out, opacity 0.2s ease;
            max-height: 1000px;
            opacity: 1;
        }

        .collapsible-content.collapsed {
            max-height: 0;
            opacity: 0;
        }

        .btn {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            width: 100%;
            padding: 8px 12px;
            margin-bottom: 6px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-family: inherit;
            transition: background 0.15s, opacity 0.15s;
        }

        .btn:hover {
            opacity: 0.9;
        }

        .btn:active {
            opacity: 0.8;
        }

        /* !important so this wins over every color variant's own background/:hover. */
        .btn:disabled,
        .btn:disabled:hover,
        .btn:disabled:active {
            background: var(--vscode-button-secondaryBackground, #3a3d41) !important;
            color: var(--vscode-disabledForeground, #6b6b6b) !important;
            opacity: 0.5;
            cursor: not-allowed;
        }

        .btn-primary {
            background: linear-gradient(135deg, #14b8a6 0%, #0d9488 100%);
            color: white;
        }

        .btn-primary:hover {
            background: linear-gradient(135deg, #2dd4bf 0%, #14b8a6 100%);
        }

        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .btn-secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .btn-power {
            background: linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%);
            color: white;
        }

        .btn-danger {
            background: var(--vscode-inputValidation-errorBackground);
            color: var(--vscode-inputValidation-errorForeground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
        }

        .btn-commit {
            background: linear-gradient(135deg, #115e59 0%, #064e3b 100%);
            color: white;
        }

        .btn-commit:hover {
            background: linear-gradient(135deg, #0f766e 0%, #115e59 100%);
        }

        .btn-scoped {
            background: linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%);
            color: white;
        }

        .btn-scoped:hover {
            background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
        }

        .toggle-group {
            display: flex;
            flex-direction: column;
            gap: 10px;
            margin-bottom: 12px;
        }

        /* Options section styling */
        .options-section {
            background: rgba(139, 92, 246, 0.05);
            border: 1px solid rgba(139, 92, 246, 0.2);
            border-radius: 8px;
            padding: 12px;
            margin-bottom: 16px;
        }

        .options-section .section-title {
            color: #a78bfa;
            font-size: 12px;
            margin-bottom: 10px;
        }

        .toggle-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            font-size: 12px;
        }

        .toggle-label {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .toggle-switch {
            position: relative;
            width: 36px;
            height: 20px;
            flex-shrink: 0;
        }

        .toggle-switch input {
            opacity: 0;
            width: 0;
            height: 0;
        }

        .toggle-slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            transition: 0.2s;
            border-radius: 20px;
        }

        .toggle-slider:before {
            position: absolute;
            content: "";
            height: 14px;
            width: 14px;
            left: 2px;
            bottom: 2px;
            background-color: var(--vscode-descriptionForeground);
            transition: 0.2s;
            border-radius: 50%;
        }

        .toggle-switch input:checked + .toggle-slider {
            background-color: var(--vscode-button-background);
            border-color: var(--vscode-button-background);
        }

        .toggle-switch input:checked + .toggle-slider:before {
            transform: translateX(16px);
            background-color: white;
        }

        /* Model-specific toggle colors */
        .toggle-switch.gpt input:checked + .toggle-slider {
            background: linear-gradient(135deg, #10a37f 0%, #0d8a6a 100%);
            border-color: #10a37f;
        }

        .toggle-switch.claude input:checked + .toggle-slider {
            background: linear-gradient(135deg, #d4a574 0%, #c4956a 100%);
            border-color: #d4a574;
        }

        .toggle-switch.grok input:checked + .toggle-slider {
            background: linear-gradient(135deg, #1d9bf0 0%, #1a8cd8 100%);
            border-color: #1d9bf0;
        }

        .toggle-switch.gemini input:checked + .toggle-slider {
            background: linear-gradient(135deg, #4285f4 0%, #3b78e7 100%);
            border-color: #4285f4;
        }

        .toggle-switch.ollama input:checked + .toggle-slider {
            background: linear-gradient(135deg, #ff6b35 0%, #e55a2b 100%);
            border-color: #ff6b35;
        }

        .toggle-switch.mistral input:checked + .toggle-slider {
            background: linear-gradient(135deg, #ff7000 0%, #e66300 100%);
            border-color: #ff7000;
        }

        .toggle-switch.deepseek input:checked + .toggle-slider {
            background: linear-gradient(135deg, #0066ff 0%, #0052cc 100%);
            border-color: #0066ff;
        }

        .toggle-switch.qwen input:checked + .toggle-slider {
            background: linear-gradient(135deg, #6c5ce7 0%, #5b4cdb 100%);
            border-color: #6c5ce7;
        }

        .toggle-switch.llama input:checked + .toggle-slider {
            background: linear-gradient(135deg, #e84118 0%, #c23616 100%);
            border-color: #e84118;
        }

        .toggle-switch.cohere input:checked + .toggle-slider {
            background: linear-gradient(135deg, #39c0c8 0%, #2da8af 100%);
            border-color: #39c0c8;
        }

        /* Power Mode - prominent styling */
        .power-mode-item {
            background: linear-gradient(135deg, rgba(139, 92, 246, 0.1) 0%, rgba(99, 102, 241, 0.1) 100%);
            border: 1px solid rgba(139, 92, 246, 0.3);
            border-radius: 6px;
            padding: 8px 10px;
            margin: -4px -6px;
        }

        .power-mode-item .toggle-label {
            font-weight: 600;
            color: #a78bfa;
        }

        .power-mode-item.active {
            background: linear-gradient(135deg, rgba(139, 92, 246, 0.25) 0%, rgba(99, 102, 241, 0.25) 100%);
            border-color: #8b5cf6;
            box-shadow: 0 0 12px rgba(139, 92, 246, 0.4);
        }

        .power-mode-item.active .toggle-label {
            color: #c4b5fd;
        }

        .toggle-switch.power input:checked + .toggle-slider {
            background: linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%);
            border-color: #8b5cf6;
            box-shadow: 0 0 8px rgba(139, 92, 246, 0.6);
        }

        .model-badge {
            font-size: 9px;
            padding: 2px 5px;
            border-radius: 3px;
            margin-left: 6px;
            font-weight: 500;
        }

        .badge-coming {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            opacity: 0.6;
        }

        .badge-free {
            background: #22c55e;
            color: white;
        }

        .status-bar {
            margin-top: 16px;
            padding: 12px;
            background: var(--vscode-input-background);
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            text-align: center;
        }

        .status-bar.loading {
            animation: pulse 1.5s infinite;
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.6; }
        }

        .status-panel {
            margin-top: 12px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            overflow: hidden;
        }

        .status-panel-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 10px;
            background: rgba(255, 255, 255, 0.05);
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 11px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
        }

        .status-panel-header .close-btn {
            background: none;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            font-size: 16px;
            padding: 0 4px;
            line-height: 1;
        }

        .status-panel-header .close-btn:hover {
            color: var(--vscode-foreground);
        }

        .status-panel-content {
            padding: 8px 10px;
        }

        .status-panel-content.loading {
            text-align: center;
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }

        .status-section-title {
            font-size: 10px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-top: 8px;
            margin-bottom: 4px;
            padding-bottom: 2px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .status-section-title:first-child {
            margin-top: 0;
        }

        .status-row {
            display: flex;
            justify-content: space-between;
            font-size: 11px;
            padding: 3px 0;
            gap: 8px;
        }

        .status-label {
            color: var(--vscode-descriptionForeground);
            flex-shrink: 0;
        }

        .status-value {
            color: var(--vscode-foreground);
            font-family: 'JetBrains Mono', monospace;
            text-align: right;
            word-break: break-word;
            flex: 1;
            min-width: 0;
        }

        /* Review Progress Panel */
        .review-panel {
            margin-top: 4px;
            background: linear-gradient(180deg, rgba(20, 184, 166, 0.05) 0%, rgba(15, 118, 110, 0.1) 100%);
            border: 1px solid rgba(20, 184, 166, 0.3);
            border-radius: 10px;
            overflow: hidden;
            animation: slideIn 0.3s ease-out;
        }

        @keyframes slideIn {
            from { opacity: 0; transform: translateY(-10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .review-panel-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 12px;
            background: rgba(20, 184, 166, 0.15);
            border-bottom: 1px solid rgba(20, 184, 166, 0.2);
        }

        .review-panel-title {
            font-size: 12px;
            font-weight: 600;
            color: #2dd4bf;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .review-panel-close {
            background: none;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            font-size: 16px;
            padding: 0 4px;
            opacity: 0.7;
        }

        .review-panel-close:hover { opacity: 1; }

        .review-panel-content {
            padding: 12px;
        }

        .review-file-name {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 12px;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        /* Model Cards */
        .model-card {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 12px;
            margin-bottom: 8px;
            background: var(--vscode-input-background);
            border-radius: 8px;
            border-left: 3px solid var(--vscode-panel-border);
            transition: all 0.3s ease;
        }

        .model-card.gpt { border-left-color: #10a37f; }
        .model-card.claude { border-left-color: #d4a574; }
        .model-card.grok { border-left-color: #1d9bf0; }
        .model-card.gemini { border-left-color: #8b5cf6; }

        .model-card.reviewing {
            background: linear-gradient(90deg, var(--vscode-input-background) 0%, rgba(255,255,255,0.05) 50%, var(--vscode-input-background) 100%);
            background-size: 200% 100%;
            animation: shimmer 1.5s infinite;
        }

        @keyframes shimmer {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
        }

        .model-card.complete {
            background: rgba(34, 197, 94, 0.1);
        }

        .model-card.error {
            background: rgba(239, 68, 68, 0.1);
            border-left-color: #ef4444;
        }

        .model-card-left {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .model-icon {
            width: 28px;
            height: 28px;
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            font-weight: bold;
            color: white;
        }

        .model-icon.gpt { background: linear-gradient(135deg, #10a37f, #0d8a6a); }
        .model-icon.claude { background: linear-gradient(135deg, #d4a574, #c4956a); }
        .model-icon.grok { background: linear-gradient(135deg, #1d9bf0, #1a8cd8); }
        .model-icon.gemini { background: linear-gradient(135deg, #8b5cf6, #7c3aed); }
        .model-icon.ollama { background: linear-gradient(135deg, #ff6b35, #e55a2b); }

        .model-info {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .model-name {
            font-size: 12px;
            font-weight: 600;
            color: var(--vscode-foreground);
        }

        .model-status {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
        }

        .model-card-right {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        /* Spinner */
        .model-spinner {
            width: 18px;
            height: 18px;
            border: 2px solid var(--vscode-panel-border);
            border-top-color: #14b8a6;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        .model-spinner.stopped,
        .model-score-ring.stopped {
            animation: none !important;
            opacity: 0.3;
        }

        /* Checkmark */
        .checkmark {
            width: 18px;
            height: 18px;
            border-radius: 50%;
            background: #22c55e;
            display: flex;
            align-items: center;
            justify-content: center;
            animation: popIn 0.3s ease-out;
        }

        .checkmark::after {
            content: '';
            width: 5px;
            height: 9px;
            border: solid white;
            border-width: 0 2px 2px 0;
            transform: rotate(45deg) translateY(-1px);
        }

        @keyframes popIn {
            0% { transform: scale(0); }
            70% { transform: scale(1.2); }
            100% { transform: scale(1); }
        }

        /* Error X */
        .error-x {
            width: 18px;
            height: 18px;
            border-radius: 50%;
            background: #ef4444;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            color: white;
            font-weight: bold;
        }

        /* Score Display */
        .score-badge {
            padding: 4px 10px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 700;
            font-family: 'JetBrains Mono', monospace;
            animation: fadeIn 0.3s ease-out;
        }

        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }

        .score-badge.good {
            background: rgba(34, 197, 94, 0.2);
            color: #22c55e;
        }

        .score-badge.medium {
            background: rgba(245, 158, 11, 0.2);
            color: #f59e0b;
        }

        .score-badge.low {
            background: rgba(239, 68, 68, 0.2);
            color: #ef4444;
        }

        /* Issues Count */
        .issues-badge {
            font-size: 10px;
            padding: 2px 6px;
            border-radius: 8px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }

        /* Summary Section */
        .review-summary {
            margin-top: 12px;
            padding: 12px;
            background: linear-gradient(135deg, rgba(20, 184, 166, 0.1) 0%, rgba(139, 92, 246, 0.1) 100%);
            border-radius: 8px;
            border: 1px solid rgba(20, 184, 166, 0.2);
            animation: fadeIn 0.5s ease-out;
        }

        .summary-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }

        .summary-title {
            font-size: 11px;
            font-weight: 600;
            color: #2dd4bf;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .consensus-score {
            font-size: 20px;
            font-weight: 700;
            font-family: 'JetBrains Mono', monospace;
        }

        .summary-stats {
            display: flex;
            gap: 12px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }

        .stat-item {
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .stat-value {
            font-weight: 600;
            color: var(--vscode-foreground);
        }

        /* Open Report Button */
        .open-report-btn {
            width: 100%;
            margin-top: 12px;
            padding: 10px;
            background: linear-gradient(135deg, #14b8a6 0%, #0d9488 100%);
            border: none;
            border-radius: 6px;
            color: white;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            transition: all 0.2s ease;
        }

        .open-report-btn:hover {
            background: linear-gradient(135deg, #2dd4bf 0%, #14b8a6 100%);
            transform: translateY(-1px);
        }

        .fix-code-btn {
            width: 100%;
            margin-top: 8px;
            padding: 10px;
            background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
            border: none;
            border-radius: 6px;
            color: white;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            transition: all 0.2s ease;
        }

        .fix-code-btn:hover {
            background: linear-gradient(135deg, #a78bfa 0%, #8b5cf6 100%);
            transform: translateY(-1px);
        }

        .fix-code-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }

        /* Scoped Review */
        .scoped-review-panel {
            display: none;
            margin-top: 10px;
            padding: 12px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 8px;
        }

        .scoped-review-panel textarea {
            width: 100%;
            min-height: 60px;
            resize: vertical;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            padding: 8px;
            font-family: inherit;
            font-size: 12px;
            box-sizing: border-box;
        }

        .scoped-review-panel .btn {
            width: 100%;
            margin-top: 8px;
        }

        .scoped-round {
            margin-top: 10px;
        }

        .scoped-round-title {
            font-size: 11px;
            font-weight: 600;
            opacity: 0.7;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 8px;
        }

        .scoped-round-elapsed {
            text-transform: none;
            letter-spacing: normal;
            font-weight: 400;
            font-family: 'JetBrains Mono', monospace;
            opacity: 0.8;
        }

        /* Round cards reuse .model-card/.model-icon/.score-badge/.review-summary as-is -
           same live spinner -> checkmark/error -> score-badge sequence as "Review Current
           File", and the same "Open Full Report" pattern for full issue detail. */

        .scoped-followup-row {
            display: flex;
            gap: 6px;
            margin-top: 10px;
        }

        .scoped-finalize-row {
            display: flex;
            gap: 6px;
            margin-top: 10px;
            align-items: center;
        }

        .scoped-finalize-row select {
            flex: 1;
        }

        /* Debate */
        #debateStartRow, #debateSection {
            margin-top: 10px;
            padding-top: 10px;
            border-top: 1px solid var(--vscode-widget-border);
        }

        .debate-consensus-row {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 6px;
        }

        .debate-consensus-label {
            font-size: 11px;
            font-weight: 600;
            opacity: 0.8;
            flex-shrink: 0;
        }

        .debate-consensus-bar {
            flex: 1;
            height: 8px;
            border-radius: 4px;
            background: var(--vscode-input-background);
            overflow: hidden;
        }

        .debate-consensus-fill {
            height: 100%;
            background: linear-gradient(90deg, #ef4444 0%, #f59e0b 50%, #22c55e 100%);
            width: 0%;
            transition: width 0.4s ease;
        }

        .debate-consensus-pct {
            font-size: 12px;
            font-weight: 700;
            font-family: 'JetBrains Mono', monospace;
            flex-shrink: 0;
            min-width: 40px;
            text-align: right;
        }

        .debate-token-usage {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-bottom: 10px;
            font-size: 10px;
            opacity: 0.75;
            font-family: 'JetBrains Mono', monospace;
        }

        .debate-token-usage span {
            padding: 2px 6px;
            border-radius: 4px;
            background: var(--vscode-input-background);
        }

        .debate-round {
            margin-bottom: 10px;
            padding: 10px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
        }

        .debate-round-header {
            font-size: 11px;
            font-weight: 600;
            opacity: 0.7;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 8px;
        }

        .debate-cluster {
            margin-bottom: 10px;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .debate-cluster:last-child {
            border-bottom: none;
            margin-bottom: 0;
            padding-bottom: 0;
        }

        .debate-cluster-summary {
            font-size: 12px;
            font-weight: 600;
            margin-bottom: 4px;
        }

        .debate-cluster-members {
            font-size: 10px;
            opacity: 0.6;
            margin-bottom: 6px;
        }

        .debate-position {
            font-size: 11px;
            margin: 4px 0;
            padding-left: 8px;
            border-left: 3px solid var(--vscode-widget-border);
        }

        .debate-position.agree { border-left-color: #22c55e; }
        .debate-position.dispute { border-left-color: #ef4444; }
        .debate-position.refine { border-left-color: #f59e0b; }

        .debate-position-model {
            font-weight: 700;
            text-transform: uppercase;
            font-size: 10px;
            margin-right: 4px;
        }

        .debate-ruling {
            font-size: 11px;
            margin-top: 6px;
            padding: 6px 8px;
            border-radius: 6px;
            background: rgba(139, 92, 246, 0.1);
            border-left: 3px solid #8b5cf6;
        }

        .consolidated-finding {
            margin: 8px 0;
            padding: 8px 10px;
            border-radius: 6px;
            background: var(--vscode-input-background);
        }

        .consolidated-finding-severity {
            font-weight: 700;
            font-family: 'JetBrains Mono', monospace;
            font-size: 11px;
            margin-right: 4px;
        }

        .consolidated-open-question {
            margin: 8px 0;
            padding: 8px 10px;
            border-radius: 6px;
            background: rgba(245, 158, 11, 0.1);
            border-left: 3px solid #f59e0b;
        }

        .cancel-review-btn {
            width: 100%;
            margin-top: 12px;
            padding: 8px;
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
            border: none;
            border-radius: 6px;
            color: white;
            font-size: 11px;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            transition: all 0.2s ease;
        }

        .cancel-review-btn:hover {
            background: linear-gradient(135deg, #f87171 0%, #ef4444 100%);
        }

        .icon {
            font-size: 14px;
        }

        .divider {
            height: 1px;
            background: var(--vscode-panel-border);
            margin: 12px 0;
        }

        .info-text {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            text-align: center;
            margin-top: 8px;
        }

        .version-footer {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            text-align: center;
            margin-top: 16px;
            opacity: 0.5;
        }

        .tools-section {
            padding: 8px 0 !important;
            margin-bottom: 4px !important;
        }

        .tools-row {
            display: flex;
            gap: 6px;
        }

        .tool-btn {
            flex: 1;
            padding: 6px 8px;
            font-size: 10px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            white-space: nowrap;
        }

        .tool-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .tool-btn-danger {
            background: rgba(127, 29, 29, 0.5);
            border: 1px solid rgba(239, 68, 68, 0.3);
        }

        .tool-btn-danger:hover {
            background: rgba(127, 29, 29, 0.8);
        }

        .synthesizer-item {
            margin-top: 8px;
        }

        /* Consistent dropdown styling for all selects */
        select {
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 4px;
            padding: 6px 10px;
            font-size: 11px;
            cursor: pointer;
            appearance: none;
            -webkit-appearance: none;
            background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M3 4.5L6 8l3-3.5H3z'/%3E%3C/svg%3E");
            background-repeat: no-repeat;
            background-position: right 8px center;
            padding-right: 28px;
        }

        select:hover {
            border-color: var(--vscode-focusBorder);
        }

        select:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 0 0 1px var(--vscode-focusBorder);
        }

        select option {
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            padding: 6px;
        }

        .synthesizer-select {
            min-width: 130px;
        }

        .cli-model-select,
        .cli-model-input {
            flex: 1;
            max-width: 160px;
        }

        .cli-model-input {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 6px 10px;
            font-size: 11px;
        }

        .cli-model-input:hover {
            border-color: var(--vscode-focusBorder);
        }

        .cli-model-input:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 0 0 1px var(--vscode-focusBorder);
        }

        #debateArbiterSelect,
        #scopedWriterSelect {
            width: 100%;
        }

        /* API Key status indicators */
        .key-status {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            display: inline-block;
            margin-left: 6px;
            flex-shrink: 0;
            background: #6b7280;
            vertical-align: middle;
        }

        .key-status.configured {
            background: #22c55e;
            box-shadow: 0 0 6px rgba(34, 197, 94, 0.6);
        }

        .key-status.missing {
            background: #ef4444;
            box-shadow: 0 0 6px rgba(239, 68, 68, 0.6);
            animation: pulse-missing 2s infinite;
        }

        @keyframes pulse-missing {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        /* Confirmation Modal */
        .modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.6);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
            backdrop-filter: blur(2px);
        }

        .modal-dialog {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 8px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
            max-width: 400px;
            width: 90%;
            overflow: hidden;
        }

        .modal-header {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 14px 16px;
            border-bottom: 1px solid var(--vscode-widget-border);
            background: var(--vscode-titleBar-activeBackground);
        }

        .modal-icon {
            font-size: 20px;
            color: #f59e0b;
        }

        .modal-title {
            font-weight: 600;
            font-size: 13px;
            color: var(--vscode-foreground);
        }

        .modal-body {
            padding: 16px;
            font-size: 12px;
            line-height: 1.5;
            color: var(--vscode-foreground);
        }

        .modal-footer {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
            padding: 12px 16px;
            border-top: 1px solid var(--vscode-widget-border);
            background: var(--vscode-titleBar-activeBackground);
        }

        .btn-danger {
            background: #dc2626 !important;
            border-color: #dc2626 !important;
        }

        .btn-danger:hover {
            background: #b91c1c !important;
            border-color: #b91c1c !important;
        }

        /* Organization name display */
        .org-name {
            font-size: 10px;
            color: #22c55e;
            margin-left: 6px;
            font-style: italic;
            opacity: 0.9;
            display: none;
            max-width: 100px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            vertical-align: middle;
        }

        /* Power Mode styling */
        .model-name-text {
            transition: all 0.3s ease;
        }

        .model-name-text.power-mode {
            background: linear-gradient(135deg, #8b5cf6, #6366f1);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            font-weight: 600;
        }

        .toggle-item.no-key {
            opacity: 0.7;
        }

        .toggle-item.no-key .toggle-label {
            color: var(--vscode-errorForeground);
        }

        .key-hint {
            font-size: 9px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
            font-style: italic;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="header-top">
            <svg class="logo" viewBox="0 0 24 24" width="32" height="32">
                <circle cx="12" cy="12" r="5.5" fill="#1e293b"/>
                <path d="M9.5 10 L11.5 12 L9.5 14" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
                <line x1="12.5" y1="14" x2="14.5" y2="14" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round"/>
                <circle cx="12" cy="2.5" r="2.5" fill="#22c55e"/>
                <circle cx="4" cy="18" r="2.5" fill="#3b82f6"/>
                <circle cx="20" cy="18" r="2.5" fill="#f97316"/>
            </svg>
            <h2>AI Council</h2>
        </div>
        <div class="subtitle">Multi-Model Code Review</div>
    </div>

    <div class="section">
        <div class="collapsible-header" id="modelSelectionHeader" onclick="toggleModelSelection()">
            <span class="collapsible-title">&#9881; MODEL SELECTION</span>
            <span class="collapsible-arrow">&#9660;</span>
        </div>
        <div class="collapsible-content" id="modelSelectionContent">
            <div class="section-title" style="color: #22c55e;">&#10003; FREE MODELS</div>
            <div class="toggle-group">
                <div class="toggle-item" id="toggle-enableGemini">
                    <span class="toggle-label"><span class="model-name-text" data-standard="Gemini" data-power="Gemini Pro">Gemini</span> <span class="model-badge badge-free">Free</span><span class="key-status" id="key-google" title="API Key Status"></span></span>
                    <label class="toggle-switch gemini">
                        <input type="checkbox" id="enableGemini">
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <div class="toggle-item" style="opacity: 0.5;">
                    <span class="toggle-label">Groq/Llama <span class="model-badge badge-free">Free</span> <span class="model-badge badge-coming">#33</span></span>
                    <label class="toggle-switch llama">
                        <input type="checkbox" id="enableLlama" disabled>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <div class="toggle-item" id="toggle-enableOllama">
                    <span class="toggle-label"><span class="model-name-text" data-standard="Ollama" data-power="Ollama Pro">Ollama</span> <span class="model-badge badge-free">Self-hosted</span><span class="key-status" id="key-ollama" title="Ollama Server Status"></span></span>
                    <label class="toggle-switch ollama">
                        <input type="checkbox" id="enableOllama">
                        <span class="toggle-slider"></span>
                    </label>
                </div>
            </div>
            <div style="margin-top: 12px;">
                <div class="section-title" style="color: #f59e0b;">&#36; API SEATS (keys)</div>
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
                    </div>
                    <div class="toggle-item" style="opacity: 0.5;">
                        <span class="toggle-label">DeepSeek <span class="model-badge badge-coming">#31</span></span>
                        <label class="toggle-switch deepseek">
                            <input type="checkbox" id="enableDeepseek" disabled>
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                    <div class="cli-model-row" style="display:flex;flex-direction:column;gap:6px;margin:8px 0 4px 0;padding:8px;border:1px solid var(--vscode-widget-border);border-radius:6px;">
                        <div style="font-size:11px;opacity:0.85;">CLI models (subscription)</div>
                        <label style="display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;">
                            <span>Claude</span>
                            <select id="cliModelAnthropic" class="cli-model-select">
                                <option value="">Auto</option>
                                <option value="sonnet">sonnet</option>
                                <option value="opus">opus</option>
                                <option value="haiku">haiku</option>
                                <option value="fable">fable</option>
                            </select>
                        </label>
                        <label style="display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;">
                            <span>Codex</span>
                            <select id="cliModelOpenai" class="cli-model-select">
                                <option value="">Auto</option>
                                <option value="o3">o3</option>
                                <option value="o4-mini">o4-mini</option>
                                <option value="gpt-5.2">gpt-5.2</option>
                                <option value="gpt-5">gpt-5</option>
                            </select>
                        </label>
                        <label style="display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;">
                            <span>Grok</span>
                            <select id="cliModelXai" class="cli-model-select">
                                <option value="">Auto</option>
                                <option value="grok-4.6">grok-4.6</option>
                                <option value="grok-4.5">grok-4.5</option>
                            </select>
                        </label>
                        <div id="cliModelNote" style="font-size:10px;opacity:0.6;">Grok's list updates live from <code>grok models</code>. Custom models via VS Code settings.</div>
                    </div>
                    <div class="toggle-item" style="opacity: 0.5;">
                        <span class="toggle-label">Qwen <span class="model-badge badge-coming">#32</span></span>
                        <label class="toggle-switch qwen">
                            <input type="checkbox" id="enableQwen" disabled>
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                    <div class="toggle-item" style="opacity: 0.5;">
                        <span class="toggle-label">Cohere <span class="model-badge badge-coming">#34</span></span>
                        <label class="toggle-switch cohere">
                            <input type="checkbox" id="enableCohere" disabled>
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <div class="section options-section">
        <div class="section-title">&#9881; REVIEW OPTIONS</div>
        <div class="toggle-group">
            <div class="toggle-item power-mode-item" id="powerModeItem">
                <span class="toggle-label">&#9889; Power Mode</span>
                <label class="toggle-switch power">
                    <input type="checkbox" id="powerMode">
                    <span class="toggle-slider"></span>
                </label>
            </div>
            <div class="toggle-item synthesizer-item">
                <span class="toggle-label">&#9878; Council Verdict by</span>
                <select id="synthesizerSelect" class="synthesizer-select">
                    <option value="auto">Auto (Best Available)</option>
                    <option value="claude">Claude</option>
                    <option value="gpt-4">GPT-4</option>
                    <option value="gemini">Gemini</option>
                    <option value="grok">Grok</option>
                </select>
            </div>
            <div class="toggle-item synthesizer-item">
                <span class="toggle-label">&#128295; Fix Code with</span>
                <select id="fixerSelect" class="synthesizer-select">
                    <option value="claude">Claude</option>
                    <option value="gpt-4">GPT-4</option>
                    <option value="gemini">Gemini</option>
                    <option value="grok">Grok</option>
                </select>
            </div>
        </div>
    </div>

    <div class="section">
        <div class="section-title">Actions</div>
        <button class="btn btn-primary" onclick="runReview()">
            <span class="icon">&#128269;</span> Review Current File
        </button>
        <button class="btn btn-commit" onclick="reviewCommit()">
            <span class="icon">&#128230;</span> Review Current Commit
        </button>
        <button class="btn btn-scoped" onclick="toggleScopedReviewPanel()">
            <span class="icon">&#128172;</span> Review with Scope
        </button>
    </div>

    <div class="scoped-review-panel" id="scopedReviewPanel">
        <div id="scopedScopeInput">
            <div style="font-size:11px;opacity:0.85;margin-bottom:6px;">What should the council focus on?</div>
            <textarea id="scopedScopeText" placeholder="e.g. Review this based on how it handles concurrent access to the shared cache"></textarea>
            <button class="btn btn-primary" onclick="startScopedReview()">Start Scoped Review</button>
        </div>
        <div id="scopedRounds"></div>

        <!-- Pickers show on panel open (enabled seats); action buttons start disabled until setScopedSessionReady() confirms round 0 finished. -->
        <div id="debateStartRow" style="display:none;">
            <div id="debateArbiterRow" style="display:none;margin-top:8px;">
                <div style="font-size:11px;opacity:0.85;margin-bottom:4px;">Arbiter (rules on disputes instead of debating):</div>
                <select id="debateArbiterSelect"></select>
            </div>
            <button class="btn btn-scoped" onclick="startDebate()" id="startDebateBtn" disabled title="Run the initial scoped review first">&#9878; Debate Findings</button>
        </div>

        <div id="debateSection" style="display:none;">
            <div class="debate-consensus-row">
                <div class="debate-consensus-label">Consensus</div>
                <div class="debate-consensus-bar"><div class="debate-consensus-fill" id="debateConsensusFill"></div></div>
                <div class="debate-consensus-pct" id="debateConsensusPct">0%</div>
            </div>
            <div id="debateTokenUsage" class="debate-token-usage"></div>
            <div id="debateRoundsContainer"></div>
            <!-- Hidden until a debate round finishes - revealed in renderDebateRound(). -->
            <button class="btn btn-scoped" onclick="reconveneDebate()" id="reconveneBtn" style="display:none;">&#128260; Re-convene</button>
            <button class="btn btn-primary" onclick="runConsolidate()" id="consolidateBtn" style="display:none;">&#10003; Consolidate Final Review</button>
            <div id="consolidatedSection"></div>
        </div>

        <div class="scoped-finalize-row">
            <select id="scopedWriterSelect"></select>
            <button class="btn btn-primary" onclick="finalizeScopedReview()" id="finalizeScopedBtn" disabled title="Run the initial scoped review first">Create Review Doc</button>
        </div>

        <div id="scopedFollowup" style="display:none;">
            <div class="scoped-followup-row">
                <textarea id="scopedFollowupText" placeholder="Ask the council a follow-up..." style="min-height:40px;"></textarea>
            </div>
            <button class="btn btn-primary" onclick="submitScopedFollowup()">Ask Follow-up</button>
        </div>
        <div id="scopedStatus" style="font-size:11px;opacity:0.7;margin-top:8px;"></div>
    </div>

    <div class="divider"></div>

    <div class="section tools-section">
        <div class="tools-row">
            <button class="tool-btn" onclick="showStatus()" title="Check Status">&#9432; Status</button>
            <button class="tool-btn tool-btn-danger" id="clearCacheBtn" onclick="clearCache()" title="Clear Cache">&#128465; Cache<span id="cacheSizeLabel"></span></button>
            <button class="tool-btn" onclick="openSettings()" title="Settings">&#9881; Settings</button>
        </div>
    </div>

    <div class="status-bar" id="statusBar">
        Ready
    </div>

    <!-- Confirmation Modal -->
    <div class="modal-overlay" id="confirmModal" style="display: none;">
        <div class="modal-dialog">
            <div class="modal-header">
                <span class="modal-icon">&#9888;</span>
                <span class="modal-title" id="modalTitle">Confirm Action</span>
            </div>
            <div class="modal-body" id="modalBody">
                Are you sure?
            </div>
            <div class="modal-footer">
                <button class="btn btn-danger" id="modalConfirmBtn" onclick="modalConfirm()">Confirm</button>
                <button class="btn" onclick="modalCancel()">Cancel</button>
            </div>
        </div>
    </div>

    <div class="status-panel" id="statusPanel" style="display: none;">
        <div class="status-panel-header">
            <span>System Status</span>
            <button class="close-btn" onclick="closeStatusPanel()">&times;</button>
        </div>
        <div class="status-panel-content" id="statusPanelContent">
            <div class="status-row">
                <span class="status-label">Database:</span>
                <span class="status-value" id="statusDb">-</span>
            </div>
            <div class="status-row">
                <span class="status-label">Reviewers:</span>
                <span class="status-value" id="statusReviewers">-</span>
            </div>
            <div class="status-row">
                <span class="status-label">Pending:</span>
                <span class="status-value" id="statusPending">-</span>
            </div>
        </div>
    </div>

    <div class="review-panel" id="reviewPanel" style="display: none;">
        <div class="review-panel-header">
            <span class="review-panel-title">
                <span id="reviewPanelIcon">&#128269;</span>
                <span id="reviewPanelTitle">Reviewing...</span>
            </span>
            <button class="review-panel-close" onclick="closeReviewPanel()">&times;</button>
        </div>
        <div class="review-panel-content">
            <div class="review-file-name" id="reviewFileName">-</div>
            <div id="modelCardsContainer"></div>
            <button class="cancel-review-btn" id="cancelReviewBtn" onclick="cancelReview()">
                &#10006; Cancel Review
            </button>
            <div class="review-summary" id="reviewSummary" style="display: none;">
                <div class="summary-header">
                    <span class="summary-title">Consensus</span>
                    <span class="consensus-score" id="consensusScore">-</span>
                </div>
                <div class="summary-stats">
                    <span class="stat-item">Models: <span class="stat-value" id="statModels">0</span></span>
                    <span class="stat-item">Issues: <span class="stat-value" id="statIssues">0</span></span>
                    <span class="stat-item">Time: <span class="stat-value" id="statTime">0s</span></span>
                </div>
                <button class="open-report-btn" id="openReportBtn" onclick="openReport()">
                    &#128196; Open Full Report
                </button>
                <button class="fix-code-btn" id="fixCodeBtn" onclick="fixCode()">
                    &#128295; Fix with AI
                </button>
            </div>
        </div>
    </div>

    <div class="info-text">
        <span class="key-status configured" style="display: inline-block; vertical-align: middle;"></span> = Key configured &nbsp;
        <span class="key-status missing" style="display: inline-block; vertical-align: middle;"></span> = Key missing
    </div>

    <div class="info-text" style="margin-top: 4px;">
        Right-click files to review from Explorer
    </div>

    <div class="version-footer">v0.1.0</div>

    <script>
        const vscode = acquireVsCodeApi();

        // Model to API key mapping
        const modelApiKeys = {
            'enableGpt': { name: 'GPT-4 API', key: 'openai', url: 'https://platform.openai.com/api-keys', kind: 'api' },
            'enableClaude': { name: 'Claude API', key: 'anthropic', url: 'https://console.anthropic.com/', kind: 'api' },
            'enableGrok': { name: 'Grok API', key: 'xai', url: 'https://console.x.ai/', kind: 'api' },
            'enableGptCli': { name: 'Codex CLI', key: 'openai', url: '', kind: 'cli' },
            'enableClaudeCli': { name: 'Claude CLI', key: 'anthropic', url: '', kind: 'cli' },
            'enableGrokCli': { name: 'Grok CLI', key: 'xai', url: '', kind: 'cli' },
            'enableGemini': { name: 'Gemini', key: 'google', url: 'https://aistudio.google.com/app/apikey', free: true, kind: 'api' },
            'enableOllama': { name: 'Ollama', key: 'ollama', url: '', free: true, kind: 'api' }
        };

        // Save toggle states to persist across sessions
        function saveToggleStates() {
            const toggles = {
                enableGpt: document.getElementById('enableGpt')?.checked || false,
                enableClaude: document.getElementById('enableClaude')?.checked || false,
                enableGrok: document.getElementById('enableGrok')?.checked || false,
                enableGptCli: document.getElementById('enableGptCli')?.checked || false,
                enableClaudeCli: document.getElementById('enableClaudeCli')?.checked || false,
                enableGrokCli: document.getElementById('enableGrokCli')?.checked || false,
                enableGemini: document.getElementById('enableGemini')?.checked || false,
                enableOllama: document.getElementById('enableOllama')?.checked || false,
                powerMode: document.getElementById('powerMode')?.checked || false
            };
            vscode.postMessage({ command: 'saveToggles', toggles: toggles });
        }

        // Initialize immediately since script is at bottom of body (DOM is ready)
        (function init() {
            // Set up model toggle listeners
            Object.keys(modelApiKeys).forEach(id => {
                const toggle = document.getElementById(id);
                if (toggle) {
                    toggle.addEventListener('change', function() {
                        if (this.checked) {
                            vscode.postMessage({
                                command: 'checkApiKey',
                                modelId: id,
                                ...modelApiKeys[id]
                            });
                        }
                        saveToggleStates();
                        const scopedPanel = document.getElementById('scopedReviewPanel');
                        if (scopedPanel && scopedPanel.style.display === 'block') {
                            refreshScopedPickers();
                        }
                    });
                }
            });

            // CLI model selectors
            [
                ['cliModelAnthropic', 'anthropic'],
                ['cliModelOpenai', 'openai'],
                ['cliModelXai', 'xai']
            ].forEach(([id, provider]) => {
                const el = document.getElementById(id);
                if (el) {
                    el.addEventListener('change', function() {
                        vscode.postMessage({ command: 'saveCliModel', provider: provider, model: this.value });
                    });
                }
            });

            // Power Mode toggle listener - switch model names
            const powerModeToggle = document.getElementById('powerMode');
            if (powerModeToggle) {
                powerModeToggle.addEventListener('change', function() {
                    updateModelNames(this.checked);
                    saveToggleStates();
                });
            }

            // Tell extension we're ready to receive messages
            vscode.postMessage({ command: 'webviewReady' });
        })();

        function getModelConfig() {
            return {
                enableGpt: document.getElementById('enableGpt').checked,
                enableClaude: document.getElementById('enableClaude').checked,
                enableGrok: document.getElementById('enableGrok').checked,
                enableGptCli: document.getElementById('enableGptCli')?.checked || false,
                enableClaudeCli: document.getElementById('enableClaudeCli')?.checked || false,
                enableGrokCli: document.getElementById('enableGrokCli')?.checked || false,
                enableGemini: document.getElementById('enableGemini').checked,
                enableOllama: document.getElementById('enableOllama').checked,
                powerMode: document.getElementById('powerMode').checked,
                synthesizer: document.getElementById('synthesizerSelect').value
            };
        }

        function toggleModelSelection() {
            const header = document.getElementById('modelSelectionHeader');
            const content = document.getElementById('modelSelectionContent');
            if (header && content) {
                header.classList.toggle('collapsed');
                content.classList.toggle('collapsed');
            }
        }

        function runReview() {
            const config = getModelConfig();
            const enabledModels = [];
            if (config.enableGpt) enabledModels.push('GPT-API');
            if (config.enableClaude) enabledModels.push('Claude-API');
            if (config.enableGrok) enabledModels.push('Grok-API');
            if (config.enableGptCli) enabledModels.push('Codex-CLI');
            if (config.enableClaudeCli) enabledModels.push('Claude-CLI');
            if (config.enableGrokCli) enabledModels.push('Grok-CLI');
            if (config.enableGemini) enabledModels.push('Gemini');
            if (config.enableOllama) enabledModels.push('Ollama');

            if (enabledModels.length === 0) {
                updateStatus('Enable at least one model!', false);
                return;
            }

            vscode.postMessage({
                command: 'review',
                ...config
            });
        }

        function reviewCommit() {
            const config = getModelConfig();
            vscode.postMessage({
                command: 'reviewCommit',
                ...config
            });
        }

        function toggleScopedReviewPanel() {
            const panel = document.getElementById('scopedReviewPanel');
            const isOpen = panel.style.display === 'block';
            panel.style.display = isOpen ? 'none' : 'block';
            if (!isOpen) {
                refreshScopedPickers();
            }
        }

        function scoreClass(score) {
            if (score >= 7) return 'good';
            if (score >= 5) return 'medium';
            return 'low';
        }

        function escapeHtml(s) {
            const d = document.createElement('div');
            d.textContent = s == null ? '' : String(s);
            return d.innerHTML;
        }

        let scopedRoundCounter = 0;

        // Starts a new round: builds the SAME live model-card grid as "Review Current File"
        // (spinner -> checkmark/error -> score badge, updated in place as progress streams
        // in) instead of a static "Running council..." line with no feedback, and instead of
        // a bespoke inline issue-list summary. Full results live in the generated HTML report,
        // opened the same way "Review Current File" opens its report.
// Ticks every second so a still-"Analyzing..." card shows how long it's actually been running
// - the only way to tell "this is slow" from "this is stuck" without checking the dev console.
        const scopedRoundTimers = {};

        function startScopedRound(label, models) {
            scopedRoundCounter++;
            const roundId = 'scoped-round-' + scopedRoundCounter;
            const container = document.getElementById('scopedRounds');
            const div = document.createElement('div');
            div.className = 'scoped-round';
            div.id = roundId;

            let html = '<div class="scoped-round-title">' + escapeHtml(label) +
                ' <span class="scoped-round-elapsed" id="' + roundId + '-elapsed"></span></div>' +
                '<div class="scoped-round-cards" id="' + roundId + '-cards">';
            html += models.map(m => {
                const cfg = MODEL_DISPLAY[m] || { name: m, icon: '?', class: '' };
                return '<div class="model-card reviewing ' + cfg.class + '" id="' + roundId + '-card-' + m + '">' +
                    '<div class="model-card-left">' +
                        '<div class="model-icon ' + cfg.class + '">' + cfg.icon + '</div>' +
                        '<div class="model-info">' +
                            '<span class="model-name">' + escapeHtml(cfg.name) + '</span>' +
                            '<span class="model-status" id="' + roundId + '-status-' + m + '">Analyzing...</span>' +
                        '</div>' +
                    '</div>' +
                    '<div class="model-card-right">' +
                        '<div class="model-spinner" id="' + roundId + '-spinner-' + m + '"></div>' +
                        '<span class="score-badge" id="' + roundId + '-score-' + m + '" style="display:none;">-</span>' +
                    '</div>' +
                '</div>';
            }).join('');
            html += '</div><div id="' + roundId + '-summary"></div>';

            div.innerHTML = html;
            container.appendChild(div);

            const startTime = Date.now();
            const timerId = setInterval(() => {
                const elapsedEl = document.getElementById(roundId + '-elapsed');
                if (!elapsedEl) { clearInterval(timerId); delete scopedRoundTimers[roundId]; return; }
                const secs = Math.floor((Date.now() - startTime) / 1000);
                elapsedEl.textContent = '(' + secs + 's)';
                // Per-card elapsed, so a slow single seat is visible, not just the round overall.
                for (const m of models) {
                    const card = document.getElementById(roundId + '-card-' + m);
                    const status = document.getElementById(roundId + '-status-' + m);
                    if (card && status && card.classList.contains('reviewing')) {
                        status.textContent = 'Analyzing... (' + secs + 's)';
                    }
                }
            }, 1000);
            scopedRoundTimers[roundId] = timerId;

            return roundId;
        }

        function stopScopedRoundTimer(roundId) {
            if (scopedRoundTimers[roundId]) {
                clearInterval(scopedRoundTimers[roundId]);
                delete scopedRoundTimers[roundId];
            }
            const elapsedEl = document.getElementById(roundId + '-elapsed');
            if (elapsedEl) { elapsedEl.textContent = ''; }
        }

        function updateScopedRoundProgress(roundId, model, data) {
            const card = document.getElementById(roundId + '-card-' + model);
            const status = document.getElementById(roundId + '-status-' + model);
            const spinner = document.getElementById(roundId + '-spinner-' + model);
            const scoreBadge = document.getElementById(roundId + '-score-' + model);
            if (!card) return;

            card.classList.remove('reviewing');
            if (data.error) {
                card.classList.add('error');
                if (status) status.textContent = 'Error';
                if (spinner) spinner.outerHTML = '<div class="error-x">!</div>';
            } else {
                card.classList.add('complete');
                if (status) status.textContent = data.issues + ' issue' + (data.issues === 1 ? '' : 's') + ' found';
                if (spinner) spinner.outerHTML = '<div class="checkmark"></div>';
                if (scoreBadge) {
                    const score = data.score || 0;
                    scoreBadge.textContent = score + '/10';
                    scoreBadge.className = 'score-badge ' + scoreClass(score);
                    scoreBadge.style.display = 'inline-block';
                }
            }
        }

        // Backfills any card still showing "Analyzing..." from the final result data - a card
        // can be stuck if its live "[+] MODEL Score:..." stdout line was never matched (e.g.
        // served from cache, a slow/cut-off write, or a regex miss) even though the round
        // genuinely finished and the real per-model result exists in reviews.
        function reconcileScopedRoundCards(roundId, reviews) {
            for (const [model, review] of Object.entries(reviews || {})) {
                const card = document.getElementById(roundId + '-card-' + model);
                if (!card || !card.classList.contains('reviewing')) { continue; }
                if (review.error) {
                    updateScopedRoundProgress(roundId, model, { error: true });
                } else {
                    updateScopedRoundProgress(roundId, model, { score: review.quality_score || 0, issues: (review.issues || []).length });
                }
            }
        }

        function finishScopedRound(roundId, consensus, reportPath, reviews) {
            stopScopedRoundTimer(roundId);
            reconcileScopedRoundCards(roundId, reviews);
            const summary = document.getElementById(roundId + '-summary');
            if (!summary) return;
            const avgScore = (consensus.average_score ?? 0).toFixed(1);
            let html = '<div class="review-summary" style="display:block;">' +
                '<div class="summary-header">' +
                    '<span class="summary-title">Round Consensus</span>' +
                    '<span class="consensus-score score-badge ' + scoreClass(consensus.average_score ?? 0) + '">' + avgScore + '/10</span>' +
                '</div>' +
                '<div class="summary-stats">' +
                    '<span class="stat-item">Agreed: <span class="stat-value">' + (consensus.consensus_issues || []).length + '</span></span>' +
                    '<span class="stat-item">Unique: <span class="stat-value">' + (consensus.unique_insights || []).length + '</span></span>' +
                '</div>';
            if (reportPath) {
                // No inline onclick with embedded data here - a Windows path routinely
                // contains characters (quotes if ever present, and JSON.stringify's own
                // escaping) that can terminate the onclick="..." attribute early and leave
                // the browser trying to parse the leftover text as script, which is exactly
                // what broke this button ("Unexpected end of input"). Wire the handler via
                // addEventListener with reportPath captured in a closure instead.
                html += '<button class="open-report-btn" id="' + roundId + '-open-report">&#128196; Open Full Report</button>';
            }
            html += '</div>';
            summary.innerHTML = html;

            if (reportPath) {
                const btn = document.getElementById(roundId + '-open-report');
                if (btn) {
                    btn.addEventListener('click', () => openScopedReport(reportPath));
                }
            }
        }

        function openScopedReport(reportPath) {
            vscode.postMessage({ command: 'openReport', path: reportPath });
        }

        function setScopedStatus(text) {
            document.getElementById('scopedStatus').textContent = text || '';
        }

        // Enabled seats straight from the toggle checkboxes (Model Selection panel) - the
        // arbiter and doc-writer pickers inside Review with Scope must reflect this the
        // instant the panel opens, not wait for a round to run and report back which seats
        // "worked." A seat toggled on but not yet exercised is still a valid pick here.
        function getEnabledSeats() {
            const config = getModelConfig();
            const seats = [];
            if (config.enableGpt) seats.push('gpt-4');
            if (config.enableClaude) seats.push('claude');
            if (config.enableGrok) seats.push('grok');
            if (config.enableGptCli) seats.push('gpt-cli');
            if (config.enableClaudeCli) seats.push('claude-cli');
            if (config.enableGrokCli) seats.push('grok-cli');
            if (config.enableGemini) seats.push('gemini');
            if (config.enableOllama) seats.push('ollama');
            return seats;
        }

        function populateScopedWriterOptions() {
            const sel = document.getElementById('scopedWriterSelect');
            if (!sel) return;
            const enabledSeats = getEnabledSeats();
            const previousValue = sel.value;

            sel.innerHTML = enabledSeats.map(m => {
                const cfg = MODEL_DISPLAY[m] || { name: m };
                return '<option value="' + m + '">' + escapeHtml(cfg.name) + '</option>';
            }).join('');

            if (enabledSeats.includes(previousValue)) {
                sel.value = previousValue;
            }
        }

        // Debate requires 3+ enabled seats (see run_debate_round in ai_council.py). 4+ seats
        // unlocks arbiter mode (one seat rules on disputes instead of debating); with exactly
        // 3, all_to_all is the only option since there's no spare seat for an arbiter.
        function setupDebateSection() {
            const enabledSeats = getEnabledSeats();
            const startRow = document.getElementById('debateStartRow');
            const arbiterRow = document.getElementById('debateArbiterRow');
            if (!startRow || !arbiterRow) return;

            if (enabledSeats.length < 3) {
                startRow.style.display = 'none';
                return;
            }
            startRow.style.display = 'block';

            if (enabledSeats.length >= 4) {
                arbiterRow.style.display = 'block';
                const sel = document.getElementById('debateArbiterSelect');
                const previousValue = sel.value;
                sel.innerHTML = enabledSeats.map(m => {
                    const cfg = MODEL_DISPLAY[m] || { name: m };
                    return '<option value="' + m + '">' + escapeHtml(cfg.name) + '</option>';
                }).join('');
                if (enabledSeats.includes(previousValue)) { sel.value = previousValue; }
            } else {
                arbiterRow.style.display = 'none';
            }
        }

        // Refreshes both pickers - called when the Review with Scope panel opens and on
        // every seat toggle change while it may be open, so it never shows a stale seat list.
        function refreshScopedPickers() {
            populateScopedWriterOptions();
            setupDebateSection();
        }

        // Disabled for the duration of the async call so a second click can't race the same session/cache row.
        function setDebateButtonsDisabled(disabled) {
            for (const id of ['startDebateBtn', 'reconveneBtn', 'consolidateBtn']) {
                const btn = document.getElementById(id);
                if (btn) { btn.disabled = disabled; }
            }
        }

        // Enabled only once a real session exists; called with false again when a new scoped review starts.
        function setScopedSessionReady(ready) {
            const startDebateBtn = document.getElementById('startDebateBtn');
            const finalizeBtn = document.getElementById('finalizeScopedBtn');
            if (startDebateBtn) {
                startDebateBtn.disabled = !ready;
                startDebateBtn.title = ready ? '' : 'Run the initial scoped review first';
            }
            if (finalizeBtn) {
                finalizeBtn.disabled = !ready;
                finalizeBtn.title = ready ? '' : 'Run the initial scoped review first';
            }
        }

        // Ticks elapsed seconds onto the status text so a long single call (e.g. Ollama's 180s timeout) doesn't read as a hang.
        let debateProgressTimer = null;
        let debateProgressBaseLabel = '';
        let debateProgressStartMs = 0;

        function startDebateProgress(label) {
            stopDebateProgressTimer();
            debateProgressBaseLabel = label;
            debateProgressStartMs = Date.now();
            setScopedStatus(label + ' (0s)');
            setDebateButtonsDisabled(true);
            debateProgressTimer = setInterval(() => {
                const el = document.getElementById('scopedStatus');
                if (!el) { stopDebateProgressTimer(); return; }
                const elapsed = Math.floor((Date.now() - debateProgressStartMs) / 1000);
                setScopedStatus(debateProgressBaseLabel + ' (' + elapsed + 's)');
            }, 1000);
        }

        function updateDebateProgressLabel(label) {
            debateProgressBaseLabel = label;
            const elapsed = Math.floor((Date.now() - debateProgressStartMs) / 1000);
            setScopedStatus(label + ' (' + elapsed + 's)');
        }

        function stopDebateProgressTimer() {
            if (debateProgressTimer) {
                clearInterval(debateProgressTimer);
                debateProgressTimer = null;
            }
        }

        // Ollama can take up to its 180s timeout to fail - warn up front so a long wait reads as known, not hung.
        function debateStartLabel(arbiter) {
            return arbiter === 'ollama'
                ? 'Debate round starting... (Ollama is arbiter - can take up to 3 min if slow)'
                : 'Debate round starting...';
        }

        function startDebate() {
            if (!currentScopedSessionId) {
                setScopedStatus('Run the initial scoped review first.');
                return;
            }
            const enabledSeats = getEnabledSeats();
            const arbiter = enabledSeats.length >= 4 ? document.getElementById('debateArbiterSelect').value : null;
            const config = getModelConfig();
            resetScopedTokenUsage();
            startDebateProgress(debateStartLabel(arbiter));
            document.getElementById('debateSection').style.display = 'block';
            document.getElementById('debateRoundsContainer').innerHTML = '';
            document.getElementById('consolidatedSection').innerHTML = '';
            vscode.postMessage({ command: 'runDebate', sessionId: currentScopedSessionId, arbiter: arbiter, modelConfig: config });
        }

        function reconveneDebate() {
            if (!currentScopedSessionId) {
                setScopedStatus('Run the initial scoped review first.');
                return;
            }
            const enabledSeats = getEnabledSeats();
            const arbiter = enabledSeats.length >= 4 ? document.getElementById('debateArbiterSelect').value : null;
            const config = getModelConfig();
            startDebateProgress(debateStartLabel(arbiter));
            vscode.postMessage({ command: 'runDebate', sessionId: currentScopedSessionId, arbiter: arbiter, modelConfig: config });
        }

        function runConsolidate() {
            if (!currentScopedSessionId) {
                setScopedStatus('Run the initial scoped review first.');
                return;
            }
            const config = getModelConfig();
            startDebateProgress('Consolidating...');
            vscode.postMessage({ command: 'runConsolidate', sessionId: currentScopedSessionId, modelConfig: config });
        }

        // Running total across debate+consolidate; only startDebate() (round 1) resets it, so consolidation can't erase it.
        let scopedTokenUsageTotals = {};

        function resetScopedTokenUsage() {
            scopedTokenUsageTotals = {};
            const el = document.getElementById('debateTokenUsage');
            if (el) { el.innerHTML = ''; }
        }

        function renderTokenUsage(tokenUsage) {
            const el = document.getElementById('debateTokenUsage');
            if (!el || !tokenUsage) { return; }
            for (const [model, u] of Object.entries(tokenUsage)) {
                const existing = scopedTokenUsageTotals[model];
                const unknown = u.input_tokens == null || u.output_tokens == null || u.partial;
                if (unknown) {
                    // Sticky: once "not reported," a later real number doesn't erase that gap.
                    scopedTokenUsageTotals[model] = { unknown: true };
                } else if (existing && !existing.unknown) {
                    scopedTokenUsageTotals[model] = {
                        input_tokens: existing.input_tokens + u.input_tokens,
                        output_tokens: existing.output_tokens + u.output_tokens,
                    };
                } else if (!existing) {
                    scopedTokenUsageTotals[model] = { input_tokens: u.input_tokens, output_tokens: u.output_tokens };
                }
                // else: existing is already marked unknown - leave it, per the stickiness above.
            }
            el.innerHTML = Object.entries(scopedTokenUsageTotals).map(([model, u]) => {
                const cfg = MODEL_DISPLAY[model] || { name: model };
                // Some seats (self-hosted Ollama in particular) don't report usage at all -
                // show that honestly instead of a fabricated "0 in / 0 out" that reads as a
                // real, confirmed measurement rather than an absence.
                const text = u.unknown
                    ? 'usage not reported'
                    : u.input_tokens + ' in / ' + u.output_tokens + ' out';
                return '<span>' + escapeHtml(cfg.name) + ': ' + text + '</span>';
            }).join('');
        }

        function renderDebateRound(result) {
            const container = document.getElementById('debateRoundsContainer');
            const div = document.createElement('div');
            div.className = 'debate-round';

            const modeLabel = result.mode === 'arbiter' ? 'Arbiter (' + escapeHtml(result.arbiter || '') + ')' : 'All-to-all';
            let html = '<div class="debate-round-header">Round ' + result.debate_round_num + ' - ' + modeLabel + '</div>';

            const arbiterRulings = (result.positions || {})._arbiter_ruling || {};

            for (const c of result.clusters || []) {
                html += '<div class="debate-cluster">';
                html += '<div class="debate-cluster-summary">' + escapeHtml(c.summary) + '</div>';
                html += '<div class="debate-cluster-members">Raised by: ' + c.members.map(m => escapeHtml(m.model)).join(', ') + '</div>';

                for (const [model, positions] of Object.entries(result.positions || {})) {
                    if (model === '_arbiter_ruling' || positions.error) { continue; }
                    const pos = positions[c.cluster_id];
                    if (!pos) { continue; }
                    html += '<div class="debate-position ' + escapeHtml(pos.stance || '') + '">' +
                        '<span class="debate-position-model">' + escapeHtml(model) + '</span>' +
                        escapeHtml(pos.stance || '') + ' - ' + escapeHtml(pos.reasoning || '') +
                        '</div>';
                }

                const ruling = arbiterRulings[c.cluster_id];
                if (ruling) {
                    html += '<div class="debate-ruling">ARBITER: ' + escapeHtml(ruling.verdict || '') + ' (' + escapeHtml(ruling.final_severity || '') + ') - ' + escapeHtml(ruling.reasoning || '') + '</div>';
                }
                html += '</div>';
            }

            div.innerHTML = html;
            container.appendChild(div);

            const fill = document.getElementById('debateConsensusFill');
            const pctLabel = document.getElementById('debateConsensusPct');
            if (fill) { fill.style.width = result.consensus_pct + '%'; }
            if (pctLabel) { pctLabel.textContent = result.consensus_pct + '%'; }

            renderTokenUsage(result.token_usage);

            // A round now exists, so reveal the buttons startDebate() left hidden.
            const reconveneBtn = document.getElementById('reconveneBtn');
            const consolidateBtn = document.getElementById('consolidateBtn');
            if (reconveneBtn) { reconveneBtn.style.display = 'inline-block'; }
            if (consolidateBtn) { consolidateBtn.style.display = 'inline-block'; }
        }

        function renderConsolidated(result) {
            const el = document.getElementById('consolidatedSection');
            let html = '<div class="review-summary" style="display:block;margin-top:10px;">' +
                '<div class="summary-header"><span class="summary-title">Final Consolidated Review</span></div>' +
                '<div style="font-size:12px;margin:8px 0;">' + escapeHtml(result.summary || '') + '</div>';
            html += '</div>';

            for (const f of result.findings || []) {
                html += '<div class="consolidated-finding">' +
                    '<span class="consolidated-finding-severity">[' + escapeHtml(f.severity || '?') + ']</span>' +
                    escapeHtml(f.description || '') +
                    '<div style="margin-top:4px;opacity:0.85;">&#128161; ' + escapeHtml(f.fix || '') + '</div>' +
                    '</div>';
            }

            if ((result.open_questions || []).length > 0) {
                html += '<div style="font-size:11px;font-weight:600;margin:10px 0 4px 0;opacity:0.8;">OPEN QUESTIONS</div>';
                for (const q of result.open_questions) {
                    html += '<div class="consolidated-open-question">' +
                        '<div>' + escapeHtml(q.question || '') + '</div>' +
                        '<div style="margin-top:4px;opacity:0.8;font-size:10px;">' + escapeHtml(q.why_unresolved || '') + '</div>' +
                        '</div>';
                }
            }

            renderTokenUsage(result.usage);
            el.innerHTML = html;
        }

        function startScopedReview() {
            const scope = document.getElementById('scopedScopeText').value.trim();
            if (!scope) {
                setScopedStatus('Enter a scope/request first.');
                return;
            }
            const config = getModelConfig();
            document.getElementById('scopedScopeInput').style.display = 'none';
            document.getElementById('scopedRounds').innerHTML = '';
            setScopedStatus('');
            currentScopedSessionId = null;
            setScopedSessionReady(false);
            vscode.postMessage({ command: 'scopedReview', scope: scope, modelConfig: config });
        }

        function submitScopedFollowup() {
            if (!currentScopedSessionId) {
                setScopedStatus('Run the initial scoped review first.');
                return;
            }
            const question = document.getElementById('scopedFollowupText').value.trim();
            if (!question) {
                setScopedStatus('Enter a follow-up question first.');
                return;
            }
            const btn = document.querySelector('#scopedFollowup button.btn-primary');
            if (btn && btn.disabled) { return; } // already in flight - no double-submit
            if (btn) { btn.disabled = true; }
            const config = getModelConfig();
            setScopedStatus('Asking follow-up...');
            vscode.postMessage({ command: 'scopedFollowup', sessionId: currentScopedSessionId, question: question, modelConfig: config });
        }

        function finalizeScopedReview() {
            if (!currentScopedSessionId) {
                setScopedStatus('Run the initial scoped review first.');
                return;
            }
            const finalizeBtn = document.getElementById('finalizeScopedBtn');
            if (finalizeBtn && finalizeBtn.disabled) { return; } // already in flight - no double-submit
            if (finalizeBtn) { finalizeBtn.disabled = true; }
            const writer = document.getElementById('scopedWriterSelect').value;
            const config = getModelConfig();
            setScopedStatus('Writing review doc...');
            vscode.postMessage({ command: 'scopedFinalize', sessionId: currentScopedSessionId, writer: writer, modelConfig: config });
        }

        let modalCallback = null;

        function showConfirmModal(title, body, confirmText, onConfirm) {
            document.getElementById('modalTitle').textContent = title;
            document.getElementById('modalBody').textContent = body;
            document.getElementById('modalConfirmBtn').textContent = confirmText;
            modalCallback = onConfirm;
            document.getElementById('confirmModal').style.display = 'flex';
        }

        function modalConfirm() {
            document.getElementById('confirmModal').style.display = 'none';
            if (modalCallback) modalCallback();
            modalCallback = null;
        }

        function modalCancel() {
            document.getElementById('confirmModal').style.display = 'none';
            modalCallback = null;
        }

        function clearCache() {
            showConfirmModal(
                'Clear AI Council Data',
                'This deletes ALL AI Council data for this workspace: the review cache, every Review with Scope session, and any debate/consolidation results not yet exported to a doc. This cannot be undone.',
                'Delete Everything',
                function() {
                    vscode.postMessage({ command: 'clearCacheConfirmed' });
                }
            );
        }

        function showStatus() {
            // Show panel and request status with current toggle states
            document.getElementById('statusPanel').style.display = 'block';
            document.getElementById('statusPanelContent').innerHTML = '<div style="text-align:center;color:var(--vscode-descriptionForeground);font-style:italic;">Loading...</div>';
            const toggles = {
                gpt: document.getElementById('enableGpt')?.checked || false,
                claude: document.getElementById('enableClaude')?.checked || false,
                grok: document.getElementById('enableGrok')?.checked || false,
                gptCli: document.getElementById('enableGptCli')?.checked || false,
                claudeCli: document.getElementById('enableClaudeCli')?.checked || false,
                grokCli: document.getElementById('enableGrokCli')?.checked || false,
                gemini: document.getElementById('enableGemini')?.checked || false,
                ollama: document.getElementById('enableOllama')?.checked || false
            };
            console.log('AI Council Webview: showStatus toggles =', toggles);
            vscode.postMessage({
                command: 'showStatus',
                toggles: toggles
            });
        }

        function closeStatusPanel() {
            document.getElementById('statusPanel').style.display = 'none';
        }

        function updateStatusPanel(status) {
            document.getElementById('statusDb').textContent = status.database || '-';
            document.getElementById('statusDb').title = status.database || '';
            document.getElementById('statusReviewers').textContent = status.reviewers || 'None';
            document.getElementById('statusPending').textContent = status.pending || '0';
        }

        function openSettings() {
            vscode.postMessage({ command: 'openSettings' });
        }

        // Review Panel State
        let currentReportPath = '';
        let reviewStartTime = 0;
        let savedCliModels = null;
        let currentScopedSessionId = null;
        let currentScopedRoundId = null;

        function closeReviewPanel() {
            document.getElementById('reviewPanel').style.display = 'none';
        }

        function openReport() {
            if (currentReportPath) {
                vscode.postMessage({ command: 'openReport', path: currentReportPath });
            }
        }

        function fixCode() {
            const fixBtn = document.getElementById('fixCodeBtn');
            if (fixBtn) {
                fixBtn.disabled = true;
                fixBtn.innerHTML = '&#9881; Fixing...';
            }
            const fixer = document.getElementById('fixerSelect').value;
            vscode.postMessage({ command: 'fixCode', fixer: fixer, reportPath: currentReportPath, modelConfig: getModelConfig() });
        }

        function cancelReview() {
            vscode.postMessage({ command: 'cancelReview' });
        }

        // Shared model display metadata - single source of truth for name/icon/class across
        // the review panel's cards and the scoped-review UI (writer picker, round rendering).
        const MODEL_DISPLAY = {
            'gpt-4': { name: 'GPT-4 API', icon: 'G', class: 'gpt' },
            'claude': { name: 'Claude API', icon: 'C', class: 'claude' },
            'grok': { name: 'Grok API', icon: 'X', class: 'grok' },
            'gpt-cli': { name: 'Codex CLI', icon: 'G', class: 'gpt' },
            'claude-cli': { name: 'Claude CLI', icon: 'C', class: 'claude' },
            'grok-cli': { name: 'Grok CLI', icon: 'X', class: 'grok' },
            'gemini': { name: 'Gemini', icon: 'G', class: 'gemini' },
            'ollama': { name: 'Ollama', icon: 'O', class: 'ollama' }
        };

        function startReviewPanel(fileName, models) {
            console.log('AI Council: startReviewPanel called', fileName, models);
            reviewStartTime = Date.now();
            const panel = document.getElementById('reviewPanel');
            const container = document.getElementById('modelCardsContainer');
            const summary = document.getElementById('reviewSummary');
            const cancelBtn = document.getElementById('cancelReviewBtn');

            if (!panel) {
                console.error('AI Council: reviewPanel not found!');
                return;
            }

            // Reset
            document.getElementById('reviewPanelIcon').innerHTML = '&#128269;';
            document.getElementById('reviewPanelTitle').textContent = 'Reviewing with ' + models.length + ' model' + (models.length > 1 ? 's' : '') + '...';
            document.getElementById('reviewFileName').textContent = fileName;
            summary.style.display = 'none';
            if (cancelBtn) cancelBtn.style.display = 'flex';
            currentReportPath = '';

            const modelConfig = MODEL_DISPLAY;
            container.innerHTML = models.map(m => {
                const cfg = modelConfig[m] || { name: m, icon: '?', class: '' };
                return '<div class="model-card reviewing ' + cfg.class + '" id="card-' + m + '">' +
                    '<div class="model-card-left">' +
                        '<div class="model-icon ' + cfg.class + '">' + cfg.icon + '</div>' +
                        '<div class="model-info">' +
                            '<span class="model-name">' + cfg.name + '</span>' +
                            '<span class="model-status" id="status-' + m + '">Analyzing...</span>' +
                        '</div>' +
                    '</div>' +
                    '<div class="model-card-right">' +
                        '<div class="model-spinner" id="spinner-' + m + '"></div>' +
                        '<span class="score-badge" id="score-' + m + '" style="display:none;">-</span>' +
                    '</div>' +
                '</div>';
            }).join('');

            panel.style.display = 'block';
        }

        function updateModelProgress(model, data) {
            const card = document.getElementById('card-' + model);
            const status = document.getElementById('status-' + model);
            const spinner = document.getElementById('spinner-' + model);
            const scoreBadge = document.getElementById('score-' + model);

            if (!card) return;

            card.classList.remove('reviewing');

            if (data.error) {
                card.classList.add('error');
                status.textContent = 'Error';
                spinner.outerHTML = '<div class="error-x">!</div>';
            } else {
                card.classList.add('complete');
                status.textContent = data.issues + ' issues found';
                spinner.outerHTML = '<div class="checkmark"></div>';

                // Show score
                const score = data.score || 0;
                const scoreClass = score >= 7 ? 'good' : (score >= 5 ? 'medium' : 'low');
                scoreBadge.textContent = score + '/10';
                scoreBadge.className = 'score-badge ' + scoreClass;
                scoreBadge.style.display = 'inline-block';
            }
        }

        function showReviewSummary(results) {
            const elapsed = ((Date.now() - reviewStartTime) / 1000).toFixed(1);
            const summary = document.getElementById('reviewSummary');
            const cancelBtn = document.getElementById('cancelReviewBtn');

            document.getElementById('reviewPanelIcon').innerHTML = '&#10003;';
            document.getElementById('reviewPanelTitle').textContent = 'Review Complete';
            if (cancelBtn) cancelBtn.style.display = 'none';

            // Calculate consensus
            let totalScore = 0;
            let totalIssues = 0;
            let modelCount = 0;

            // First, mark any remaining "reviewing" cards as unknown/cached
            const reviewingCards = document.querySelectorAll('.model-card.reviewing');
            reviewingCards.forEach(card => {
                const modelId = card.id.replace('card-', '');
                // If this model is in results, skip (will be handled below)
                if (results && results[modelId]) return;

                card.classList.remove('reviewing');
                card.classList.add('complete');
                const spinner = card.querySelector('.model-spinner');
                const status = card.querySelector('.model-status');
                if (spinner) spinner.classList.add('stopped');
                if (status) {
                    status.textContent = 'Cached';
                    status.style.color = '#94a3b8';
                }
            });

            for (const [model, data] of Object.entries(results)) {
                // Update individual model card
                const card = document.getElementById('card-' + model);
                const status = document.getElementById('status-' + model);
                if (card) {
                    card.classList.remove('reviewing');
                    card.classList.add(data.error ? 'error' : 'complete');
                    // Stop animations
                    const spinner = card.querySelector('.model-spinner');
                    const scoreRing = card.querySelector('.model-score-ring');
                    if (spinner) spinner.classList.add('stopped');
                    if (scoreRing) scoreRing.classList.add('stopped');
                }
                if (status) {
                    if (data.error) {
                        status.textContent = 'Error';
                        status.style.color = '#ef4444';
                    } else {
                        status.textContent = (data.score || 0) + '/10';
                        status.style.color = data.score >= 7 ? '#22c55e' : (data.score >= 5 ? '#f59e0b' : '#ef4444');
                    }
                }

                if (!data.error) {
                    totalScore += data.score || 0;
                    totalIssues += data.issues || 0;
                    modelCount++;
                }
            }

            const avgScore = modelCount > 0 ? (totalScore / modelCount).toFixed(1) : 0;
            const scoreClass = avgScore >= 7 ? 'good' : (avgScore >= 5 ? 'medium' : 'low');

            document.getElementById('consensusScore').textContent = avgScore + '/10';
            document.getElementById('consensusScore').className = 'consensus-score score-badge ' + scoreClass;
            document.getElementById('statModels').textContent = modelCount;
            document.getElementById('statIssues').textContent = totalIssues;
            document.getElementById('statTime').textContent = elapsed + 's';

            // Hide action buttons if no successful models
            const reportBtn = document.getElementById('openReportBtn');
            const fixBtn = document.getElementById('fixCodeBtn');
            if (modelCount === 0) {
                if (reportBtn) reportBtn.style.display = 'none';
                if (fixBtn) fixBtn.style.display = 'none';
            } else {
                if (reportBtn) reportBtn.style.display = 'block';
                if (fixBtn) fixBtn.style.display = 'block';
            }

            summary.style.display = 'block';
        }

        let statusTimeout = null;
        function updateStatus(text, isLoading) {
            const statusBar = document.getElementById('statusBar');
            statusBar.textContent = text;
            statusBar.classList.toggle('loading', isLoading);

            // Clear any existing timeout
            if (statusTimeout) {
                clearTimeout(statusTimeout);
                statusTimeout = null;
            }

            // Auto-clear non-loading status messages after 3 seconds
            if (text && !isLoading) {
                statusTimeout = setTimeout(() => {
                    statusBar.textContent = '';
                    statusTimeout = null;
                }, 3000);
            }
        }

        function updateResults(results) {
            // Legacy function - now handled by review panel
            const section = document.getElementById('resultsSection');
            const container = document.getElementById('resultsContainer');

            if (results && results.reviews && results.reviews.length > 0) {
                section.style.display = 'block';
                container.innerHTML = results.reviews.map(r => {
                    const scoreClass = r.score >= 7 ? '' : (r.score >= 5 ? 'medium' : 'low');
                    return \`
                        <div class="result-card">
                            <div class="result-header">
                                <span class="model-name">\${r.model}</span>
                                <span class="score \${scoreClass}">\${r.score}/10</span>
                            </div>
                        </div>
                    \`;
                }).join('');
            }
        }

        // Model ID to API key mapping
        const modelToKey = {
            'enableGpt': 'openai',
            'enableClaude': 'anthropic',
            'enableGrok': 'xai',
            'enableGptCli': 'openai-cli',
            'enableClaudeCli': 'anthropic-cli',
            'enableGrokCli': 'xai-cli',
            'enableGemini': 'google',
            'enableOllama': 'ollama'
        };

        function updateKeyStatus(status, orgInfo) {
            console.log('AI Council Webview: Updating key status', status, 'org info', orgInfo);
            // Update each key indicator
            Object.entries(status).forEach(([key, hasKey]) => {
                const indicator = document.getElementById('key-' + key);
                const orgSpan = document.getElementById('org-' + key);
                console.log('AI Council Webview: Key', key, 'indicator', indicator, 'hasKey', hasKey);
                if (indicator) {
                    indicator.classList.remove('configured', 'missing');
                    indicator.classList.add(hasKey ? 'configured' : 'missing');

                    // Show org name if available
                    const org = orgInfo && orgInfo[key];
                    const isCli = String(key).endsWith('-cli');
                    if (org && orgSpan) {
                        orgSpan.textContent = org;
                        orgSpan.style.display = 'inline';
                        indicator.title = 'API Key Configured - ' + org;
                    } else if (orgSpan) {
                        orgSpan.style.display = 'none';
                        indicator.title = hasKey
                            ? (isCli ? 'CLI ready (subscription)' : 'API Key Configured')
                            : (isCli ? 'CLI missing on PATH' : 'API Key Missing - Click toggle to configure');
                    } else {
                        indicator.title = hasKey
                            ? (isCli ? 'CLI ready (subscription)' : 'API Key Configured')
                            : (isCli ? 'CLI missing on PATH' : 'API Key Missing - Click toggle to configure');
                    }
                }
            });

            // Update toggle item styling and uncheck models without keys
            Object.entries(modelToKey).forEach(([modelId, key]) => {
                const toggleItem = document.getElementById('toggle-' + modelId);
                const checkbox = document.getElementById(modelId);
                const hasKey = status[key];

                if (toggleItem) {
                    toggleItem.classList.toggle('no-key', !hasKey);
                }

                // If model is checked but has no key, uncheck it
                if (checkbox && checkbox.checked && !hasKey) {
                    checkbox.checked = false;
                }
            });
        }

        // Power Mode: Switch model names between standard and power versions
        function updateModelNames(isPowerMode) {
            console.log('AI Council: updateModelNames called, isPowerMode:', isPowerMode);

            // Toggle active class on power mode container
            const powerModeItem = document.getElementById('powerModeItem');
            if (powerModeItem) {
                powerModeItem.classList.toggle('active', isPowerMode);
            }

            // Update model name labels
            const nameElements = document.querySelectorAll('.model-name-text');
            console.log('AI Council: Found', nameElements.length, 'model-name-text elements');

            nameElements.forEach(el => {
                const standardName = el.getAttribute('data-standard');
                const powerName = el.getAttribute('data-power');
                console.log('AI Council: Switching', standardName, '->', isPowerMode ? powerName : standardName);
                el.textContent = isPowerMode ? powerName : standardName;
                el.classList.toggle('power-mode', isPowerMode);
            });

            // Update status to show mode change
            updateStatus(isPowerMode ? '⚡ Power Mode - Premium models active' : 'Ready', false);
        }

        // Listen for messages from the extension
        window.addEventListener('message', event => {
            const message = event.data;
            console.log('AI Council Webview: Received message', message);
            switch (message.type) {
                case 'statusUpdate':
                    updateStatus(message.status, message.isLoading);
                    break;
                case 'resultsUpdate':
                    updateResults(message.results);
                    updateStatus('Review complete', false);
                    break;
                case 'apiKeyStatus':
                    updateKeyStatus(message.status, message.orgInfo);
                    if (message.cliModels) {
                        savedCliModels = message.cliModels;
                        const map = {
                            cliModelOpenai: message.cliModels.openai,
                            cliModelAnthropic: message.cliModels.anthropic,
                            cliModelXai: message.cliModels.xai
                        };
                        Object.entries(map).forEach(([id, val]) => {
                            const el = document.getElementById(id);
                            if (el && val) el.value = val;
                        });
                    }
                    break;
                case 'grokModelsResult':
                    // Only replace the static list if discovery actually succeeded -
                    // on failure, leave the curated fallback options in place.
                    if (message.ok && Array.isArray(message.models) && message.models.length > 0) {
                        const sel = document.getElementById('cliModelXai');
                        if (sel) {
                            const previousValue = (savedCliModels && savedCliModels.xai) || sel.value;
                            sel.innerHTML = '<option value="">Auto' + (message.defaultModel ? ' (' + message.defaultModel + ')' : '') + '</option>' +
                                message.models.map(m => '<option value="' + m + '">' + m + '</option>').join('');
                            if (previousValue && message.models.includes(previousValue)) {
                                sel.value = previousValue;
                            }
                        }
                    } else {
                        console.log('AI Council: grok models discovery unavailable, keeping static list:', message.error);
                    }
                    break;
                case 'scopedRoundStart':
                    currentScopedRoundId = startScopedRound(
                        message.roundNum === 0 ? 'Round 0 - Initial Scope' : 'Follow-up round',
                        message.models || []
                    );
                    break;
                case 'scopedRoundProgress':
                    if (currentScopedRoundId) {
                        updateScopedRoundProgress(currentScopedRoundId, message.model, message.data);
                    }
                    break;
                case 'scopedReviewResult':
                    if (message.error) {
                        setScopedStatus('Error: ' + message.error);
                        document.getElementById('scopedScopeInput').style.display = 'block';
                        break;
                    }
                    currentScopedSessionId = message.result.session_id;
                    setScopedSessionReady(true);
                    if (currentScopedRoundId) {
                        finishScopedRound(currentScopedRoundId, message.result.consensus || {}, message.result.report_path, message.result.reviews);
                    }
                    document.getElementById('scopedFollowup').style.display = 'block';
                    document.getElementById('scopedFollowupText').value = '';
                    break;
                case 'scopedFollowupResult': {
                    const followupBtn = document.querySelector('#scopedFollowup button.btn-primary');
                    if (followupBtn) { followupBtn.disabled = false; }
                    if (message.error) {
                        setScopedStatus('Error: ' + message.error);
                        break;
                    }
                    if (currentScopedRoundId) {
                        finishScopedRound(currentScopedRoundId, message.result.consensus || {}, message.result.report_path, message.result.reviews);
                    }
                    document.getElementById('scopedFollowupText').value = '';
                    setScopedStatus('');
                    break;
                }
                case 'scopedFinalizeResult': {
                    const finalizeBtn = document.getElementById('finalizeScopedBtn');
                    if (finalizeBtn) { finalizeBtn.disabled = false; }
                    if (message.error) {
                        setScopedStatus('Error: ' + message.error);
                        break;
                    }
                    const requestedWriter = document.getElementById('scopedWriterSelect').value;
                    const actualWriter = message.result.writer;
                    // Belt-and-suspenders: server now errors instead of substituting, but say so loudly if it ever differs.
                    const substitutionNote = actualWriter !== requestedWriter
                        ? ' (requested ' + requestedWriter.toUpperCase() + ', but that seat was unavailable)'
                        : '';
                    setScopedStatus('Review doc written by ' + actualWriter.toUpperCase() + substitutionNote + ': ' + message.result.output_path);
                    vscode.postMessage({ command: 'openReviewDoc', path: message.result.output_path });
                    break;
                }
                case 'debateProgress':
                    updateDebateProgressLabel(message.text);
                    break;
                case 'debateResult':
                    stopDebateProgressTimer();
                    setDebateButtonsDisabled(false);
                    if (message.error) {
                        setScopedStatus('Error: ' + message.error);
                        break;
                    }
                    renderDebateRound(message.result);
                    setScopedStatus('');
                    break;
                case 'consolidateResult':
                    stopDebateProgressTimer();
                    setDebateButtonsDisabled(false);
                    if (message.error) {
                        setScopedStatus('Error: ' + message.error);
                        break;
                    }
                    renderConsolidated(message.result);
                    setScopedStatus(message.result.cached ? 'Showing cached consolidation.' : '');
                    break;
                case 'uncheckModel':
                    const checkbox = document.getElementById(message.modelId);
                    if (checkbox) {
                        checkbox.checked = false;
                    }
                    break;
                case 'cacheSize':
                    const label = document.getElementById('cacheSizeLabel');
                    if (label) {
                        label.textContent = message.size ? ' (' + message.size + ')' : '';
                    }
                    break;
                case 'restoreToggles':
                    // Restore saved toggle states
                    if (message.toggles) {
                        const toggleMap = {
                            'enableGpt': 'enableGpt',
                            'enableClaude': 'enableClaude',
                            'enableGrok': 'enableGrok',
                            'enableGptCli': 'enableGptCli',
                            'enableClaudeCli': 'enableClaudeCli',
                            'enableGrokCli': 'enableGrokCli',
                            'enableGemini': 'enableGemini',
                            'enableOllama': 'enableOllama',
                            'powerMode': 'powerMode'
                        };
                        for (const [key, id] of Object.entries(toggleMap)) {
                            const el = document.getElementById(id);
                            if (el && message.toggles[key] !== undefined) {
                                el.checked = message.toggles[key];
                            }
                        }
                        // Update power mode display
                        if (message.toggles.powerMode) {
                            document.querySelectorAll('.model-name-text').forEach(el => {
                                el.textContent = el.getAttribute('data-power') || el.textContent;
                            });
                        }
                    }
                    break;
                case 'statusPanel':
                    console.log('AI Council Webview: statusPanel message', message);
                    if (message.loading) {
                        // Already showing loading state from showStatus()
                    } else if (message.status) {
                        // Build org info HTML if available
                        let orgHtml = '';
                        console.log('AI Council Webview: orgInfo =', message.orgInfo);
                        if (message.orgInfo) {
                            const orgEntries = [];
                            if (message.orgInfo.openai) {
                                orgEntries.push('<div class="status-row"><span class="status-label" style="color:#10a37f;">OpenAI:</span><span class="status-value">' + message.orgInfo.openai + '</span></div>');
                            }
                            if (message.orgInfo.anthropic) {
                                orgEntries.push('<div class="status-row"><span class="status-label" style="color:#d97706;">Anthropic:</span><span class="status-value">' + message.orgInfo.anthropic + '</span></div>');
                            }
                            if (message.orgInfo.xai) {
                                orgEntries.push('<div class="status-row"><span class="status-label" style="color:#1da1f2;">xAI:</span><span class="status-value">' + message.orgInfo.xai + '</span></div>');
                            }
                            if (orgEntries.length > 0) {
                                orgHtml = '<div class="status-section-title">Accounts</div>' + orgEntries.join('');
                            }
                        }

                        // Restore the panel content structure FIRST
                        document.getElementById('statusPanelContent').innerHTML =
                            orgHtml +
                            '<div class="status-section-title">System</div>' +
                            '<div class="status-row"><span class="status-label">Database:</span><span class="status-value" id="statusDb">-</span></div>' +
                            '<div class="status-row"><span class="status-label">Reviewers:</span><span class="status-value" id="statusReviewers">-</span></div>' +
                            '<div class="status-row"><span class="status-label">Pending:</span><span class="status-value" id="statusPending">-</span></div>';
                        // Then update with values
                        updateStatusPanel(message.status);
                    }
                    break;
                case 'reviewStart':
                    startReviewPanel(message.fileName, message.models);
                    break;
                case 'reviewProgress':
                    updateModelProgress(message.model, message.data);
                    break;
                case 'reviewComplete':
                    showReviewSummary(message.results);
                    currentReportPath = message.reportPath || '';
                    break;
                case 'reviewCancelled':
                    document.getElementById('reviewPanelIcon').innerHTML = '&#10006;';
                    document.getElementById('reviewPanelTitle').textContent = 'Review Cancelled';
                    var cancelBtn = document.getElementById('cancelReviewBtn');
                    if (cancelBtn) cancelBtn.style.display = 'none';
                    break;
                case 'reviewFailed':
                    document.getElementById('reviewPanelIcon').innerHTML = '&#9888;';
                    document.getElementById('reviewPanelTitle').textContent = 'Review Failed';
                    document.getElementById('reviewPanelTitle').style.color = '#ef4444';
                    var failCancelBtn = document.getElementById('cancelReviewBtn');
                    if (failCancelBtn) failCancelBtn.style.display = 'none';
                    // Mark all models as failed and stop animations
                    var cards = document.querySelectorAll('.model-card');
                    cards.forEach(function(card) {
                        var status = card.querySelector('.model-status');
                        var spinner = card.querySelector('.model-spinner');
                        var scoreRing = card.querySelector('.model-score-ring');
                        if (status) {
                            status.textContent = 'Failed';
                            status.style.color = '#ef4444';
                        }
                        if (spinner) spinner.style.display = 'none';
                        if (scoreRing) scoreRing.classList.add('stopped');
                    });
                    break;
                case 'fixComplete':
                    var fixBtn = document.getElementById('fixCodeBtn');
                    if (fixBtn) {
                        fixBtn.disabled = false;
                        fixBtn.innerHTML = '&#128295; Fix with AI';
                    }
                    break;
                case 'openReport':
                    // Handled by extension
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}
