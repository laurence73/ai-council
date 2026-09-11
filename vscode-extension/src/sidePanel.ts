import * as vscode from 'vscode';
import * as path from 'path';
import * as https from 'https';
import { spawn } from 'child_process';

interface ReviewOptions {
    enableGpt: boolean;
    enableClaude: boolean;
    enableGrok: boolean;
    enableGemini: boolean;
    enableOllama: boolean;
    powerMode: boolean;
    synthesizer: string;
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
            enableGpt: true,
            enableClaude: true,
            enableGrok: true,
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
            if (e.affectsConfiguration('ai-council.apiKeys')) {
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
                        enableGemini: message.enableGemini,
                        enableOllama: message.enableOllama,
                        powerMode: message.powerMode,
                        synthesizer: message.synthesizer || 'auto'
                    });
                    break;
                case 'checkApiKey':
                    await this._checkApiKey(message.modelId, message.name, message.key, message.url, message.free);
                    break;
                case 'clearCache':
                    await this._clearCache();
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
                case 'cancelReview':
                    this._cancelReview();
                    break;
                case 'fixCode':
                    this._fixCode(message.fixer, message.reportPath);
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

    private async _fixCode(fixer: string, reportPath: string) {
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
        };

        const args = [`"${scriptPath}"`, 'fix', `"${filePath}"`, '--fixer', fixer];
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
            OLLAMA_URL: config.get<string>('ollamaUrl') || 'https://wowcentral.worldofworkflows.com',
        };

        // Build list of enabled models
        const enabledModelsList: string[] = [];
        if (options.enableGpt) { enabledModelsList.push('gpt-4'); }
        if (options.enableClaude) { enabledModelsList.push('claude'); }
        if (options.enableGrok) { enabledModelsList.push('grok'); }
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
        const modelResults: Record<string, { score: number; issues: number; error?: boolean }> = {};

        let stdout = '';
        let stderr = '';

        // Parse output in real-time for progress updates
        reviewProcess.stdout?.on('data', (data) => {
            const text = data.toString();
            stdout += text;
            console.log('AI Council stdout:', text.substring(0, 200));

            // Parse model completion: "[+] GPT-4 Score: 8/10 (5.2s) [1/3]" (may have leading spaces)
            const scoreMatch = text.match(/\[\+\]\s+(\w+[-\d]*)\s+Score:\s*(\d+)\/10/i);
            if (scoreMatch) {
                const modelName = scoreMatch[1].toLowerCase().replace('-4', '-4');
                const score = parseInt(scoreMatch[2]);

                // Map model names
                let modelKey = modelName;
                if (modelName.includes('gpt')) { modelKey = 'gpt-4'; }
                else if (modelName.includes('claude')) { modelKey = 'claude'; }
                else if (modelName.includes('grok')) { modelKey = 'grok'; }
                else if (modelName.includes('gemini')) { modelKey = 'gemini'; }

                // Initialize or update results (issues will be updated separately)
                if (!modelResults[modelKey]) {
                    modelResults[modelKey] = { score, issues: 0 };
                } else {
                    modelResults[modelKey].score = score;
                }

                if (this._view) {
                    this._view.webview.postMessage({
                        type: 'reviewProgress',
                        model: modelKey,
                        data: { score, issues: modelResults[modelKey].issues || 0, error: false }
                    });
                }
            }

            // Parse issues count: "[MODEL] Score: 8/10 | Issues: 5"
            const issuesMatch = text.match(/\[(\w+[-\d]*)\]\s+Score:\s*\d+\/10\s*\|\s*Issues:\s*(\d+)/i);
            if (issuesMatch) {
                const modelName = issuesMatch[1].toLowerCase();
                let modelKey = modelName;
                if (modelName.includes('gpt')) { modelKey = 'gpt-4'; }
                else if (modelName.includes('claude')) { modelKey = 'claude'; }
                else if (modelName.includes('grok')) { modelKey = 'grok'; }
                else if (modelName.includes('gemini')) { modelKey = 'gemini'; }

                const issues = parseInt(issuesMatch[2]);
                if (modelResults[modelKey]) {
                    modelResults[modelKey].issues = issues;
                }
            }

            // Parse errors: "[!] GPT-4 ERROR" (may have leading spaces)
            const errorMatch = text.match(/\[!\]\s+(\w+[-\d]*)\s+ERROR/i);
            if (errorMatch) {
                const modelName = errorMatch[1].toLowerCase();
                let modelKey = modelName;
                if (modelName.includes('gpt')) { modelKey = 'gpt-4'; }
                else if (modelName.includes('claude')) { modelKey = 'claude'; }
                else if (modelName.includes('grok')) { modelKey = 'grok'; }
                else if (modelName.includes('gemini')) { modelKey = 'gemini'; }

                modelResults[modelKey] = { score: 0, issues: 0, error: true };

                if (this._view) {
                    this._view.webview.postMessage({
                        type: 'reviewProgress',
                        model: modelKey,
                        data: { score: 0, issues: 0, error: true }
                    });
                }
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

            // Parse full stdout for any missed results (especially cached reviews)
            const allScoreMatches = stdout.matchAll(/\[\+\]\s+(\w+[-\d]*)\s+Score:\s*(\d+)\/10/gi);
            for (const match of allScoreMatches) {
                const modelName = match[1].toLowerCase();
                let modelKey = modelName;
                if (modelName.includes('gpt')) { modelKey = 'gpt-4'; }
                else if (modelName.includes('claude')) { modelKey = 'claude'; }
                else if (modelName.includes('grok')) { modelKey = 'grok'; }
                else if (modelName.includes('gemini')) { modelKey = 'gemini'; }

                const score = parseInt(match[2]);
                if (!modelResults[modelKey] || modelResults[modelKey].error) {
                    modelResults[modelKey] = { score, issues: 0 };
                }
            }

            // Parse issues counts
            const allIssuesMatches = stdout.matchAll(/\[(\w+[-\d]*)\]\s+Score:\s*\d+\/10\s*\|\s*Issues:\s*(\d+)/gi);
            for (const match of allIssuesMatches) {
                const modelName = match[1].toLowerCase();
                let modelKey = modelName;
                if (modelName.includes('gpt')) { modelKey = 'gpt-4'; }
                else if (modelName.includes('claude')) { modelKey = 'claude'; }
                else if (modelName.includes('grok')) { modelKey = 'grok'; }
                else if (modelName.includes('gemini')) { modelKey = 'gemini'; }

                const issues = parseInt(match[2]);
                if (modelResults[modelKey]) {
                    modelResults[modelKey].issues = issues;
                }
            }

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
            const enabledModels = [options.enableGpt, options.enableClaude, options.enableGrok, options.enableGemini].filter(Boolean).length;

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
                const args = [`"${scriptPath}"`, '--db', `"${dbPath}"`, 'review', `"${fullPath}"`, '--html', '--output', `"${reportPath}"`, '--synthesize'];
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

    private async _clearCache() {
        const dbPath = this._getWorkspaceDbPath();
        if (!dbPath) {
            vscode.window.showWarningMessage('AI Council: No workspace open');
            return;
        }

        try {
            await vscode.workspace.fs.delete(vscode.Uri.file(dbPath));
            vscode.window.showInformationMessage('AI Council: Review cache cleared');
            this.updateStatus('Cache cleared', false);
            this._sendCacheSize(); // Update button after clearing
        } catch (err) {
            vscode.window.showWarningMessage('AI Council: No cache to clear');
        }
    }

    private _getWorkspaceDbPath(): string | null {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return null;
        }
        return path.join(workspaceFolders[0].uri.fsPath, '.ai-council', 'reviews.db');
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

    private async _showStatus(toggles?: { gpt: boolean; claude: boolean; grok: boolean; gemini: boolean; ollama: boolean }) {
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

    private async _checkApiKey(modelId: string, name: string, key: string, url: string, free?: boolean) {
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
        } else {
            console.log('AI Council: No view available to send status');
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

        .synthesizer-select {
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 4px;
            padding: 4px 8px;
            font-size: 11px;
            cursor: pointer;
            min-width: 130px;
        }

        .synthesizer-select:focus {
            outline: 1px solid var(--vscode-focusBorder);
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
                <div class="section-title" style="color: #f59e0b;">&#36; PAID MODELS</div>
                <div class="toggle-group">
                    <div class="toggle-item" id="toggle-enableGpt">
                        <span class="toggle-label"><span class="model-name-text" data-standard="GPT-4" data-power="GPT-6 Astra">GPT-4</span><span class="key-status" id="key-openai" title="API Key Status"></span></span>
                        <label class="toggle-switch gpt">
                            <input type="checkbox" id="enableGpt" checked>
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                    <div class="toggle-item" id="toggle-enableClaude">
                        <span class="toggle-label"><span class="model-name-text" data-standard="Claude" data-power="Claude Fable">Claude</span><span class="key-status" id="key-anthropic" title="API Key Status"></span></span>
                        <label class="toggle-switch claude">
                            <input type="checkbox" id="enableClaude" checked>
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                    <div class="toggle-item" id="toggle-enableGrok">
                        <span class="toggle-label"><span class="model-name-text" data-standard="Grok" data-power="Grok-3">Grok</span><span class="key-status" id="key-xai" title="API Key Status"></span></span>
                        <label class="toggle-switch grok">
                            <input type="checkbox" id="enableGrok" checked>
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                    <div class="toggle-item" style="opacity: 0.5;">
                        <span class="toggle-label">Mistral <span class="model-badge badge-coming">#30</span></span>
                        <label class="toggle-switch mistral">
                            <input type="checkbox" id="enableMistral" disabled>
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
            'enableGpt': { name: 'GPT-4', key: 'openai', url: 'https://platform.openai.com/api-keys' },
            'enableClaude': { name: 'Claude', key: 'anthropic', url: 'https://console.anthropic.com/' },
            'enableGrok': { name: 'Grok', key: 'xai', url: 'https://console.x.ai/' },
            'enableGemini': { name: 'Gemini', key: 'google', url: 'https://aistudio.google.com/app/apikey', free: true },
            'enableOllama': { name: 'Ollama', key: 'ollama', url: '', free: true }
        };

        // Save toggle states to persist across sessions
        function saveToggleStates() {
            const toggles = {
                enableGpt: document.getElementById('enableGpt')?.checked || false,
                enableClaude: document.getElementById('enableClaude')?.checked || false,
                enableGrok: document.getElementById('enableGrok')?.checked || false,
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
            if (config.enableGpt) enabledModels.push('GPT');
            if (config.enableClaude) enabledModels.push('Claude');
            if (config.enableGrok) enabledModels.push('Grok');
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

        function clearCache() {
            vscode.postMessage({ command: 'clearCache' });
        }

        function showStatus() {
            // Show panel and request status with current toggle states
            document.getElementById('statusPanel').style.display = 'block';
            document.getElementById('statusPanelContent').innerHTML = '<div style="text-align:center;color:var(--vscode-descriptionForeground);font-style:italic;">Loading...</div>';
            const toggles = {
                gpt: document.getElementById('enableGpt')?.checked || false,
                claude: document.getElementById('enableClaude')?.checked || false,
                grok: document.getElementById('enableGrok')?.checked || false,
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
            vscode.postMessage({ command: 'fixCode', fixer: fixer, reportPath: currentReportPath });
        }

        function cancelReview() {
            vscode.postMessage({ command: 'cancelReview' });
        }

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

            // Build model cards
            const modelConfig = {
                'gpt-4': { name: 'GPT-4', icon: 'G', class: 'gpt' },
                'claude': { name: 'Claude', icon: 'C', class: 'claude' },
                'grok': { name: 'Grok', icon: 'X', class: 'grok' },
                'gemini': { name: 'Gemini', icon: 'G', class: 'gemini' },
                'ollama': { name: 'Ollama', icon: 'O', class: 'ollama' }
            };

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
                    if (org && orgSpan) {
                        orgSpan.textContent = org;
                        orgSpan.style.display = 'inline';
                        indicator.title = 'API Key Configured - ' + org;
                    } else if (orgSpan) {
                        orgSpan.style.display = 'none';
                        indicator.title = hasKey ? 'API Key Configured' : 'API Key Missing - Click toggle to configure';
                    } else {
                        indicator.title = hasKey ? 'API Key Configured' : 'API Key Missing - Click toggle to configure';
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
