import * as vscode from 'vscode';
import * as path from 'path';
import * as https from 'https';
import { spawn } from 'child_process';

// File extensions the review engine actually supports - shared so auto-review-on-save (which
// must not launch a full multi-seat review for every README.md/package.json save) and
// Review Current Commit's file picker can't drift out of sync with each other again.
export const SUPPORTED_REVIEW_EXTENSIONS = ['.cs', '.razor', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.cpp', '.c'];

// Collapses embedded newlines (e.g. multi-line scope/question text from a <textarea>) to a
// single line. Every spawn() call that runs user/file-derived content passes argv as an array
// with shell:false, so Node hands each element to the child process as one literal argument -
// no shell parsing, no quoting needed. (The one exception is _checkCliStatus, which spawns the
// claude/grok/codex .cmd shims - Windows can't exec those without a shell - but that only ever
// runs a small set of hardcoded subcommand literals, never user/file-derived text.)
function flattenArgLine(value: string): string {
    return value.replace(/\r?\n/g, ' ');
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
    arbiter: string;
}

interface ModelResult {
    score: number;
    issues: number;
    error?: boolean | string;
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

    const errorMatch = text.match(/\[!\]\s+([\w-]+)\s+ERROR(?:\s+\([^)]+\))?(?:\s+\[[^\]]+\])?\s*(.*)/i);
    if (errorMatch) {
        const modelKey = normalizeModelKey(errorMatch[1]);
        const detail = (errorMatch[2] || '').trim();
        modelResults[modelKey] = { score: 0, issues: 0, error: detail || true };
        return { model: modelKey, data: { score: 0, issues: 0, error: detail || true } };
    }

    return null;
}

// Full-stdout re-scan for anything the line-by-line parser missed (especially cached rounds,
// which never emit a live "[~] MODEL started..." line but still print in "Detailed Results").
function rescanModelResults(stdout: string, modelResults: Record<string, ModelResult>, stderr?: string) {
    // Check stderr for auth errors
    if (stderr && stderr.includes('AUTH_REQUIRED')) {
        // Extract CLI name (e.g., "codex" from "AUTH_REQUIRED:codex.cmd:...")
        const authMatch = stderr.match(/AUTH_REQUIRED:([^:]+):/);
        if (authMatch) {
            let cliName = authMatch[1].replace(/\.cmd$/, '').replace(/\.exe$/, '');
            // Map CLI name to model key
            const cliToModel: Record<string, string> = { codex: 'gpt-cli', claude: 'claude-cli', grok: 'grok-cli' };
            const modelKey = cliToModel[cliName.toLowerCase()] || cliName + '-cli';
            if (modelResults[modelKey]) {
                modelResults[modelKey].error = 'AUTH_REQUIRED:' + cliName;
            }
        }
    }

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
    private _webviewReady = false;
    private _grokModelsCache: { code: number | null; stdout: string; stderr: string } | null = null;
    private _grokModelsAt = 0;

    constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this._extensionUri = extensionUri;
        this._context = context;

        // Registered once here (not in resolveWebviewView, which can run again every time
        // VS Code disposes and recreates this hidden sidebar view) and disposed with the
        // extension, so hiding/reshowing the sidebar repeatedly can't stack up duplicate
        // listeners that each independently re-fire _sendApiKeyStatus().
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('ai-council.apiKeys')) {
                    this._sendApiKeyStatus();
                }
            })
        );
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

    // Council Verdict by / Fix Code with / Arbiter - unlike the checkbox seat toggles
    // (toggleStates), these three selects were never persisted at all: populateSeatSelect's own
    // "keep the current selection if still valid" logic only preserves a pick WITHIN one live
    // webview instance (it reads the <select>'s current .value before rebuilding options) - on a
    // fresh webview load (the sidebar disposes/recreates its webview on every hide/reshow, same
    // root cause as every other "state reset on reopen" bug in this project) each <select> starts
    // at its first/default option with nothing to preserve, so every pick silently reverted to
    // Auto/blank on return. Separate Record<string, string> from toggleStates (Record<string,
    // boolean>) rather than forcing a type mismatch into one shared dict for a different kind of
    // value.
    private _saveSeatSelections(selections: Record<string, string>) {
        this._context.globalState.update('ai-council.seatSelections', selections);
    }

    private _getSeatSelections(): Record<string, string> {
        return this._context.globalState.get('ai-council.seatSelections', {
            synthesizerSelect: 'auto',
            fixerSelect: '',
            arbiterSelect: 'none'
        });
    }

    // Separate from toggleStates (that's review CONFIG - what to run with; this is UI
    // presentation state - what's visually expanded right now). User-driven collapse/expand
    // persists across webview reloads (the sidebar disposes/recreates its webview on every
    // hide/reshow, wiping any in-memory-only collapse state) the same way seat toggles already
    // do; an auto-uncollapse triggered by an error is NOT saved here, so it doesn't silently
    // become the new "collapsed" default the next time the panel opens with no error present.
    private _saveSectionCollapsed(sections: Record<string, boolean>) {
        this._context.globalState.update('ai-council.sectionCollapsed', sections);
    }

    private _getSectionCollapsed(): Record<string, boolean> {
        return this._context.globalState.get('ai-council.sectionCollapsed', {
            modelSelection: false,
            reviewOptions: false
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

    // session_query.py is never overridable via ai-council.scriptPath (unlike _getScriptPath) -
    // it's a fixed internal helper next to the bundled ai_council.py, not something a user
    // should ever need to redirect. Deliberately kept separate from _getScriptPath rather than
    // adding a parameter to it, since scriptPath's whole purpose is letting a user point at
    // their OWN ai_council.py fork - session_query.py has no equivalent use case and no reason
    // to inherit that override surface.
    private _getSessionQueryScriptPath(): string {
        return path.join(this._extensionUri.fsPath, 'session_query.py');
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        // VS Code can dispose a sidebar webview when it's hidden (retainContextWhenHidden is
        // not set here) and recreate it fresh next time it's shown - the new page's script
        // hasn't run yet and so hasn't sent its own 'webviewReady' handshake, so this must not
        // carry over from the disposed view or triggerAction() would post into a page with no
        // 'invokeAction' listener registered yet.
        this._webviewReady = false;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlContent(webviewView.webview);

        webviewView.onDidDispose(() => {
            this._webviewReady = false;
            this._view = undefined;
        });

        // Send API key status when webview becomes visible
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
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
                        synthesizer: message.synthesizer || 'auto',
                        arbiter: 'none'
                    });
                    break;
                case 'checkApiKey':
                    await this._checkApiKey(message.modelId, message.name, message.key, message.url, message.free, message.kind, message.silent);
                    // The persistent status label next to each toggle (e.g. "timed out",
                    // "Logged in as...") is only ever refreshed by _sendApiKeyStatus, which
                    // toggling a seat did not previously trigger - a stale label from whenever
                    // the panel last loaded could sit there showing a state that no longer
                    // matches what _checkApiKey's own just-completed fresh check found
                    // (reproduced live: toggled a CLI seat on, the toggle turned on, but its
                    // "timed out" label from an earlier check never updated either way).
                    // Skipped for silent (restore-time bulk) checks - webviewReady already ran
                    // this once for the whole panel, and re-running it per restored seat would
                    // needlessly repeat every seat's CLI/URL/key check N times over.
                    if (!message.silent) {
                        await this._sendApiKeyStatus();
                    }
                    break;
                case 'clearCacheConfirmed':
                    await this._clearCacheConfirmed();
                    break;
                case 'openTerminal': {
                    // Webview messages are untrusted input, even though pendingLoginCli's own
                    // current call sites only ever set it from a fixed literal - message.cli
                    // was being concatenated directly into shell text sent to a real terminal
                    // (terminal.sendText), so a compromised/malicious webview could inject
                    // shell syntax (&, |, command substitution) via this one message. Fixed
                    // with a literal allowlist on the extension-host side - only these three
                    // known CLI binary names are ever used to build the command text; anything
                    // else is rejected outright rather than sanitized/escaped.
                    const allowedCli: Record<string, string> = { codex: 'codex', claude: 'claude', grok: 'grok' };
                    const cliName = allowedCli[message.cli];
                    if (!cliName) { break; }
                    const terminal = vscode.window.createTerminal(cliName + ' Login');
                    terminal.show();
                    terminal.sendText(cliName + ' logout && ' + cliName + ' login');
                    break;
                }
                case 'showActionableError':
                    // Lets a webview-side card (which cannot call vscode.window/commands
                    // itself - it runs in the webview sandbox) trigger the exact same
                    // seat-identification + Log In/Open Settings action every other failure
                    // surface in this file already gets, instead of only ever showing text
                    // with no way to act on it.
                    await this._showActionableError(message.message);
                    break;
                case 'showStatus':
                    await this._showStatus(message.toggles);
                    break;
                case 'openSettings':
                    vscode.commands.executeCommand('workbench.action.openSettings', 'ai-council');
                    break;
                case 'webviewReady':
                    // Webview is ready to receive messages
                    this._webviewReady = true;
                    this._sendApiKeyStatus();
                    this._sendCacheSize();
                    // Send saved toggle states
                    const savedToggles = this._getToggleStates();
                    this._view?.webview.postMessage({ type: 'restoreToggles', toggles: savedToggles });
                    this._view?.webview.postMessage({ type: 'restoreSectionCollapsed', sections: this._getSectionCollapsed() });
                    this._view?.webview.postMessage({ type: 'restoreSeatSelections', selections: this._getSeatSelections() });
                    break;
                case 'saveToggles':
                    // Save toggle states when user changes them
                    this._saveToggleStates(message.toggles);
                    break;
                case 'saveSectionCollapsed':
                    this._saveSectionCollapsed(message.sections);
                    break;
                case 'saveSeatSelections':
                    this._saveSeatSelections(message.selections);
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
                        synthesizer: message.synthesizer || 'auto',
                        arbiter: 'none'
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
                case 'listScopedSessions':
                    this._listScopedSessions();
                    break;
                case 'resumeScopedSession':
                    this._resumeScopedSession(message.sessionId);
                    break;
                case 'scopedReview':
                    this._scopedReview(message.scope, message.modelConfig);
                    break;
                case 'scopedFollowup':
                    this._scopedFollowup(message.sessionId, message.question, message.modelConfig, message.sessionArbiter);
                    break;
                case 'scopedFinalize':
                    this._scopedFinalize(message.sessionId, message.writer, message.modelConfig);
                    break;
                case 'runDebate':
                    this._runDebate(message.sessionId, message.modelConfig);
                    break;
                case 'runConsolidate':
                    this._runConsolidate(message.sessionId, message.modelConfig, message.force);
                    break;
                case 'cancelOperation':
                    this._cancelActiveOperation();
                    break;
                case 'fixCode':
                    this._fixCode(message.fixer, message.reportPath, message.modelConfig);
                    break;
            }
        });
    }

    // Lets extension.ts's command-palette/editor-title/context-menu commands drive the exact
    // same review flow the sidebar's own buttons do (one implementation, not two) - focuses
    // the sidebar (which resolves the webview if it hasn't been yet) and tells the webview's
    // own JS to invoke its usual runReview()/reviewCommit()/toggleScopedReviewPanel() function,
    // so it reuses the webview's live checkbox state and validation instead of the extension
    // host reconstructing a ReviewOptions object from stale saved toggles.
    public async triggerAction(action: 'review' | 'reviewPower' | 'reviewCommit' | 'reviewWithScope' | 'clearCache'): Promise<void> {
        await vscode.commands.executeCommand('ai-council.sidebar.focus');

        const post = () => this._view?.webview.postMessage({ type: 'invokeAction', action });

        if (this._webviewReady) {
            post();
            return;
        }

        // First focus after activation (or right after a hide/dispose recreate): the webview
        // needs a moment to resolve and send its own 'webviewReady' handshake before it can
        // safely receive this.
        await new Promise<void>((resolve) => {
            const started = Date.now();
            const interval = setInterval(() => {
                if (this._webviewReady || Date.now() - started > 5000) {
                    clearInterval(interval);
                    resolve();
                }
            }, 100);
        });

        if (!this._webviewReady) {
            vscode.window.showErrorMessage('AI Council: The sidebar view did not load in time - try again.');
            return;
        }
        post();
    }

    // Auto-review-on-save: reviews an explicit file without depending on activeTextEditor or
    // going through the webview's live checkbox state - a background/auto-formatted save
    // shouldn't have to steal editor focus just so _runReview can find a file, and shouldn't
    // pick up whatever the user happens to be mid-edit toggling in the sidebar right now.
    // Uses the same persisted toggle state the sidebar restores itself from on load.
    public async runAutoReviewOnSave(filePath: string): Promise<void> {
        await this._runReview(this._reviewOptionsFromToggles(), filePath);
    }

    // "AI Council: Review Current File" from the Explorer right-click menu - the clicked
    // resource, not activeTextEditor (which every other entry point legitimately wants,
    // since they have no clicked-resource context of their own).
    public async reviewExplorerResource(filePath: string): Promise<void> {
        await this._runReview(this._reviewOptionsFromToggles(), filePath);
    }

    private _reviewOptionsFromToggles(): ReviewOptions {
        const toggles = this._getToggleStates();
        return {
            enableGpt: !!toggles.enableGpt,
            enableClaude: !!toggles.enableClaude,
            enableGrok: !!toggles.enableGrok,
            enableGptCli: !!toggles.enableGptCli,
            enableClaudeCli: !!toggles.enableClaudeCli,
            enableGrokCli: !!toggles.enableGrokCli,
            enableGemini: !!toggles.enableGemini,
            enableOllama: !!toggles.enableOllama,
            powerMode: !!toggles.powerMode,
            synthesizer: 'auto',
            arbiter: 'none'
        };
    }

    // "AI Council: Show Last Review" - opens the most recently generated HTML report (the
    // same one the review panel's "Open Full Report" button opens) rather than reviving the
    // old in-memory result store + second webview panel, which held state nothing populates
    // any more now that reviewing always goes through the sidebar's own review panel. Checks
    // workspaceState first (survives a window reload, unlike the in-memory field alone), then
    // falls back to the newest file actually sitting in .ai-council/reports/ so the command
    // still works after a reload even if the persisted path itself didn't survive.
    public async showLastReport(): Promise<void> {
        const fs = require('fs');
        const candidate = this._currentReportPath || this._context.workspaceState.get<string>('ai-council.lastReportPath', '');
        if (candidate && fs.existsSync(candidate)) {
            vscode.env.openExternal(vscode.Uri.file(candidate));
            return;
        }

        const newest = this._findNewestReport();
        if (newest) {
            vscode.env.openExternal(vscode.Uri.file(newest));
            return;
        }

        vscode.window.showInformationMessage('AI Council: No review has been run yet.');
        await vscode.commands.executeCommand('ai-council.sidebar.focus');
    }

    private _findNewestReport(): string | null {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) { return null; }
        const reportsDir = path.join(workspaceFolders[0].uri.fsPath, '.ai-council', 'reports');
        const fs = require('fs');
        if (!fs.existsSync(reportsDir)) { return null; }

        let newestPath: string | null = null;
        let newestMtime = 0;
        for (const name of fs.readdirSync(reportsDir)) {
            if (!name.toLowerCase().endsWith('.html')) { continue; }
            const fullPath = path.join(reportsDir, name);
            const mtime = fs.statSync(fullPath).mtimeMs;
            if (mtime > newestMtime) {
                newestMtime = mtime;
                newestPath = fullPath;
            }
        }
        return newestPath;
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

    private _currentReportPath: string = '';
    private _currentProcess: any = null;
    // Checked between iterations of _reviewCommit's per-file loop, which awaits each spawn in
    // turn - killing the current file's process alone wouldn't stop it from moving on to the
    // next file.
    private _operationCancelled: boolean = false;
    // Set the instant Cancel is clicked, cleared only when the killed process's own close/error
    // handler actually fires. taskkill/SIGTERM are fire-and-forget - the process being killed
    // is still genuinely alive (still calling models, still billing) for some window after
    // _cancelActiveOperation returns, so a new operation must not be allowed to start until
    // that window is over, or two model runs overlap and the new one has no way to be
    // cancelled (Cancel only ever acts on _currentProcess, which would already point at it).
    private _cancelling: boolean = false;

    // Single in-flight guard shared by every long-running command (review, commit review,
    // scoped round/follow-up, debate, consolidate) - they all funnel through the one
    // _currentProcess handle, so starting a second one while it's occupied would silently
    // overwrite the first's process reference, orphaning it with no way to Cancel it.
    private _operationAlreadyRunning(): boolean {
        if (this._cancelling) {
            this.updateStatus('Still cancelling the previous operation - wait a moment', false);
            return true;
        }
        if (this._currentProcess) {
            this.updateStatus('Another operation is already running - wait for it to finish', false);
            return true;
        }
        return false;
    }

    private _setLastReportPath(reportPath: string) {
        this._currentReportPath = reportPath;
        this._context.workspaceState.update('ai-council.lastReportPath', reportPath);
    }

    // A killed process's close/error handler can still fire AFTER a new operation has already
    // started and set _currentProcess to a different (newer) process - taskkill in particular
    // is fire-and-forget (spawned, never awaited), so cancellation doesn't block on the child
    // actually exiting. Comparing identity before clearing means a stale handler for an old,
    // already-cancelled process can never null out a genuinely active newer one - it only ever
    // clears the field if it still points at THIS handler's own process. Also clears
    // _cancelling if this was the process being cancelled, so _operationAlreadyRunning() stops
    // refusing new operations only once the killed child has actually exited.
    private _clearIfCurrentProcess(proc: any) {
        if (this._currentProcess === proc) {
            this._currentProcess = null;
            this._cancelling = false;
        }
    }

    // Generic cancel for whichever ai_council.py process is running - all long-running
    // commands share the one _currentProcess handle. Does NOT clear _currentProcess itself:
    // taskkill/SIGTERM don't block until the child actually exits, so the process being
    // "cancelled" here is still genuinely alive (still calling models, still billing) for a
    // real window after this method returns. _cancelling keeps _operationAlreadyRunning()
    // refusing a new start until that window closes and the real close/error handler runs
    // _clearIfCurrentProcess - otherwise a second model run could overlap the first, and the
    // new one would have no way to be cancelled (Cancel only ever acts on _currentProcess,
    // which would already have been reassigned to it).
    private _cancelActiveOperation() {
        this._operationCancelled = true;
        if (this._currentProcess) {
            const pid = this._currentProcess.pid;
            console.log('AI Council: Cancelling operation, killing process', pid);
            this._cancelling = true;

            // On Windows, the python process may have spawned its own child processes (the
            // claude/grok/codex CLIs); killing just the python PID would leave those running.
            if (process.platform === 'win32' && pid) {
                spawn('taskkill', ['/pid', String(pid), '/f', '/t']);
            } else {
                this._currentProcess.kill('SIGTERM');
            }

            this.updateStatus('Cancelling...', true);
            if (this._view) {
                this._view.webview.postMessage({ type: 'operationCancelled' });
            }
        } else {
            console.log('AI Council: No process to cancel');
        }
    }

    private async _fixCode(fixer: string, reportPath: string, modelConfig?: Partial<ReviewOptions>) {
        if (this._operationAlreadyRunning()) {
            this._view?.webview.postMessage({ type: 'fixComplete', success: false });
            return;
        }
        // Every other spawn path (review, commit-review, scoped review/followup/finalize,
        // debate, consolidate) checks this before spawning - Fix with AI was missed, so a
        // stale/restored Ollama toggle with no configured URL still passed --ollama through to
        // the Python process here, silently pointed at nothing (no error at all), instead of
        // the actionable "configure ai-council.ollamaUrl" prompt every other flow gives.
        if (!(await this._guardOllamaConfigured(modelConfig))) {
            this._view?.webview.postMessage({ type: 'fixComplete', success: false });
            return;
        }

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

        // Get API keys - shared helper so this can't drift from review/commit/scoped review
        // again (it was previously missing OLLAMA_API_KEY/OLLAMA_URL entirely).
        const apiKeys = this._getApiKeysEnv();

        // Global seat flags (CLI + Ollama) via the same helper every other command uses -
        // without these, self.reviewers never gets a claude-cli/gpt-cli/grok-cli/ollama entry
        // to fix with.
        const args = [scriptPath, ...this._modelSeatGlobalArgs(modelConfig)];
        args.push('fix', filePath, '--fixer', fixer);
        if (reportPath) {
            args.push('--report', reportPath);
        }

        console.log('AI Council: Running fix command:', pythonPath, args.join(' '));

        this._operationCancelled = false;
        const fixProcess = spawn(pythonPath, args, {
            env: { ...process.env, ...apiKeys }
        });
        this._currentProcess = fixProcess;

        let stdout = '';
        let stderr = '';

        fixProcess.stdout?.on('data', (data) => { stdout += data.toString(); });
        fixProcess.stderr?.on('data', (data) => { stderr += data.toString(); });

        fixProcess.on('close', async (code) => {
            this._clearIfCurrentProcess(fixProcess);
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
            } else if (code !== null) {  // null means killed/cancelled - already reported via operationCancelled
                const errorMsg = stderr || 'Unknown error';
                console.error('AI Council fix error:', errorMsg);
                this._showActionableError(`AI Council: Fix failed - ${errorMsg.substring(0, 300)}`);
                this.updateStatus('Fix failed', false);
            }

            this._view?.webview.postMessage({ type: 'fixComplete', success: code === 0 });
        });

        fixProcess.on('error', (err) => {
            // Fires when the process never launched at all (close() never runs then) - same
            // reasoning as _runReview's error handler: _currentProcess must be cleared here or
            // the overlap guard permanently blocks every later operation.
            this._clearIfCurrentProcess(fixProcess);
            console.error('AI Council fix error:', err);
            this._showActionableError(`AI Council: ${err.message}`);
            this.updateStatus('Fix failed', false);
            this._view?.webview.postMessage({ type: 'fixComplete', success: false });
        });
    }

    private async _runReview(options: ReviewOptions, explicitFilePath?: string) {
        // explicitFilePath lets a caller that already knows exactly which file it means (e.g.
        // auto-review-on-save, which must not depend on activeTextEditor - a background/
        // auto-formatted save shouldn't require stealing editor focus just to pick a file)
        // bypass the activeTextEditor lookup every button/command-palette trigger still uses.
        const filePath = explicitFilePath || vscode.window.activeTextEditor?.document.uri.fsPath;
        if (!filePath) {
            this.updateStatus('No file open', false);
            vscode.window.showWarningMessage('Open a file to review');
            return;
        }

        // Any operation already running (a review, a debate round, a scoped round, a commit
        // review's per-file loop - all of them set _currentProcess, not just _runReview) would
        // have its process handle overwritten by a second spawn here: the first process keeps
        // running (and billing) with no way to Cancel it, since Cancel only ever kills whatever
        // _currentProcess currently points at.
        if (this._operationAlreadyRunning()) { return; }
        if (!(await this._guardOllamaConfigured(options))) { return; }

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

        // Get API keys from VS Code settings only
        const apiKeys = this._getApiKeysEnv();

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
        const args = [scriptPath, '--db', dbPath, ...this._modelSeatGlobalArgs(options)];

        // Add subcommand and its arguments
        args.push('review', filePath, '--html', '--output', reportPath, '--synthesize');
        if (options.synthesizer && options.synthesizer !== 'auto') {
            args.push('--synthesizer', options.synthesizer);
        }
        args.push(...this._modelSeatSubcommandArgs(options));

        // Pass API keys via environment
        this._operationCancelled = false;
        const reviewProcess = spawn(pythonPath, args, {
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
            this._clearIfCurrentProcess(reviewProcess);

            rescanModelResults(stdout, modelResults, stderr);

            console.log('AI Council: Process closed with code', code, 'results:', JSON.stringify(modelResults));

            if (code === 0) {
                this.updateStatus('', false);  // Clear status bar - panel shows the result
                this._setLastReportPath(reportPath);

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
                this._showActionableError(`AI Council: ${errorMsg.substring(0, 300)}`);
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
            // Unlike a non-zero exit (handled in 'close' above), this fires when the process
            // never launched at all (e.g. python missing from PATH) - close() never runs, so
            // _currentProcess must be cleared here or the overlap guard added earlier
            // permanently blocks every later review until the window reloads.
            this._clearIfCurrentProcess(reviewProcess);
            this.updateStatus('Review failed', false);
            this._showActionableError(`AI Council: ${err.message}`);
        });
    }

    private async _reviewCommit(options: ReviewOptions) {
        if (this._operationAlreadyRunning()) { return; }
        if (!(await this._guardOllamaConfigured(options))) { return; }

        // Get workspace folder
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        const workspacePath = workspaceFolders[0].uri.fsPath;
        this.updateStatus('Checking staged files...', true);

        // Get staged files using git
        const gitProcess = spawn('git', ['diff', '--cached', '--name-only'], {
            cwd: workspacePath
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
            const reviewableFiles = stagedFiles.filter(f =>
                SUPPORTED_REVIEW_EXTENSIONS.some(ext => f.toLowerCase().endsWith(ext))
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

            const apiKeys = this._getApiKeysEnv();

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

            this._operationCancelled = false;
            for (const file of filesToReview) {
                if (this._operationCancelled) { break; }
                const fullPath = path.join(workspacePath, file);
                const fileName = path.basename(file, path.extname(file));
                // Clean filename for report
                let cleanName = fileName.replace(/^ai-council-/, '');
                if (cleanName.length > 30) cleanName = cleanName.substring(0, 30);
                const reportPath = path.join(reportsDir, `review-${cleanName}-${timestamp}.html`);
                completed++;
                this.updateStatus(`Reviewing ${completed}/${filesToReview.length}: ${path.basename(file)}...`, true);

                // Build command args - always generate HTML and synthesize
                const args = [scriptPath, '--db', dbPath, ...this._modelSeatGlobalArgs(options)];
                args.push('review', fullPath, '--html', '--output', reportPath, '--synthesize');
                if (options.synthesizer && options.synthesizer !== 'auto') {
                    args.push('--synthesizer', options.synthesizer);
                }
                args.push(...this._modelSeatSubcommandArgs(options));

                // Run review and wait for completion
                await new Promise<void>((resolve) => {
                    const reviewProcess = spawn(pythonPath, args, {
                        env: { ...process.env, ...apiKeys }
                    });
                    this._currentProcess = reviewProcess;

                    reviewProcess.on('close', (code) => {
                        this._clearIfCurrentProcess(reviewProcess);
                        if (code !== 0) { failed++; } else { this._setLastReportPath(reportPath); }
                        resolve();
                    });

                    reviewProcess.on('error', () => {
                        this._clearIfCurrentProcess(reviewProcess);
                        failed++;
                        resolve();
                    });
                });
            }

            if (this._operationCancelled) { return; }

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

    private _getApiKeysEnv(): Record<string, string> {
        const config = vscode.workspace.getConfiguration('ai-council');
        return {
            OPENAI_API_KEY: config.get<string>('apiKeys.openai') || '',
            ANTHROPIC_API_KEY: config.get<string>('apiKeys.anthropic') || '',
            XAI_API_KEY: config.get<string>('apiKeys.xai') || '',
            GOOGLE_API_KEY: config.get<string>('apiKeys.google') || '',
            OLLAMA_API_KEY: config.get<string>('apiKeys.ollama') || '',
            AI_COUNCIL_REVIEW_RUBRIC: config.get<string>('reviewRubric') || '',
            OLLAMA_URL: config.get<string>('ollamaUrl') || '',
            // API seat model IDs - settings, not a hardcoded default baked into ai_council.py.
            // Empty here means "let ai_council.py's own MODEL_CONFIGS fallback apply" (the
            // current known-good default), not "no model" - these are optional overrides, same
            // reasoning as AI_COUNCIL_CLI_MODEL_* for CLI seats.
            AI_COUNCIL_API_MODEL_OPENAI_STANDARD: config.get<string>('models.openai.standard') || '',
            AI_COUNCIL_API_MODEL_OPENAI_POWER: config.get<string>('models.openai.power') || '',
            AI_COUNCIL_API_MODEL_ANTHROPIC_STANDARD: config.get<string>('models.anthropic.standard') || '',
            AI_COUNCIL_API_MODEL_ANTHROPIC_POWER: config.get<string>('models.anthropic.power') || '',
            AI_COUNCIL_API_MODEL_XAI_STANDARD: config.get<string>('models.xai.standard') || '',
            AI_COUNCIL_API_MODEL_XAI_POWER: config.get<string>('models.xai.power') || '',
            AI_COUNCIL_API_MODEL_GOOGLE_STANDARD: config.get<string>('models.google.standard') || '',
            AI_COUNCIL_API_MODEL_GOOGLE_POWER: config.get<string>('models.google.power') || '',
        };
    }

    private _runJsonCommand(args: string[]): Promise<{ result?: any; error?: string }> {
        const config = vscode.workspace.getConfiguration('ai-council');
        const pythonPath = config.get<string>('pythonPath') || 'python';
        console.log('AI Council: Running scoped command:', pythonPath, args.join(' '));

        return new Promise((resolve) => {
            const proc = spawn(pythonPath, args, { env: { ...process.env, ...this._getApiKeysEnv() } });
            this._currentProcess = proc;
            this._operationCancelled = false;
            let stdout = '';
            let stderr = '';
            proc.stdout?.on('data', (d) => { stdout += d.toString(); });
            proc.stderr?.on('data', (d) => { stderr += d.toString(); });
            proc.on('close', () => {
                this._clearIfCurrentProcess(proc);
                const line = stdout.trim().split('\n').pop() || '';
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.error) {
                        // ai_council.py's clustering/synthesis/debate error paths attach the
                        // model's actual raw response as `raw` (e.g. cluster_findings on a
                        // parse failure) - dropping it here left "Failed to parse clustering
                        // response" as the ENTIRE error shown to the user, with zero indication
                        // of what the model actually said or why parsing failed (reproduced
                        // live: an Ollama clustering call failed with no way to see its output).
                        const detail = typeof parsed.raw === 'string' && parsed.raw ? ` - model returned: ${parsed.raw.substring(0, 300)}` : '';
                        resolve({ error: `${parsed.error}${detail}` });
                    } else {
                        resolve({ result: parsed });
                    }
                } catch (e) {
                    resolve({ error: (stderr || stdout || 'No output').substring(0, 300) });
                }
            });
            proc.on('error', (err) => { this._clearIfCurrentProcess(proc); resolve({ error: err.message }); });
        });
    }

    // Same as _runJsonCommand, but also streams the "[DEBATE]"/"[CONSOLIDATE]" stderr stage
    // markers live instead of leaving the UI on one static "Running..." string for the whole call.
    private _runJsonCommandWithProgress(args: string[], progressMessageType: string): Promise<{ result?: any; error?: string }> {
        const config = vscode.workspace.getConfiguration('ai-council');
        const pythonPath = config.get<string>('pythonPath') || 'python';
        console.log('AI Council: Running scoped command (live):', pythonPath, args.join(' '));

        return new Promise((resolve) => {
            const proc = spawn(pythonPath, args, { env: { ...process.env, ...this._getApiKeysEnv() } });
            this._currentProcess = proc;
            this._operationCancelled = false;
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
                this._clearIfCurrentProcess(proc);
                const line = stdout.trim().split('\n').pop() || '';
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.error) {
                        // ai_council.py's clustering/synthesis/debate error paths attach the
                        // model's actual raw response as `raw` (e.g. cluster_findings on a
                        // parse failure) - dropping it here left "Failed to parse clustering
                        // response" as the ENTIRE error shown to the user, with zero indication
                        // of what the model actually said or why parsing failed (reproduced
                        // live: an Ollama clustering call failed with no way to see its output).
                        const detail = typeof parsed.raw === 'string' && parsed.raw ? ` - model returned: ${parsed.raw.substring(0, 300)}` : '';
                        resolve({ error: `${parsed.error}${detail}` });
                    } else {
                        // debate/consolidate now regenerate the session's one evolving report
                        // (report_path) on every call - _runScopedCommandWithProgress (round 0/
                        // followup) already tracks this same field, this call path was the one
                        // missing it, leaving "Show Last Review" pointed at a stale round-0
                        // report even after debate/consolidate updated a newer one.
                        if (parsed?.report_path) { this._setLastReportPath(parsed.report_path); }
                        resolve({ result: parsed });
                    }
                } catch (e) {
                    resolve({ error: (stderr || stdout || 'No output').substring(0, 300) });
                }
            });
            proc.on('error', (err) => { this._clearIfCurrentProcess(proc); resolve({ error: err.message }); });
        });
    }

    // Global flags (must precede the subcommand) in ai_council.py's argparse: CLI seats and
    // Ollama. Mirrors _runReview's args-building exactly - this was previously duplicated as
    // a CLI-seats-only helper, which silently dropped Gemini/Ollama and gave no way to turn
    // OFF an API seat that has a key configured, for every scoped-review command.
    // Blocks a launch outright when Ollama is enabled with no server URL configured, rather
    // than silently spawning a reviewer pointed at nothing (confirmed live: the engine logs
    // "Ollama reviewer enabled (model @ )" with a blank URL, no error, no popup). _checkApiKey
    // only fires at the moment the toggle is actively clicked - a toggle state restored from a
    // previous session (persisted via saveToggleStates/restoreToggles) never re-triggers it, so
    // every actual review launch needs its own check too, not just the toggle-click path.
    private async _guardOllamaConfigured(modelConfig?: Partial<ReviewOptions>): Promise<boolean> {
        if (!modelConfig?.enableOllama) { return true; }
        const ollamaUrl = vscode.workspace.getConfiguration('ai-council').get<string>('ollamaUrl') || '';
        if (ollamaUrl.trim()) { return true; }
        const result = await vscode.window.showWarningMessage(
            'Ollama is enabled but ai-council.ollamaUrl is not set - this review would silently run without that seat. Configure it or turn Ollama off.',
            'Open Settings'
        );
        if (result === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'ai-council.ollamaUrl');
        }
        return false;
    }

    private _modelSeatGlobalArgs(modelConfig?: Partial<ReviewOptions>): string[] {
        const args: string[] = [];
        const config = vscode.workspace.getConfiguration('ai-council');
        if (modelConfig?.enableOllama) {
            args.push('--ollama');
            const ollamaUrl = config.get<string>('ollamaUrl');
            if (ollamaUrl) { args.push('--ollama-url', ollamaUrl); }
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
        const fullArgs = [...args, '--json-output', jsonOutputPath];
        console.log('AI Council: Running scoped command (live):', pythonPath, fullArgs.join(' '));

        const modelResults: Record<string, ModelResult> = {};
        let stdout = '';
        let stderr = '';

        const proc = spawn(pythonPath, fullArgs, { env: { ...process.env, ...this._getApiKeysEnv() } });
        this._currentProcess = proc;
        this._operationCancelled = false;

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
        this._clearIfCurrentProcess(proc);

        rescanModelResults(stdout, modelResults, stderr);

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

        if (result?.report_path) { this._setLastReportPath(result.report_path); }
        if (error) { this._showActionableError(`AI Council: ${error}`); }

        this._view?.webview.postMessage({ type: resultMessageType, result, error, liveModelResults: modelResults });
    }

    // The Scope panel's webview state is lost every time the sidebar is hidden and recreated
    // (see resolveWebviewView's retainContextWhenHidden note) - listSessions/resumeSession let
    // the panel rebuild itself from SQLite instead of a session only ever being reachable while
    // its original webview instance happened to stay alive.
    //
    // Listing/resuming a session is a pure SQLite read with no reviewer/AI call involved at all,
    // so it must be both fast and never contend with a real operation. Two approaches were tried
    // before this one, both rejected (see design-decisions.md):
    //  1. Spawning ai_council.py itself - correct data, but importing that module alone costs
    //     ~2.5s (openai/anthropic SDK imports at module top-level, paid regardless of which
    //     class is actually touched), which is the "too much background processing" this was
    //     meant to fix, not fixed.
    //  2. better-sqlite3, reading reviews.db directly from the extension host - fast, but a
    //     native module requiring Node >=22 while the extension's declared VS Code floor
    //     (^1.85.0) embeds a much older Node/Electron; a failed native load at module-import
    //     time would have broken the WHOLE extension's activation, not just this feature
    //     (flagged independently by two ground-up security reviews, both confirmed by direct
    //     inspection - real, not theoretical).
    // Current approach: spawn session_query.py, a small standalone script with the same
    // queries/assembly logic but zero ai_council.py import (no SDK cost) - fast AND no native
    // dependency. Deliberately does NOT set this._currentProcess / use _runJsonCommand's overlap
    // guard - a session-list lookup must never be blocked by, or block, a real in-flight
    // operation, which spawning through the same guarded helper every review/debate/consolidate
    // uses would reintroduce.
    private _runSessionQuery(args: string[]): Promise<{ result?: any; error?: string }> {
        const config = vscode.workspace.getConfiguration('ai-council');
        const pythonPath = config.get<string>('pythonPath') || 'python';
        const scriptPath = this._getSessionQueryScriptPath();
        return new Promise((resolve) => {
            const proc = spawn(pythonPath, [scriptPath, ...args]);
            let stdout = '';
            let stderr = '';
            // Deliberately does not use the shared overlap guard (see the comment above
            // _runSessionQuery's callers), but a pure local SQLite read with no watchdog at all
            // could still hang forever with nothing telling the user (a locked db file, an
            // antivirus scan holding the file, a stuck interpreter) - same watchdog shape
            // _runCliCommand already uses (CLI_STATUS_TIMEOUT_MS, settled guard against a double
            // resolve, kill + resolve on timeout) rather than a new one-off pattern.
            let settled = false;
            const finish = (result: { result?: any; error?: string }) => {
                if (settled) { return; }
                settled = true;
                clearTimeout(watchdog);
                resolve(result);
            };
            proc.stdout?.on('data', (d) => { stdout += d.toString(); });
            proc.stderr?.on('data', (d) => { stderr += d.toString(); });
            proc.on('close', () => {
                try {
                    finish({ result: JSON.parse(stdout.trim()) });
                } catch {
                    finish({ error: (stderr || stdout || 'No output').substring(0, 300) });
                }
            });
            proc.on('error', (err) => finish({ error: err.message }));
            const watchdog = setTimeout(() => {
                try { proc.kill(); } catch { /* already exited */ }
                finish({ error: 'Session query timed out' });
            }, AiCouncilSidebarProvider.CLI_STATUS_TIMEOUT_MS);
        });
    }

    private async _listScopedSessions() {
        const dbPath = this._getWorkspaceDbPath();
        if (!dbPath) {
            this._view?.webview.postMessage({ type: 'scopedSessionsList', sessions: [] });
            return;
        }
        // Scoped to the file open in the active editor when the panel was opened, same as
        // _scopedReview's own file resolution - a session outlives the tab it started from, but
        // "sessions for the file I'm looking at right now" is the useful default here.
        const filePath = vscode.window.activeTextEditor?.document.uri.fsPath;
        const args = ['--db', dbPath, 'scoped-sessions', '--limit', '50'];
        if (filePath) { args.push('--file', filePath); }
        const { result, error } = await this._runSessionQuery(args);
        this._view?.webview.postMessage({ type: 'scopedSessionsList', sessions: result?.sessions || [], error });
    }

    private async _resumeScopedSession(sessionId: string) {
        const dbPath = this._getWorkspaceDbPath();
        if (!dbPath) {
            this._view?.webview.postMessage({ type: 'scopedResumeResult', error: 'No workspace folder open' });
            return;
        }
        const { result, error } = await this._runSessionQuery(['--db', dbPath, 'scoped-resume', '--session', sessionId]);
        if (result?.report_path) { this._setLastReportPath(result.report_path); }
        this._view?.webview.postMessage({ type: 'scopedResumeResult', result, error });
    }

    private async _scopedReview(scope: string, modelConfig?: Partial<ReviewOptions>) {
        if (this._operationAlreadyRunning()) {
            this._view?.webview.postMessage({ type: 'scopedReviewResult', error: 'Another operation is already running - wait for it to finish' });
            return;
        }
        if (!(await this._guardOllamaConfigured(modelConfig))) {
            this._view?.webview.postMessage({ type: 'scopedReviewResult', error: 'Ollama is enabled but not configured' });
            return;
        }
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
        // The nominated arbiter (if any) is excluded from reviewing entirely - it must not get
        // a progress card here, since it will never report one: this round never calls it.
        const arbiterSeat = modelConfig?.arbiter && modelConfig.arbiter !== 'none' ? modelConfig.arbiter : null;
        const reviewingModels = arbiterSeat ? models.filter(m => m !== arbiterSeat) : models;
        this._view?.webview.postMessage({ type: 'scopedRoundStart', roundNum: 0, models: reviewingModels });

        const args = [scriptPath, '--db', dbPath, ...this._modelSeatGlobalArgs(modelConfig),
            'scoped-review', filePath, '--scope', flattenArgLine(scope),
            ...this._modelSeatSubcommandArgs(modelConfig), '--html', '--output', reportPath];
        if (modelConfig?.synthesizer && modelConfig.synthesizer !== 'auto') {
            args.push('--synthesizer', modelConfig.synthesizer);
        }
        if (arbiterSeat) {
            args.push('--arbiter', arbiterSeat);
        }

        await this._runScopedCommandWithProgress(args, 'scopedReviewResult', 'scopedRoundProgress');
    }

    private async _scopedFollowup(sessionId: string, question: string, modelConfig?: Partial<ReviewOptions>, sessionArbiter?: string | null) {
        if (this._operationAlreadyRunning()) {
            this._view?.webview.postMessage({ type: 'scopedFollowupResult', error: 'Another operation is already running - wait for it to finish' });
            return;
        }
        if (!(await this._guardOllamaConfigured(modelConfig))) {
            this._view?.webview.postMessage({ type: 'scopedFollowupResult', error: 'Ollama is enabled but not configured' });
            return;
        }
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
            reportArgs = ['--html', '--output', reportPath];
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
        // Same reasoning as _scopedReview: the nominated arbiter (persisted from round 0, not
        // re-specified here - scoped-followup has no --arbiter flag) never reviews, so it must
        // not get a progress card in a follow-up round either. Uses sessionArbiter (the
        // webview's persisted round-0 value), NOT modelConfig.arbiter - that's the live picker,
        // which the user can change after round 0 without the backend ever honoring it. Cards
        // built from the live picker can show a seat that will never report (the backend still
        // excludes the PERSISTED arbiter regardless of what the picker now says) or omit a
        // card for a seat the backend does call.
        const arbiterSeat = sessionArbiter && sessionArbiter !== 'none' ? sessionArbiter : null;
        const reviewingModels = arbiterSeat ? models.filter(m => m !== arbiterSeat) : models;
        this._view?.webview.postMessage({ type: 'scopedRoundStart', models: reviewingModels });

        const args = [scriptPath, '--db', dbPath, ...this._modelSeatGlobalArgs(modelConfig),
            'scoped-followup', '--session', sessionId, '--question', flattenArgLine(question),
            ...this._modelSeatSubcommandArgs(modelConfig), ...reportArgs];
        if (modelConfig?.synthesizer && modelConfig.synthesizer !== 'auto') {
            args.push('--synthesizer', modelConfig.synthesizer);
        }

        await this._runScopedCommandWithProgress(args, 'scopedFollowupResult', 'scopedRoundProgress');
    }

    private async _scopedFinalize(sessionId: string, writer: string, modelConfig?: Partial<ReviewOptions>) {
        if (this._operationAlreadyRunning()) {
            this._view?.webview.postMessage({ type: 'scopedFinalizeResult', error: 'Another operation is already running - wait for it to finish' });
            return;
        }
        if (!(await this._guardOllamaConfigured(modelConfig))) {
            this._view?.webview.postMessage({ type: 'scopedFinalizeResult', error: 'Ollama is enabled but not configured' });
            return;
        }
        const dbPath = this._getWorkspaceDbPath();
        if (!dbPath) {
            this._view?.webview.postMessage({ type: 'scopedFinalizeResult', error: 'No workspace folder open' });
            return;
        }
        const scriptPath = this._getScriptPath();

        const args = [scriptPath, '--db', dbPath, ...this._modelSeatGlobalArgs(modelConfig),
            'scoped-finalize', '--session', sessionId,
            ...this._modelSeatSubcommandArgs(modelConfig), '--json'];
        if (writer) {
            args.push('--writer', writer);
        }

        const { result, error } = await this._runJsonCommand(args);
        if (error) { this._showActionableError(`AI Council: ${error}`); }
        this._view?.webview.postMessage({ type: 'scopedFinalizeResult', result, error });
    }

    // The arbiter (if any) is NOT passed here - ai_council.py's `debate` subcommand no longer
    // accepts one. It was nominated once via --arbiter on scoped-review, before that round's
    // reviews ran, specifically so the arbiter seat could never have findings of its own to be
    // judging; run_debate_round reads that persisted nomination back itself. Accepting a fresh
    // arbiter argument here would let a seat that already reviewed the code become arbiter
    // after the fact, exactly the conflict of interest the up-front nomination exists to close.
    private async _runDebate(sessionId: string, modelConfig?: Partial<ReviewOptions>) {
        if (this._operationAlreadyRunning()) {
            this._view?.webview.postMessage({ type: 'debateResult', error: 'Another operation is already running - wait for it to finish' });
            return;
        }
        if (!(await this._guardOllamaConfigured(modelConfig))) {
            this._view?.webview.postMessage({ type: 'debateResult', error: 'Ollama is enabled but not configured' });
            return;
        }
        const dbPath = this._getWorkspaceDbPath();
        if (!dbPath) {
            this._view?.webview.postMessage({ type: 'debateResult', error: 'No workspace folder open' });
            return;
        }
        const scriptPath = this._getScriptPath();

        const args = [scriptPath, '--db', dbPath, ...this._modelSeatGlobalArgs(modelConfig),
            'debate', '--session', sessionId, ...this._modelSeatSubcommandArgs(modelConfig), '--json'];

        const { result, error } = await this._runJsonCommandWithProgress(args, 'debateProgress');
        if (error) { this._showActionableError(`AI Council: ${error}`); }
        this._view?.webview.postMessage({ type: 'debateResult', result, error });
    }

    private async _runConsolidate(sessionId: string, modelConfig?: Partial<ReviewOptions>, force?: boolean) {
        if (this._operationAlreadyRunning()) {
            this._view?.webview.postMessage({ type: 'consolidateResult', error: 'Another operation is already running - wait for it to finish' });
            return;
        }
        if (!(await this._guardOllamaConfigured(modelConfig))) {
            this._view?.webview.postMessage({ type: 'consolidateResult', error: 'Ollama is enabled but not configured' });
            return;
        }
        const dbPath = this._getWorkspaceDbPath();
        if (!dbPath) {
            this._view?.webview.postMessage({ type: 'consolidateResult', error: 'No workspace folder open' });
            return;
        }
        const scriptPath = this._getScriptPath();

        const args = [scriptPath, '--db', dbPath, ...this._modelSeatGlobalArgs(modelConfig),
            'consolidate', '--session', sessionId, ...this._modelSeatSubcommandArgs(modelConfig),
            ...(force ? ['--force'] : []), '--json'];

        const { result, error } = await this._runJsonCommandWithProgress(args, 'debateProgress');
        if (error) { this._showActionableError(`AI Council: ${error}`); }
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
        const apiKeys = this._getApiKeysEnv();

        // Send loading state
        if (this._view) {
            this._view.webview.postMessage({ type: 'statusPanel', loading: true });
        }

        // Start org info fetch immediately
        console.log('AI Council: Starting org info fetch...');
        const orgInfoPromise = this._fetchAllOrgInfo(apiKeys);
        const cliModelsPromise = this._getCliDefaultModels();

        // Build args - global flags must come BEFORE the subcommand
        const ollamaUrl = config.get<string>('ollamaUrl');
        const ollamaModel = config.get<string>('ollamaModel');
        let args = [scriptPath];

        // Add db path if available
        if (dbPath) {
            args.push('--db', dbPath);
        }

        // Add ollama flags BEFORE the subcommand (ollama is global)
        if (ollamaUrl && apiKeys.OLLAMA_API_KEY) {
            args.push('--ollama');
            args.push('--ollama-url', ollamaUrl);
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
            console.log('AI Council: Running status command:', pythonPath, args.join(' '));
            const statusProcess = spawn(pythonPath, args, {
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

        // Wait for all to complete
        const [status, orgInfo, cliModels] = await Promise.all([statusPromise, orgInfoPromise, cliModelsPromise]);

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
            console.log('AI Council: Sending to webview - orgInfo:', JSON.stringify(orgInfo), 'cliModels:', JSON.stringify(cliModels));
            this._view.webview.postMessage({
                type: 'statusPanel',
                loading: false,
                status,
                orgInfo,
                cliModels
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

    // Shared spawn for the three CLI binaries - shell:true is used here with one manually-quoted
    // command string (never a raw args array, which Node does NOT escape even under shell:true -
    // that reintroduces exactly the injection risk shell:false was removed elsewhere in this
    // file to close), since claude/codex/grok are .cmd shims on Windows that spawn can't run
    // directly without a shell. The only caller-supplied pieces are fixed subcommand literals
    // (e.g. 'auth', 'status', 'models'), never user/file-derived text.
    //
    // 30s not 5s: Grok CLI starts a leader process on a cold sidebar-open; 5s killed that
    // before stdout and the UI treated it as "not logged in" / Log In. Claude/Codex auth
    // status is fast; a longer fuse does not hurt them. Cleared on close/error so it never
    // fires against an already-settled promise.
    private static readonly CLI_STATUS_TIMEOUT_MS = 30000;

    private _runCliCommand(bin: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
        return new Promise((resolve) => {
            const command = [bin, ...args.map(AiCouncilSidebarProvider.quoteArg)].join(' ');
            const proc = spawn(command, [], { shell: true });
            let stdout = '';
            let stderr = '';
            let settled = false;
            const finish = (result: { code: number | null; stdout: string; stderr: string }) => {
                if (settled) { return; }
                settled = true;
                clearTimeout(watchdog);
                resolve(result);
            };
            proc.stdout?.on('data', (d) => { stdout += d.toString(); });
            proc.stderr?.on('data', (d) => { stderr += d.toString(); });
            proc.on('close', (code) => finish({ code, stdout, stderr }));
            proc.on('error', (err) => finish({ code: -1, stdout: '', stderr: err.message }));
            const watchdog = setTimeout(() => {
                try { proc.kill(); } catch { /* already exited */ }
                finish({ code: -1, stdout, stderr: stderr || 'timed out' });
            }, AiCouncilSidebarProvider.CLI_STATUS_TIMEOUT_MS);
        });
    }

    // Read-only status display, not a picker (this extension has no CLI model setting - it
    // always uses whatever model each CLI's own login/config already resolves to). Codex has no
    // status/model-listing command, so its active model is read straight from its own config
    // file; Grok's is parsed from `grok models`' own "Default model:" line, same source
    // _checkCliStatus already trusts for Grok's login state.
    private async _getCliDefaultModels(): Promise<Record<string, string>> {
        const models: Record<string, string> = {};
        const os = await import('os');
        const fs = await import('fs');
        const path = await import('path');

        const [claudeOnPath, codexOnPath, grokOnPath] = await Promise.all([
            this._cliOnPath('claude'),
            this._cliOnPath('codex'),
            this._cliOnPath('grok'),
        ]);

        if (claudeOnPath) {
            models.claude = 'default';
        }

        if (codexOnPath) {
            try {
                const configPath = path.join(os.homedir(), '.codex', 'config.toml');
                const configContent = fs.readFileSync(configPath, 'utf-8');
                const modelMatch = configContent.match(/^model\s*=\s*"([^"]+)"/m);
                models.codex = modelMatch ? modelMatch[1] : 'default';
            } catch {
                models.codex = 'default';
            }
        }

        if (grokOnPath) {
            try {
                const { stdout } = await this._grokModels();
                const defaultMatch = stdout.match(/Default model:\s*(\S+)/i) || stdout.match(/^\s*[*-]\s*([\w.-]+)\s*\(default\)/m);
                models.grok = defaultMatch ? defaultMatch[1] : 'default';
            } catch {
                models.grok = 'default';
            }
        }

        return models;
    }

    private static readonly CLI_BIN: Record<string, string> = { openai: 'codex', anthropic: 'claude', xai: 'grok' };

    // Maps a review-result model key (the same normalizeModelKey() output the stdout parser
    // already produces - "gpt-4", "gpt-cli", "claude", "claude-cli", "grok", "grok-cli",
    // "ollama") to which settings key/kind actually needs fixing. This is a structural lookup
    // from an identifier the engine already prints (ai_council.py's "[!] MODEL ERROR" line
    // always names the real seat), not a guess from the wording of an error message - the
    // previous approach (detectCliAuthFailure) tried to recognize auth failures by matching
    // English phrases like "not logged in" against arbitrary process stderr, which silently
    // did nothing for any wording it didn't anticipate, any non-CLI seat, or any non-auth
    // failure (a missing API key, a bad Ollama URL) at all.
    private static readonly MODEL_KEY_TO_SEAT: Record<string, { key: string; kind: 'cli' | 'api' }> = {
        'gpt-4': { key: 'openai', kind: 'api' },
        'gpt-cli': { key: 'openai', kind: 'cli' },
        'claude': { key: 'anthropic', kind: 'api' },
        'claude-cli': { key: 'anthropic', kind: 'cli' },
        'grok': { key: 'xai', kind: 'api' },
        'grok-cli': { key: 'xai', kind: 'cli' },
        'gemini': { key: 'google', kind: 'api' },
        'ollama': { key: 'ollama', kind: 'api' },
    };

    // Identifies which seat a process failure actually belongs to using structural markers the
    // engine itself emits - never by guessing from the wording of an error message. Two real
    // signals: cli_transport.py's own "AUTH_REQUIRED:<cli>:<model>" tag (an explicit
    // machine-readable marker, not English text to pattern-match), and ai_council.py's
    // "[!] <MODEL> ERROR" line (the same structural marker parseModelProgressLine already
    // relies on for live progress). Either one names the real seat directly, so there's nothing
    // to infer.
    private static identifyFailedSeat(message: string): { key: string; kind: 'cli' | 'api' } | null {
        const authMatch = message.match(/AUTH_REQUIRED:([^:]+):/);
        if (authMatch) {
            const cliName = authMatch[1].replace(/\.cmd$/, '').replace(/\.exe$/, '').toLowerCase();
            const provider = (Object.keys(AiCouncilSidebarProvider.CLI_BIN) as (keyof typeof AiCouncilSidebarProvider.CLI_BIN)[])
                .find(p => AiCouncilSidebarProvider.CLI_BIN[p] === cliName);
            return provider ? { key: provider, kind: 'cli' } : null;
        }
        const modelErrorMatch = message.match(/\[!\]\s+([\w-]+)\s+ERROR/i);
        if (modelErrorMatch) {
            return AiCouncilSidebarProvider.MODEL_KEY_TO_SEAT[normalizeModelKey(modelErrorMatch[1])] || null;
        }
        return null;
    }

    // Shared error surface for every process failure in this file: identify the real seat via
    // identifyFailedSeat() when the message carries one of the structural markers above, and
    // give the exact right action for it (Log In for a CLI seat, Open Settings scoped to the
    // exact broken setting for an API/Ollama seat) - never a bare dismiss-only dialog, since an
    // error with no path forward is easy to miss and leaves the user to self-diagnose. When no
    // specific seat can be identified (a whole-process crash unrelated to any one seat, e.g.
    // "no workspace open"), "Open Settings" still opens the AI Council settings section as a
    // generic, always-correct fallback action rather than offering nothing.
    private async _showActionableError(message: string) {
        const seat = AiCouncilSidebarProvider.identifyFailedSeat(message);
        if (seat?.kind === 'cli') {
            const bin = AiCouncilSidebarProvider.CLI_BIN[seat.key];
            const result = await vscode.window.showErrorMessage(message, 'Log In');
            if (result === 'Log In' && bin) {
                const terminal = vscode.window.createTerminal(`${bin} Login`);
                terminal.show();
                terminal.sendText(`${bin} login`);
            }
            return;
        }
        const settingsTarget = seat?.kind === 'api'
            ? (seat.key === 'ollama' ? 'ai-council.ollamaUrl' : `ai-council.apiKeys.${seat.key}`)
            : 'ai-council';
        const result = await vscode.window.showErrorMessage(message, 'Open Settings');
        if (result === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', settingsTarget);
        }
    }

    // Minimal single-argument quoting for the shell:true spawns below - only ever fed fixed,
    // hardcoded subcommand literals ('auth', 'status', '--json', 'login', 'models', ...), never
    // user-controlled or file-derived text, so this only needs to survive that known, small set
    // of inputs safely rather than handle arbitrary content.
    private static quoteArg(value: string): string {
        return '"' + value.replace(/"/g, '\\"') + '"';
    }

    // One `grok models` per sidebar refresh - status check and default-model display used to
    // fire two cold-starts against the same leader socket and 5s-kill both.
    private async _grokModels(): Promise<{ code: number | null; stdout: string; stderr: string }> {
        if (this._grokModelsCache && Date.now() - this._grokModelsAt < 15000) {
            return this._grokModelsCache;
        }
        const result = await this._runCliCommand('grok', ['models']);
        this._grokModelsCache = result;
        this._grokModelsAt = Date.now();
        return result;
    }

    // Real login-state + active-model check per CLI, using each CLI's own status reporting -
    // no model picker: the extension always uses whatever model that login session actually
    // resolves to, and just surfaces it.
    private async _checkCliStatus(key: string): Promise<{ loggedIn: boolean; model?: string; detail?: string; error?: string }> {
        const bin = AiCouncilSidebarProvider.CLI_BIN[key];
        if (!bin) { return { loggedIn: false, error: 'Unknown CLI' }; }
        if (!(await this._cliOnPath(bin))) {
            return { loggedIn: false, error: `${bin} is not on PATH` };
        }

        const run = (args: string[]) => this._runCliCommand(bin, args);
        const timedOut = (code: number | null, stderr: string) =>
            code === -1 && /timed out/i.test(stderr || '');

        if (key === 'anthropic') {
            const { code, stdout, stderr } = await run(['auth', 'status', '--json']);
            if (timedOut(code, stderr)) {
                return { loggedIn: true, detail: 'status check timed out - leaving seat enabled' };
            }
            try {
                const parsed = JSON.parse(stdout);
                if (parsed.loggedIn) {
                    return { loggedIn: true, model: parsed.subscriptionType ? parsed.subscriptionType.toUpperCase() : undefined, detail: parsed.email };
                }
                return { loggedIn: false, error: 'Not logged in' };
            } catch {
                return { loggedIn: false, error: (stderr || stdout || `exit ${code}`).substring(0, 200) };
            }
        }

        if (key === 'openai') {
            // codex writes its status line to stderr, not stdout - verified directly.
            const { code, stdout, stderr } = await run(['login', 'status']);
            if (timedOut(code, stderr)) {
                return { loggedIn: true, detail: 'status check timed out - leaving seat enabled' };
            }
            const combined = `${stdout}${stderr}`;
            if (code === 0 && /logged in/i.test(combined)) {
                return { loggedIn: true, detail: combined.trim() };
            }
            return { loggedIn: false, error: (combined || `exit ${code}`).substring(0, 200) };
        }

        // xai (grok): a real "(default)" model entry + exit 0 is the actual proof of being
        // logged in - the first line's wording isn't stable ("You are using XAI_API_KEY."
        // instead of "You are logged in..." when that env var is set, e.g. Grok API also
        // enabled), so match on the model list, not a specific sentence.
        const { code, stdout, stderr } = await this._grokModels();
        if (timedOut(code, stderr)) {
            // Cold-start leader missed the window - that is not a logout. Leave the seat on.
            return { loggedIn: true, detail: 'status check timed out - leaving seat enabled' };
        }
        if (code !== 0 || !stdout.trim()) {
            return { loggedIn: false, error: (stderr || 'grok models returned no output').substring(0, 200) };
        }
        const defaultMatch = stdout.match(/^\s*[*-]\s*([\w.-]+)\s*\(default\)/m);
        if (!defaultMatch) {
            // No real model list came back despite exit 0 - genuinely not logged in/configured,
            // whatever the first line happened to say.
            return { loggedIn: false, error: stdout.trim().split('\n')[0] || 'Not logged in' };
        }
        return { loggedIn: true, model: defaultMatch[1] };
    }

    // silent=true skips the interruptive popup (used for restoreToggles' bulk re-validation of
    // every seat that was enabled last session - a dialog per restored seat on every panel
    // open/reload would be far more intrusive than the single deliberate click this popup was
    // designed for). The toggle is still unchecked either way, and _sendApiKeyStatus's own
    // status labels (already refreshed right after this in the restoreToggles flow) explain
    // why - so a silently-invalid restored seat still becomes visibly unchecked with a reason
    // next to it, never a seat that's actually enabled but non-functional with no signal at all.
    private async _checkApiKey(modelId: string, name: string, key: string, url: string, free?: boolean, kind?: string, silent?: boolean) {
        const config = vscode.workspace.getConfiguration('ai-council');
        const seatKind = kind || 'api';

        if (seatKind === 'cli') {
            const status = await this._checkCliStatus(key);
            if (!status.loggedIn) {
                const bin = AiCouncilSidebarProvider.CLI_BIN[key];
                if (!silent) {
                    const result = await vscode.window.showWarningMessage(
                        `${name}: ${status.error || 'not logged in'}`,
                        'Log In'
                    );
                    if (result === 'Log In' && bin) {
                        const terminal = vscode.window.createTerminal(`${name} Login`);
                        terminal.show();
                        terminal.sendText(`${bin} login`);
                    }
                }
                this._view?.webview.postMessage({ type: 'uncheckModel', modelId });
            }
            return;
        }

        // Ollama's "key" (apiKeys.ollama) is the auth credential, not the endpoint - a toggle
        // can pass the credential check below while ai-council.ollamaUrl is still empty, which
        // silently launches the Ollama reviewer pointed at nothing (confirmed live: the engine
        // logs "Ollama reviewer enabled (model @ )" with a blank URL and no error at all, no
        // popup, nothing telling the user to configure it). Check the URL explicitly here so
        // this toggle gets the same actionable treatment every other seat's precondition does.
        if (key === 'ollama') {
            const ollamaUrl = config.get<string>('ollamaUrl') || '';
            if (!ollamaUrl.trim()) {
                if (!silent) {
                    const result = await vscode.window.showWarningMessage(
                        `${name} needs a server URL (ai-council.ollamaUrl) - reviews using this seat will silently do nothing without it`,
                        'Open Settings'
                    );
                    if (result === 'Open Settings') {
                        vscode.commands.executeCommand('workbench.action.openSettings', 'ai-council.ollamaUrl');
                    }
                }
                this._view?.webview.postMessage({ type: 'uncheckModel', modelId });
                return;
            }
        }

        const settingsKey = config.get<string>(`apiKeys.${key}`) || '';
        const hasKey = Boolean(settingsKey.trim());

        if (!hasKey) {
            if (!silent) {
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
                timeout: 15000
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
        const modelKeys = ['openai', 'anthropic', 'xai', 'google'];
        const keyStatus: Record<string, boolean> = {};
        const orgInfo: Record<string, string | null> = {};
        const seatMeta: Record<string, string> = {};

        for (const key of modelKeys) {
            const settingsKey = config.get<string>(`apiKeys.${key}`) || '';
            keyStatus[key] = Boolean(settingsKey.trim());
            seatMeta[key] = keyStatus[key] ? 'api' : 'missing';
        }

        const cliActiveModels: Record<string, string> = {};
        const cliErrors: Record<string, string> = {};
        for (const [statusKey, key] of [['openai-cli', 'openai'], ['anthropic-cli', 'anthropic'], ['xai-cli', 'xai']] as const) {
            const status = await this._checkCliStatus(key);
            keyStatus[statusKey] = status.loggedIn;
            seatMeta[statusKey] = status.loggedIn ? 'cli' : 'missing';
            if (status.loggedIn && (status.model || status.detail)) {
                cliActiveModels[key] = [status.model, status.detail].filter(Boolean).join(' - ');
            } else if (!status.loggedIn && status.error) {
                cliErrors[key] = status.error;
            }
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
                orgInfo: orgInfo,
                cliActiveModels,
                cliErrors
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

        .collapse-all-row {
            text-align: right;
            margin-bottom: 4px;
        }

        .collapse-all-link {
            font-size: 10px;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            user-select: none;
        }

        .collapse-all-link:hover {
            text-decoration: underline;
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

        /* The three flow-entry buttons (Review Current File / Review Current Commit /
           Review with Scope) and every sub-action button inside them now share one themed
           "primary" look, matching how .btn-secondary already uses --vscode-button-* tokens -
           they're distinguished by icon and label, not by an arbitrary per-flow hue, and they
           adapt to the user's VS Code color theme instead of a hardcoded brand gradient. */
        .btn-primary,
        .btn-commit,
        .btn-scoped {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .btn-primary:hover,
        .btn-commit:hover,
        .btn-scoped:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .btn-secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
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

        .power-mode-hint {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
            line-height: 1.4;
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

        .model-spinner.stopped {
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

        .scoped-session-item {
            padding: 8px;
            margin-bottom: 6px;
            border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
            border-radius: 4px;
            cursor: pointer;
        }

        .scoped-session-item:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .scoped-session-scope {
            font-size: 12px;
        }

        .scoped-session-meta {
            font-size: 10px;
            opacity: 0.7;
            margin-top: 2px;
        }

        #scopedResumedBanner {
            font-size: 11px;
            opacity: 0.85;
            margin: 6px 0;
            display: flex;
            align-items: center;
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

        .cli-active-model {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-left: 6px;
            font-style: italic;
            vertical-align: middle;
        }

        .cli-active-model.cli-error {
            color: var(--vscode-errorForeground);
            font-style: normal;
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

    <div class="collapse-all-row">
        <span class="collapse-all-link" id="collapseAllLink" onclick="collapseBothSections()">Collapse both</span>
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
                    <span class="toggle-label"><span class="model-name-text" data-standard="Ollama" data-power="Ollama">Ollama</span> <span class="model-badge badge-free">Self-hosted</span><span class="key-status" id="key-ollama" title="Ollama Server Status"></span></span>
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
                        <span class="toggle-label"><span class="model-name-text" data-standard="Claude API" data-power="Claude Fable 5.1 API">Claude API</span><span class="key-status" id="key-anthropic" title="API Key Status"></span></span>
                        <label class="toggle-switch claude">
                            <input type="checkbox" id="enableClaude">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                    <div class="toggle-item" id="toggle-enableGrok">
                        <span class="toggle-label"><span class="model-name-text" data-standard="Grok API" data-power="Grok-3 API">Grok API</span><span class="key-status" id="key-xai" title="API Key Status"></span></span>
                        <label class="toggle-switch grok">
                            <input type="checkbox" id="enableGrok">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                </div>

                <div class="section-title">&#128187; CLI SEATS (subscriptions)</div>
                <div style="font-size:10px;opacity:0.6;margin-bottom:4px;">Uses each CLI's own active login and model - configure those in the CLI itself.</div>
                <div class="toggle-group">
                    <div class="toggle-item" id="toggle-enableGptCli">
                        <span class="toggle-label"><span class="model-name-text" data-standard="Codex CLI" data-power="Codex CLI">Codex CLI</span><span class="cli-active-model" id="cli-model-openai"></span><span class="key-status" id="key-openai-cli" title="CLI Status"></span></span>
                        <label class="toggle-switch gpt">
                            <input type="checkbox" id="enableGptCli" checked>
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                    <div class="toggle-item" id="toggle-enableClaudeCli">
                        <span class="toggle-label"><span class="model-name-text" data-standard="Claude CLI" data-power="Claude CLI">Claude CLI</span><span class="cli-active-model" id="cli-model-anthropic"></span><span class="key-status" id="key-anthropic-cli" title="CLI Status"></span></span>
                        <label class="toggle-switch claude">
                            <input type="checkbox" id="enableClaudeCli" checked>
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                    <div class="toggle-item" id="toggle-enableGrokCli">
                        <span class="toggle-label"><span class="model-name-text" data-standard="Grok CLI" data-power="Grok CLI">Grok CLI</span><span class="cli-active-model" id="cli-model-xai"></span><span class="key-status" id="key-xai-cli" title="CLI Status"></span></span>
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
        <div class="collapsible-header" id="reviewOptionsHeader" onclick="toggleReviewOptions()">
            <span class="collapsible-title">&#9881; REVIEW OPTIONS</span>
            <span class="collapsible-arrow">&#9660;</span>
        </div>
        <div class="collapsible-content" id="reviewOptionsContent">
            <div class="toggle-group">
                <div class="power-mode-item" id="powerModeItem">
                    <div class="toggle-item">
                        <span class="toggle-label">&#9889; Power Mode</span>
                        <label class="toggle-switch power">
                            <input type="checkbox" id="powerMode">
                            <span class="toggle-slider"></span>
                        </label>
                    </div>
                    <div class="power-mode-hint">Use premium models (higher cost, better results) for API seats - GPT-4, Claude, Grok, Gemini - including in Debate and Consolidate. CLI and Ollama seats always use whatever model they're already configured with.</div>
                </div>
                <div class="toggle-item synthesizer-item">
                    <span class="toggle-label">&#9878; Council Verdict by</span>
                    <select id="synthesizerSelect" class="synthesizer-select">
                        <option value="auto">Auto (Best Available)</option>
                    </select>
                </div>
                <div class="toggle-item synthesizer-item">
                    <span class="toggle-label">&#128295; Fix Code with</span>
                    <select id="fixerSelect" class="synthesizer-select">
                    </select>
                </div>
                <div class="toggle-item synthesizer-item" id="arbiterSelectRow" style="display:none;">
                    <span class="toggle-label">&#9878; Arbiter</span>
                    <select id="arbiterSelect" class="synthesizer-select">
                        <option value="none">None</option>
                    </select>
                </div>
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
        <div id="scopedSessionsPanel" style="display:none;">
            <div style="font-size:11px;opacity:0.85;margin-bottom:6px;">Recent sessions for this file - pick one to continue, or start a new review below.</div>
            <div id="scopedSessionsList"></div>
        </div>
        <div id="scopedScopeInput">
            <div style="font-size:11px;opacity:0.85;margin-bottom:6px;">What should the council focus on?</div>
            <textarea id="scopedScopeText" placeholder="e.g. Review this based on how it handles concurrent access to the shared cache"></textarea>
            <button class="btn btn-primary" onclick="startScopedReview()">Start Scoped Review</button>
        </div>
        <div id="scopedResumedBanner" style="display:none;">
            <span id="scopedResumedText"></span>
            <button class="btn btn-secondary" onclick="startNewScopedReview()" style="margin-left:8px;">Start New Review</button>
        </div>
        <div id="scopedRounds"></div>

        <!-- Action buttons start disabled until setScopedSessionReady() confirms round 0 finished. Arbiter (if any) was already nominated before this round ran, via the always-visible Arbiter picker - nothing to choose here. -->
        <div id="debateStartRow" style="display:none;">
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
            <button class="btn btn-primary" onclick="runConsolidate()" id="consolidateBtn" style="display:none;" title="Debate already auto-consolidates - use this to discard that result and try again">&#8635; Re-consolidate</button>
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
        <button class="cancel-review-btn" id="cancelScopedBtn" onclick="cancelOperation()" style="display:none;">&#10006; Cancel</button>
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
            <button class="cancel-review-btn" id="cancelReviewBtn" onclick="cancelOperation()">
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
                        refreshSeatSelects();
                        const scopedPanel = document.getElementById('scopedReviewPanel');
                        if (scopedPanel && scopedPanel.style.display === 'block') {
                            refreshScopedPickers();
                        }
                        // A manual click is not itself an "error" signal (the user is
                        // deliberately choosing, not discovering a break) - only the
                        // nothing-enabled case applies here; a genuinely broken seat is caught
                        // by the apiKeyStatus handler instead, which runs independently of clicks.
                        checkModelSelectionAutoOpen(getEnabledSeats());
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

            // Council Verdict by / Fix Code with / Arbiter - these were never persisted at all
            // (reproduced: collapse the Review Options section, reopen it, every pick had
            // reverted to Auto/blank/None). Every actual user selection saves immediately; a
            // rebuild triggered by refreshSeatSelects (a seat toggle changing) does NOT go
            // through this listener at all since it sets .innerHTML/.value directly rather than
            // simulating a click, so a picker being repopulated never re-saves a value the user
            // didn't just choose.
            for (const id of ['synthesizerSelect', 'fixerSelect', 'arbiterSelect']) {
                const sel = document.getElementById(id);
                if (sel) {
                    sel.addEventListener('change', saveSeatSelections);
                }
            }

            // Tell extension we're ready to receive messages
            vscode.postMessage({ command: 'webviewReady' });
        })();

        function saveSeatSelections() {
            vscode.postMessage({
                command: 'saveSeatSelections',
                selections: {
                    synthesizerSelect: document.getElementById('synthesizerSelect')?.value || 'auto',
                    fixerSelect: document.getElementById('fixerSelect')?.value || '',
                    arbiterSelect: document.getElementById('arbiterSelect')?.value || 'none',
                }
            });
        }

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
                synthesizer: document.getElementById('synthesizerSelect').value,
                arbiter: document.getElementById('arbiterSelect')?.value || 'none'
            };
        }

        // Persisted, user-driven collapse for the two top sections. sectionCollapsed mirrors
        // what's currently shown (kept in sync by setSectionCollapsed, the only place that
        // touches both the DOM and this object) and is saved to globalState on every manual
        // toggle - but NOT on an auto-uncollapse (see setSectionCollapsed), so an error surfacing
        // the panel doesn't silently become the new default next time nothing is wrong.
        let sectionCollapsed = { modelSelection: false, reviewOptions: false };

        function setSectionCollapsed(key, headerId, contentId, collapsed, persist) {
            const header = document.getElementById(headerId);
            const content = document.getElementById(contentId);
            if (!header || !content) { return; }
            header.classList.toggle('collapsed', collapsed);
            content.classList.toggle('collapsed', collapsed);
            sectionCollapsed[key] = collapsed;
            if (persist) {
                vscode.postMessage({ command: 'saveSectionCollapsed', sections: sectionCollapsed });
            }
        }

        function toggleModelSelection() {
            setSectionCollapsed('modelSelection', 'modelSelectionHeader', 'modelSelectionContent', !sectionCollapsed.modelSelection, true);
        }

        function toggleReviewOptions() {
            setSectionCollapsed('reviewOptions', 'reviewOptionsHeader', 'reviewOptionsContent', !sectionCollapsed.reviewOptions, true);
        }

        function collapseBothSections() {
            setSectionCollapsed('modelSelection', 'modelSelectionHeader', 'modelSelectionContent', true, true);
            setSectionCollapsed('reviewOptions', 'reviewOptionsHeader', 'reviewOptionsContent', true, true);
        }

        // Model Selection auto-uncollapses whenever a seat the user had ON just showed broken
        // (no key / CLI not ready) or nothing at all is enabled - both are "the user needs to
        // look at this panel right now" states that a persisted collapse must not hide. This is
        // a forced un-collapse (persist=false): it does not overwrite the user's own saved
        // preference, so the section goes back to collapsed on its own once the error clears and
        // the panel is reopened, rather than the error permanently pinning it open.
        //
        // Takes previouslyEnabledSeats, a snapshot of getEnabledSeats() captured BEFORE
        // updateKeyStatus/updateCliActiveModels ran (see the apiKeyStatus handler) - by the time
        // this function runs, updateKeyStatus has already unchecked any seat it just found
        // broken, so re-reading getEnabledSeats() here would never see the very seat that broke
        // (it's no longer "enabled"). Checking every seat regardless of the user's intent would
        // be wrong too - a key the user simply never configured is not an error, it's normal, and
        // would falsely auto-open this panel forever. The snapshot is the one correct baseline:
        // "of the seats you had turned on a moment ago, is any of them now broken."
        function checkModelSelectionAutoOpen(previouslyEnabledSeats) {
            const anyEnabled = previouslyEnabledSeats.length > 0;
            const anyBroken = previouslyEnabledSeats.some(seatIsBroken);
            if ((!anyEnabled || anyBroken) && sectionCollapsed.modelSelection) {
                setSectionCollapsed('modelSelection', 'modelSelectionHeader', 'modelSelectionContent', false, false);
            }
        }

        // Review Options auto-uncollapses only when an error actually reaches one of ITS OWN
        // selections - i.e. the currently-picked synthesizer/fixer/arbiter seat (not "auto"/
        // "none") has gone broken - not for an unrelated seat error elsewhere that this section
        // has no stake in.
        function checkReviewOptionsAutoOpen() {
            const picks = [
                document.getElementById('synthesizerSelect')?.value,
                document.getElementById('fixerSelect')?.value,
                document.getElementById('arbiterSelect')?.value,
            ].filter(v => v && v !== 'auto' && v !== 'none');
            const affected = picks.some(seatIsBroken);
            if (affected && sectionCollapsed.reviewOptions) {
                setSectionCollapsed('reviewOptions', 'reviewOptionsHeader', 'reviewOptionsContent', false, false);
            }
        }

        // forcePowerMode overrides powerMode for THIS call only (e.g. the one-shot "Review
        // Current File (Power Mode)" command) - it must never check the checkbox or call
        // saveToggleStates(), or a single one-off invocation would silently turn Power Mode on
        // for every later review/debate/consolidate until the user notices and unchecks it.
        function runReview(forcePowerMode) {
            const config = getModelConfig();
            if (forcePowerMode) { config.powerMode = true; }
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
                // Only offer to resume when nothing is already loaded in this panel instance -
                // a webview reload (hidden/recreated sidebar) always starts with
                // currentScopedSessionId unset, which is exactly the case that needs recovery;
                // re-toggling the panel open/closed within the SAME still-alive webview must not
                // stomp on a session already on screen.
                if (!currentScopedSessionId) {
                    vscode.postMessage({ command: 'listScopedSessions' });
                }
            }
        }

        function renderScopedSessionsList(sessions) {
            const panel = document.getElementById('scopedSessionsPanel');
            const list = document.getElementById('scopedSessionsList');
            if (!sessions || sessions.length === 0) {
                panel.style.display = 'none';
                return;
            }
            list.innerHTML = sessions.map(s => {
                const when = s.created_at ? escapeHtml(s.created_at) : '';
                const roundsLabel = (s.max_round || 0) > 0 ? ('round ' + s.max_round) : 'round 0';
                // JSON.stringify wraps in double quotes, which would collide with this
                // attribute's own double-quote delimiter and truncate the onclick right at the
                // opening quote (reproduced live: clicking a session did nothing at all, because
                // the resulting markup was broken HTML, not a JS error). data-session-id (read
                // back in the delegated click handler below) sidesteps quoting entirely - no
                // string ever gets embedded inside an inline event-handler attribute.
                return '<div class="scoped-session-item" data-session-id="' + escapeHtml(s.session_id) + '">' +
                    '<div class="scoped-session-scope">' + escapeHtml(s.scope || '(no scope text)') + '</div>' +
                    '<div class="scoped-session-meta">' + when + ' - ' + roundsLabel + '</div>' +
                    '</div>';
            }).join('');
            panel.style.display = 'block';
        }

        // Delegated once on the (static) list container rather than re-bound per item on every
        // render - the container itself never gets replaced, only its innerHTML, which would
        // silently drop any listener attached directly to a .scoped-session-item element.
        document.getElementById('scopedSessionsList').addEventListener('click', (e) => {
            const item = e.target.closest('.scoped-session-item');
            if (item) { resumeScopedSession(item.dataset.sessionId); }
        });

        function resumeScopedSession(sessionId) {
            setScopedStatus('Loading session...');
            vscode.postMessage({ command: 'resumeScopedSession', sessionId: sessionId });
        }

        function startNewScopedReview() {
            currentScopedSessionId = null;
            currentScopedRoster = null;
            currentScopedArbiter = null;
            document.getElementById('scopedSessionsPanel').style.display = 'none';
            document.getElementById('scopedResumedBanner').style.display = 'none';
            document.getElementById('scopedScopeInput').style.display = 'block';
            document.getElementById('scopedScopeText').value = '';
            document.getElementById('scopedRounds').innerHTML = '';
            document.getElementById('debateSection').style.display = 'none';
            document.getElementById('debateRoundsContainer').innerHTML = '';
            document.getElementById('consolidatedSection').innerHTML = '';
            document.getElementById('scopedFollowup').style.display = 'none';
            setScopedSessionReady(false);
            setScopedStatus('');
        }

        // Rebuilds the panel from scoped-resume's snapshot using the SAME rendering functions a
        // live run uses (startScopedRound/updateScopedRoundProgress/finishScopedRound,
        // renderDebateRound, renderConsolidated) fed completed data instead of streamed progress
        // - one rendering path for both "just finished" and "reopened later," so they can't drift.
        function applyScopedResume(result) {
            document.getElementById('scopedSessionsPanel').style.display = 'none';
            document.getElementById('scopedScopeInput').style.display = 'none';
            document.getElementById('scopedRounds').innerHTML = '';
            document.getElementById('debateRoundsContainer').innerHTML = '';
            document.getElementById('consolidatedSection').innerHTML = '';

            document.getElementById('scopedResumedBanner').style.display = 'block';
            document.getElementById('scopedResumedText').textContent = 'Resumed: ' + (result.scope || '(no scope text)');

            currentScopedSessionId = result.session_id;
            currentScopedArbiter = result.arbiter || null;
            currentScopedRoster = Object.keys(result.latest_reviews || {});
            setScopedSessionReady(!!result.latest_reviews);
            document.getElementById('scopedFollowup').style.display = result.latest_reviews ? 'block' : 'none';

            const models = Object.keys(result.latest_reviews || {});
            if (models.length > 0) {
                const roundId = startScopedRound('Round ' + (result.rounds.filter(r => r.role === 'council').slice(-1)[0]?.round_num ?? 0) + ' (resumed)', models);
                for (const [model, review] of Object.entries(result.latest_reviews)) {
                    if (review && review.error) {
                        updateScopedRoundProgress(roundId, model, { error: review.error });
                    } else {
                        updateScopedRoundProgress(roundId, model, { score: review.quality_score || 0, issues: (review.issues || []).length });
                    }
                }
                finishScopedRound(roundId, result.latest_consensus || {}, result.report_path, result.latest_reviews);
            }

            if (result.debate_round) {
                document.getElementById('debateSection').style.display = 'block';
                renderDebateRound(result.debate_round);
            }
            if (result.consolidation && !result.consolidation.error) {
                renderConsolidated(result.consolidation);
            }
            setScopedStatus('');
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

        // Called when the backend rejects a round outright (e.g. the roster-mismatch preflight)
        // after scopedRoundStart already created cards and started the timer - without this,
        // an error result left the timer running forever and every card stuck on
        // "Analyzing... (Ns)", since scopedReviewResult/scopedFollowupResult's error branches
        // only set a status message and returned (reproduced: a rejected follow-up left its
        // round's cards ticking indefinitely with no visible failure).
        function failScopedRound(roundId, reason) {
            if (!roundId) { return; }
            stopScopedRoundTimer(roundId);
            const cardsContainer = document.getElementById(roundId + '-cards');
            if (!cardsContainer) { return; }
            cardsContainer.querySelectorAll('.model-card.reviewing').forEach(card => {
                const model = card.id.replace(roundId + '-card-', '');
                updateScopedRoundProgress(roundId, model, { error: reason });
            });
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
                // The live stdout parser only ever knows a plain "[!] MODEL ERROR" happened
                // (data.error === true, no detail text exists on that stdout line by design) -
                // reconcileScopedRoundCards calls back in with the REAL message once the round's
                // full JSON result is available, so a card that only ever showed the bare word
                // "Error" (with no way to find out what actually failed short of digging through
                // raw process output) now shows the real reason once it's known.
                if (status) {
                    if (typeof data.error === 'string' && data.error) {
                        status.textContent = data.error;
                        status.title = data.error;
                    } else {
                        status.textContent = 'Error';
                    }
                }
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
                if (!card) { continue; }
                // Also refresh cards already flipped to .error from a live "[!] MODEL ERROR"
                // line - that line used to carry no detail, so the card said only "Error"
                // and this skip left it that way even after JSON arrived with the real
                // timeout/auth message (reproduced: Grok CLI 240s timeout).
                const stillReviewing = card.classList.contains('reviewing');
                const needsErrorDetail = card.classList.contains('error') && review.error && typeof review.error === 'string';
                if (!stillReviewing && !needsErrorDetail) { continue; }
                if (review.error) {
                    updateScopedRoundProgress(roundId, model, { error: review.error });
                } else if (stillReviewing) {
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
                '</div>';
            if (consensus.synthesis_error) {
                // The seat reviews above are real and unaffected - only the extra grouping
                // call failed - so "Agreed: 0 / Unique: N" here would misleadingly read as a
                // real finding (no consensus) rather than what actually happened (grouping
                // itself couldn't run). Show that distinction instead of the normal counts.
                html += '<div class="summary-stats"><span class="stat-item" style="color:#ef4444;">' +
                    '&#9888; Consensus grouping failed: ' + escapeHtml(consensus.synthesis_error) +
                    '</span></div>';
            } else {
                html += '<div class="summary-stats">' +
                    '<span class="stat-item">Agreed: <span class="stat-value">' + (consensus.consensus_issues || []).length + '</span></span>' +
                    '<span class="stat-item">Unique: <span class="stat-value">' + (consensus.unique_insights || []).length + '</span></span>' +
                    '</div>';
            }
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

        // Shared by the Scope writer picker, Council Verdict, Fix Code with, and Arbiter
        // selects - all need "whichever seats are actually enabled right now," including
        // CLI/Ollama seats, not a hardcoded API-only list that can't reflect what a CLI-only
        // user can actually pick. placeholder (optional) is {value, label} for a leading
        // non-seat option - "auto" (best available) for Council Verdict/Fix Code, "none" (no
        // seat nominated) for Arbiter; they are NOT interchangeable values, only the same
        // dropdown mechanics, so this takes the exact option instead of a boolean that would
        // force every caller into the same one meaning.
        function populateSeatSelect(selectId, placeholder) {
            const sel = document.getElementById(selectId);
            if (!sel) return;
            const enabledSeats = getEnabledSeats();
            const previousValue = sel.value;

            let html = placeholder ? '<option value="' + placeholder.value + '">' + escapeHtml(placeholder.label) + '</option>' : '';
            html += enabledSeats.map(m => {
                const cfg = MODEL_DISPLAY[m] || { name: m };
                return '<option value="' + m + '">' + escapeHtml(cfg.name) + '</option>';
            }).join('');
            sel.innerHTML = html;

            const stillValid = placeholder && previousValue === placeholder.value ? true : enabledSeats.includes(previousValue);
            if (stillValid) {
                sel.value = previousValue;
            }
        }

        function populateScopedWriterOptions() {
            populateSeatSelect('scopedWriterSelect', null);
        }

        // Debate requires 3+ enabled seats (see run_debate_round in ai_council.py) to debate
        // with. Arbiter mode is no longer chosen here - the arbiter (if any) was nominated
        // back when Review with Scope started (Arbiter picker, always-visible section) and
        // is fixed for the session; debate just reads that back automatically.
        function setupDebateSection() {
            const enabledSeats = getEnabledSeats();
            const startRow = document.getElementById('debateStartRow');
            if (!startRow) return;
            startRow.style.display = enabledSeats.length < 3 ? 'none' : 'block';
        }

        // Refreshes both pickers - called when the Review with Scope panel opens and on
        // every seat toggle change while it may be open, so it never shows a stale seat list.
        function refreshScopedPickers() {
            populateScopedWriterOptions();
            setupDebateSection();
        }

        // Arbiter picker only makes sense with 4+ enabled seats: nominating one leaves it out
        // of reviewing, and Debate itself needs at least 3 seats left to actually debate with -
        // with exactly 3 enabled, nominating any of them as arbiter would leave only 2 to
        // debate, below run_debate_round's own minimum. Below 4, force it back to "none" rather
        // than leave a stale nomination the backend would reject as soon as Review with Scope
        // ran with too few reviewers.
        function refreshArbiterSelect() {
            const sel = document.getElementById('arbiterSelect');
            const row = document.getElementById('arbiterSelectRow');
            if (!sel || !row) return;
            const enabledSeats = getEnabledSeats();
            if (enabledSeats.length < 4) {
                sel.value = 'none';
                row.style.display = 'none';
                return;
            }
            row.style.display = '';
            populateSeatSelect('arbiterSelect', { value: 'none', label: 'None' });
        }

        // Council Verdict / Fix Code with / Arbiter - unlike the Scope-panel-only pickers
        // these are always visible (not gated on a panel being open), so they refresh on
        // every toggle change regardless.
        function refreshSeatSelects() {
            populateSeatSelect('synthesizerSelect', { value: 'auto', label: 'Auto (Best Available)' });
            populateSeatSelect('fixerSelect', null);
            refreshArbiterSelect();
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

        // Ticks elapsed seconds onto the status text so a long single call (e.g. Ollama's 600s timeout) doesn't read as a hang.
        let debateProgressTimer = null;
        let debateProgressBaseLabel = '';
        let debateProgressStartMs = 0;

        function setScopedCancelVisible(visible) {
            const btn = document.getElementById('cancelScopedBtn');
            if (btn) { btn.style.display = visible ? 'flex' : 'none'; }
        }

        function startDebateProgress(label) {
            stopDebateProgressTimer();
            debateProgressBaseLabel = label;
            debateProgressStartMs = Date.now();
            setScopedStatus(label + ' (0s)');
            setDebateButtonsDisabled(true);
            setScopedCancelVisible(true);
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

        // Ollama can take up to its 600s timeout to fail (OllamaReviewer.REQUEST_TIMEOUT_SECONDS
        // in ai_council.py) - warn up front so a long wait reads as known, not hung.
        function debateStartLabel(arbiter) {
            return arbiter === 'ollama'
                ? 'Debate round starting... (Ollama is arbiter - can take up to 10 min if slow)'
                : 'Debate round starting...';
        }

        // The arbiter (if any) was already nominated and excluded from reviewing back when
        // Review with Scope started (see the always-visible Arbiter picker) - run_debate_round
        // reads that persisted nomination itself, so nothing is sent from here. Uses
        // currentScopedArbiter (captured from round 0's REAL result), not the live picker
        // value - the user can change the picker after round 0 without it meaning anything for
        // this session, and the hint must name the arbiter debate will actually use, not
        // whatever the dropdown currently shows.
        function currentArbiterHint() {
            return currentScopedArbiter || null;
        }

        function startDebate() {
            if (!currentScopedSessionId) {
                setScopedStatus('Run the initial scoped review first.');
                return;
            }
            const mismatch = scopedRosterMismatchError();
            if (mismatch) {
                setScopedStatus(mismatch);
                return;
            }
            const config = getModelConfig();
            resetScopedTokenUsage();
            startDebateProgress(debateStartLabel(currentArbiterHint()));
            document.getElementById('debateSection').style.display = 'block';
            document.getElementById('debateRoundsContainer').innerHTML = '';
            document.getElementById('consolidatedSection').innerHTML = '';
            vscode.postMessage({ command: 'runDebate', sessionId: currentScopedSessionId, modelConfig: config });
        }

        function reconveneDebate() {
            if (!currentScopedSessionId) {
                setScopedStatus('Run the initial scoped review first.');
                return;
            }
            const mismatch = scopedRosterMismatchError();
            if (mismatch) {
                setScopedStatus(mismatch);
                return;
            }
            const config = getModelConfig();
            startDebateProgress(debateStartLabel(currentArbiterHint()));
            vscode.postMessage({ command: 'runDebate', sessionId: currentScopedSessionId, modelConfig: config });
        }

        function runConsolidate() {
            if (!currentScopedSessionId) {
                setScopedStatus('Run the initial scoped review first.');
                return;
            }
            const config = getModelConfig();
            startDebateProgress('Re-consolidating...');
            // Debate already auto-consolidates every round - this button exists only to discard
            // that cached result and roll a fresh one, so it must force, not just re-fetch the
            // same cached consolidation the round already produced.
            vscode.postMessage({ command: 'runConsolidate', sessionId: currentScopedSessionId, modelConfig: config, force: true });
        }

        // Running total across debate+consolidate; only startDebate() (round 1) resets it, so consolidation can't erase it.
        let scopedTokenUsageTotals = {};

        function resetScopedTokenUsage() {
            scopedTokenUsageTotals = {};
            const el = document.getElementById('debateTokenUsage');
            if (el) { el.innerHTML = ''; }
        }

        // Shared by renderTokenUsage (debate/consolidate's per-seat panel) and any one-off usage
        // display (finalize's single-writer status line) so "N in / M out (Xs)" can't drift into
        // two differently-worded formats for what is the same underlying usage shape everywhere
        // it appears (cluster/debate-position/arbiter/consolidate/finalize all attach it the
        // same way - see design-decisions.md).
        function formatUsage(u) {
            if (!u) { return ''; }
            // Accepts both shapes seen in practice: the raw per-call usage ai_council.py
            // attaches ({input_tokens, output_tokens, elapsed_seconds}, unknown expressed as
            // null fields) and renderTokenUsage's own running-total accumulator
            // ({unknown: true, elapsed_seconds}, once a null has made the total's token count
            // permanently unreliable).
            const text = (u.unknown || u.input_tokens == null || u.output_tokens == null || u.partial)
                ? 'usage not reported'
                : u.input_tokens + ' in / ' + u.output_tokens + ' out';
            const timeText = u.elapsed_seconds ? ' (' + u.elapsed_seconds.toFixed(1) + 's)' : '';
            return text + timeText;
        }

        function renderTokenUsage(tokenUsage) {
            const el = document.getElementById('debateTokenUsage');
            if (!el || !tokenUsage) { return; }
            for (const [model, u] of Object.entries(tokenUsage)) {
                const existing = scopedTokenUsageTotals[model];
                const unknown = u.input_tokens == null || u.output_tokens == null || u.partial;
                // elapsed_seconds is tracked separately from the token-known/unknown state - a
                // seat that never reports token usage (self-hosted Ollama) still made a real
                // call that took real time, and that's worth showing even when the token count
                // half of this line has to say "not reported."
                const priorElapsed = existing?.elapsed_seconds || 0;
                const elapsed_seconds = u.elapsed_seconds != null ? priorElapsed + u.elapsed_seconds : priorElapsed;
                if (unknown) {
                    // Sticky: once "not reported," a later real number doesn't erase that gap.
                    scopedTokenUsageTotals[model] = { unknown: true, elapsed_seconds };
                } else if (existing && !existing.unknown) {
                    scopedTokenUsageTotals[model] = {
                        input_tokens: existing.input_tokens + u.input_tokens,
                        output_tokens: existing.output_tokens + u.output_tokens,
                        elapsed_seconds,
                    };
                } else if (!existing) {
                    scopedTokenUsageTotals[model] = { input_tokens: u.input_tokens, output_tokens: u.output_tokens, elapsed_seconds };
                } else {
                    // existing is already marked unknown - token counts stay unknown per the
                    // stickiness above, but elapsed_seconds still accumulates.
                    scopedTokenUsageTotals[model] = { unknown: true, elapsed_seconds };
                }
            }
            el.innerHTML = Object.entries(scopedTokenUsageTotals).map(([model, u]) => {
                const cfg = MODEL_DISPLAY[model] || { name: model };
                return '<span>' + escapeHtml(cfg.name) + ': ' + formatUsage(u) + '</span>';
            }).join('');
        }

        // The sidebar is a status surface, not a reading surface - full per-model positions,
        // arbiter reasoning, and consolidated fix text belong in the HTML report (which
        // debate/consolidate always regenerate in full - design-decisions.md §12/§16), not
        // reproduced inline here. This renders only what's needed to see debate progressed and
        // to reach that report - counts and a consensus %, nothing anyone would call "reading."
        function renderDebateRound(result) {
            const container = document.getElementById('debateRoundsContainer');
            const div = document.createElement('div');
            div.className = 'debate-round';

            const modeLabel = result.mode === 'arbiter' ? 'Arbiter (' + escapeHtml(result.arbiter || '') + ')' : 'All-to-all';
            const clusterCount = (result.clusters || []).length;
            let html = '<div class="debate-round-header">Round ' + result.debate_round_num + ' - ' + modeLabel + '</div>';
            html += '<div class="scoped-session-meta">' + clusterCount + ' finding' + (clusterCount === 1 ? '' : 's') + ' debated - ' + result.consensus_pct + '% consensus</div>';

            // Click-safe: no inline onclick="..." with the path embedded - a Windows path can
            // contain characters that terminate that attribute early and break the button
            // (finishScopedRound hit exactly this; fixed there the same way).
            if (result.report_path) {
                html += '<button class="open-report-btn" id="debate-round-' + result.debate_round_num + '-open-report">&#128196; Open Full Report</button>';
            }

            div.innerHTML = html;
            container.appendChild(div);

            if (result.report_path) {
                const btn = document.getElementById('debate-round-' + result.debate_round_num + '-open-report');
                if (btn) { btn.addEventListener('click', () => openScopedReport(result.report_path)); }
            }

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
            const findingCount = (result.findings || []).length;
            const openCount = (result.open_questions || []).length;
            let html = '<div class="review-summary" style="display:block;margin-top:10px;">' +
                '<div class="summary-header"><span class="summary-title">Consolidated Review</span></div>' +
                '<div class="scoped-session-meta">' + findingCount + ' finding' + (findingCount === 1 ? '' : 's') +
                (openCount > 0 ? ', ' + openCount + ' open question' + (openCount === 1 ? '' : 's') : '') + '</div>';
            if (result.report_path) {
                html += '<button class="open-report-btn" id="consolidated-open-report">&#128196; Open Full Report</button>';
            }
            html += '</div>';

            el.innerHTML = html;

            if (result.report_path) {
                const btn = document.getElementById('consolidated-open-report');
                if (btn) { btn.addEventListener('click', () => openScopedReport(result.report_path)); }
            }

            renderTokenUsage(result.usage);
        }

        function startScopedReview() {
            const scope = document.getElementById('scopedScopeText').value.trim();
            if (!scope) {
                setScopedStatus('Enter a scope/request first.');
                return;
            }
            const config = getModelConfig();
            document.getElementById('scopedScopeInput').style.display = 'none';
            document.getElementById('scopedSessionsPanel').style.display = 'none';
            document.getElementById('scopedResumedBanner').style.display = 'none';
            document.getElementById('scopedRounds').innerHTML = '';
            setScopedStatus('');
            currentScopedSessionId = null;
            currentScopedRoster = null;
            currentScopedArbiter = null;
            setScopedSessionReady(false);
            setScopedCancelVisible(true);
            vscode.postMessage({ command: 'scopedReview', scope: scope, modelConfig: config });
        }

        // The backend still enables/disables reviewers strictly from live toggle state (an API
        // key can genuinely be removed, a CLI can genuinely log out, between rounds) - this
        // does not override that with the persisted roster, it CATCHES the case where the two
        // have silently diverged and tells the user, instead of letting a follow-up/debate spend
        // real calls on a roster the session was never actually run with, or silently lose a
        // seat round 0 had. Toggling the SAME set back on/off in the same session is fine and
        // passes; only a genuine mismatch blocks.
        function scopedRosterMismatchError() {
            if (!currentScopedRoster) { return null; }
            const enabledSeats = getEnabledSeats();
            const currentReviewing = currentScopedArbiter ? enabledSeats.filter(s => s !== currentScopedArbiter) : enabledSeats;
            const missing = currentScopedRoster.filter(s => !currentReviewing.includes(s));
            const added = currentReviewing.filter(s => !currentScopedRoster.includes(s));
            if (missing.length === 0 && added.length === 0) { return null; }
            let msg = 'The enabled seats have changed since this session started (round 0 ran with: ' + currentScopedRoster.join(', ') + ').';
            if (missing.length) { msg += ' Missing now: ' + missing.join(', ') + '.'; }
            if (added.length) { msg += ' Newly added: ' + added.join(', ') + ' (would not have participated in round 0).'; }
            msg += ' Restore the original seats, or start a new Review with Scope session.';
            return msg;
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
            const mismatch = scopedRosterMismatchError();
            if (mismatch) {
                setScopedStatus(mismatch);
                return;
            }
            const btn = document.querySelector('#scopedFollowup button.btn-primary');
            if (btn && btn.disabled) { return; } // already in flight - no double-submit
            if (btn) { btn.disabled = true; }
            const config = getModelConfig();
            setScopedStatus('Asking follow-up...');
            setScopedCancelVisible(true);
            // sessionArbiter is the round-0 PERSISTED arbiter (captured from its real result),
            // sent separately from modelConfig - modelConfig.arbiter is the live picker value,
            // which the user can change after round 0 without it meaning anything for this
            // session. Progress cards must be built from what the backend will ACTUALLY
            // exclude (the persisted arbiter), not from whatever the picker currently shows.
            vscode.postMessage({ command: 'scopedFollowup', sessionId: currentScopedSessionId, question: question, modelConfig: config, sessionArbiter: currentScopedArbiter });
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

        var pendingLoginCli = null;
        function showLoginPrompt(cliName) {
            pendingLoginCli = cliName;
            showConfirmModal(
                cliName.charAt(0).toUpperCase() + cliName.slice(1) + ' Login Required',
                'Your ' + cliName + ' CLI session has expired. Click below to open a terminal and re-authenticate.',
                'Open Terminal',
                function() {
                    vscode.postMessage({ command: 'openTerminal', cli: pendingLoginCli });
                }
            );
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
        let currentScopedSessionId = null;
        // The ACTUAL roster (reviewing seats) and arbiter round 0 ran with, captured from its
        // real result the moment it completes - not from live toggle/picker state, which the
        // user is free to change between rounds. A follow-up/debate must use what the SESSION
        // actually has, not what the UI currently shows, or a changed toggle/arbiter between
        // rounds creates a progress card for a seat that will never report (backend still
        // excludes/includes based on the ORIGINAL roster) and a debate hint naming the wrong
        // arbiter. Reset to null only when a genuinely NEW session starts (startScopedReview).
        let currentScopedRoster = null;
        let currentScopedArbiter = null;
        let currentScopedRoundId = null;
        // Live per-model elapsed seconds while cards are still "reviewing" - same pattern as
        // startScopedRound's per-round timer, so a still-"Analyzing..." card here shows how
        // long it's actually been running too, not just in Review with Scope.
        let reviewCardTimer = null;

        function stopReviewCardTimer() {
            if (reviewCardTimer) {
                clearInterval(reviewCardTimer);
                reviewCardTimer = null;
            }
        }

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

        function cancelOperation() {
            vscode.postMessage({ command: 'cancelOperation' });
        }

        function handleOperationCancelled() {
            // Checked first: Fix runs from a button inside an already-completed (still visible)
            // review panel, so the review-panel branch below would otherwise misreport a
            // cancelled Fix as a cancelled review.
            const fixBtn = document.getElementById('fixCodeBtn');
            if (fixBtn && fixBtn.disabled) {
                fixBtn.disabled = false;
                fixBtn.innerHTML = '&#128295; Fix with AI';
                return;
            }

            const reviewPanel = document.getElementById('reviewPanel');
            if (reviewPanel && reviewPanel.style.display === 'block') {
                stopReviewCardTimer();
                document.getElementById('reviewPanelIcon').innerHTML = '&#10006;';
                document.getElementById('reviewPanelTitle').textContent = 'Review Cancelled';
                const cancelBtn = document.getElementById('cancelReviewBtn');
                if (cancelBtn) cancelBtn.style.display = 'none';
                return;
            }

            if (currentScopedRoundId) {
                stopScopedRoundTimer(currentScopedRoundId);
            }
            stopDebateProgressTimer();
            setDebateButtonsDisabled(false);
            setScopedCancelVisible(false);
            setScopedStatus('Cancelled.');
            const followupBtn = document.querySelector('#scopedFollowup button.btn-primary');
            if (followupBtn) { followupBtn.disabled = false; }
            const finalizeBtn = document.getElementById('finalizeScopedBtn');
            if (finalizeBtn) { finalizeBtn.disabled = false; }
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

        // getEnabledSeats()/the Review Options dropdowns use these short seat names (gpt-4,
        // gpt-cli, ...); the toggle checkbox ids modelToKey/toggle-<id>/.no-key are keyed on
        // (enableGpt, ...) are a DIFFERENT naming scheme for the same seats. This is the one
        // missing link between the two - everything else a "is this seat broken" check needs
        // (the no-key class, cliErrors) is already reachable from the checkbox id.
        const SEAT_TO_TOGGLE_ID = {
            'gpt-4': 'enableGpt', 'claude': 'enableClaude', 'grok': 'enableGrok',
            'gpt-cli': 'enableGptCli', 'claude-cli': 'enableClaudeCli', 'grok-cli': 'enableGrokCli',
            'gemini': 'enableGemini', 'ollama': 'enableOllama',
        };

        // True if "seat" (a short seat name, e.g. "claude-cli") currently shows as broken: no
        // API key/URL configured (toggle-item.no-key, set by updateKeyStatus) or a CLI seat
        // reporting an error (cli-active-model.cli-error, set by updateCliActiveModels). Both
        // classes are applied directly to elements already in the DOM, so this reads live state
        // rather than needing its own parallel tracking of what updateKeyStatus/
        // updateCliActiveModels last received.
        function seatIsBroken(seat) {
            const toggleId = SEAT_TO_TOGGLE_ID[seat];
            if (!toggleId) { return false; }
            const toggleItem = document.getElementById('toggle-' + toggleId);
            if (toggleItem && toggleItem.classList.contains('no-key')) { return true; }
            const providerToId = { 'gpt-cli': 'cli-model-openai', 'claude-cli': 'cli-model-anthropic', 'grok-cli': 'cli-model-xai' };
            const cliElId = providerToId[seat];
            if (cliElId) {
                const cliEl = document.getElementById(cliElId);
                if (cliEl && cliEl.classList.contains('cli-error')) { return true; }
            }
            return false;
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

            stopReviewCardTimer();
            reviewCardTimer = setInterval(() => {
                const secs = Math.floor((Date.now() - reviewStartTime) / 1000);
                for (const m of models) {
                    const card = document.getElementById('card-' + m);
                    const status = document.getElementById('status-' + m);
                    if (card && status && card.classList.contains('reviewing')) {
                        status.textContent = 'Analyzing... (' + secs + 's)';
                    }
                }
            }, 1000);
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
                if (status) status.textContent = 'Error';
                if (spinner) spinner.outerHTML = '<div class="error-x">!</div>';
            } else {
                card.classList.add('complete');
                if (status) status.textContent = data.issues + ' issue' + (data.issues === 1 ? '' : 's') + ' found';
                if (spinner) spinner.outerHTML = '<div class="checkmark"></div>';

                // Show score
                if (scoreBadge) {
                    const score = data.score || 0;
                    scoreBadge.textContent = score + '/10';
                    scoreBadge.className = 'score-badge ' + scoreClass(score);
                    scoreBadge.style.display = 'inline-block';
                }
            }
        }

        function showReviewSummary(results) {
            stopReviewCardTimer();
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

            // First, mark any remaining "reviewing" cards as unknown/cached - scoped to this
            // panel's own cards. .model-card is shared with Review with Scope's round cards
            // (same visual vocabulary, deliberately), so an unscoped query here would also
            // retitle any scoped-review round still in flight in the same webview.
            const reviewingCards = document.querySelectorAll('#modelCardsContainer .model-card.reviewing');
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
                    status.textContent = 'No response';
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
                    if (spinner) spinner.classList.add('stopped');
                }
                if (status) {
                    if (data.error) {
                        var errStr = typeof data.error === 'string' ? data.error : '';
                        if (errStr.indexOf('AUTH_REQUIRED') >= 0) {
                            var cliName = errStr.split(':')[1] || 'cli';
                            var link = document.createElement('a');
                            link.href = '#';
                            link.textContent = 'Login Required';
                            link.style.color = '#f59e0b';
                            link.style.textDecoration = 'underline';
                            link.style.cursor = 'pointer';
                            link.onclick = function(e) { e.preventDefault(); showLoginPrompt(cliName); };
                            status.textContent = '';
                            status.appendChild(link);
                        } else if (errStr) {
                            // Same real text updateScopedRoundProgress/the HTML report already
                            // show (a CLI timeout, an incomplete-stub rejection, a parse
                            // failure) - this was the one remaining surface still collapsing it
                            // to the bare word "Error", the exact gap that hid the Grok 240s
                            // timeout behind a generic red card on the DEFAULT review button.
                            // Clickable, same as the AUTH_REQUIRED case above - routes through
                            // the extension host's _showActionableError (this webview script
                            // cannot call vscode.window/commands itself), which identifies the
                            // real seat from structural markers and offers Log In / Open
                            // Settings, never leaving the click as a dead end.
                            var errLink = document.createElement('a');
                            errLink.href = '#';
                            errLink.textContent = errStr;
                            errLink.title = errStr;
                            errLink.style.color = '#ef4444';
                            errLink.style.textDecoration = 'underline';
                            errLink.style.cursor = 'pointer';
                            errLink.onclick = function(e) {
                                e.preventDefault();
                                // Must match identifyFailedSeat's "[!] MODEL ERROR" structural
                                // marker exactly (the same shape ai_council.py prints to
                                // stdout) so the extension host can actually identify which
                                // seat this is, not just show the text again.
                                vscode.postMessage({ command: 'showActionableError', message: 'AI Council: [!] ' + model.toUpperCase() + ' ERROR - ' + errStr });
                            };
                            status.textContent = '';
                            status.appendChild(errLink);
                        } else {
                            status.textContent = 'Error';
                            status.style.color = '#ef4444';
                        }
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
                            : (isCli ? 'CLI not ready - not on PATH or not logged in' : 'API Key Missing - Click toggle to configure');
                    } else {
                        indicator.title = hasKey
                            ? (isCli ? 'CLI ready (subscription)' : 'API Key Configured')
                            : (isCli ? 'CLI not ready - not on PATH or not logged in' : 'API Key Missing - Click toggle to configure');
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

        // Shows each CLI seat's actual resolved model/account (or the reason it's not ready)
        // next to its toggle - no picker, this is purely informational.
        function updateCliActiveModels(cliActiveModels, cliErrors) {
            const providerToId = { openai: 'cli-model-openai', anthropic: 'cli-model-anthropic', xai: 'cli-model-xai' };
            for (const [provider, elementId] of Object.entries(providerToId)) {
                const el = document.getElementById(elementId);
                if (!el) { continue; }
                const model = cliActiveModels && cliActiveModels[provider];
                const error = cliErrors && cliErrors[provider];
                if (model) {
                    el.textContent = model;
                    el.classList.remove('cli-error');
                    el.title = '';
                } else if (error) {
                    el.textContent = error;
                    el.classList.add('cli-error');
                    el.title = error;
                } else {
                    el.textContent = '';
                    el.classList.remove('cli-error');
                }
            }
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
                case 'apiKeyStatus': {
                    // Both auto-open checks need to know what was true BEFORE this status update
                    // mutates the DOM (updateKeyStatus unchecks a broken seat's checkbox;
                    // refreshSeatSelects then reads that to repopulate the dropdowns, silently
                    // resetting any selection that pointed at the seat that just broke) - so the
                    // snapshot is taken first, and both checks run against it/before the reset.
                    const previouslyEnabledSeats = getEnabledSeats();
                    checkReviewOptionsAutoOpen();
                    updateKeyStatus(message.status, message.orgInfo);
                    updateCliActiveModels(message.cliActiveModels, message.cliErrors);
                    checkModelSelectionAutoOpen(previouslyEnabledSeats);
                    // updateKeyStatus can programmatically uncheck a now-broken seat's checkbox
                    // (checkbox.checked = false) - that does NOT fire a 'change' event, so the
                    // toggle listener that would normally call refreshSeatSelects() never runs,
                    // leaving Council Verdict/Fix Code/Arbiter possibly still showing a seat
                    // that's no longer enabled at all (reproduced: a key removed while a seat
                    // was selected as fixer left the stale seat in the dropdown indefinitely).
                    // Re-running it here, after both status functions have updated the DOM,
                    // covers that gap the same way a real toggle click already does.
                    refreshSeatSelects();
                    break;
                }
                case 'scopedSessionsList':
                    // A missing reviews.db / missing scoped_reviews table is NOT an error -
                    // session_query.py returns {"sessions": []} for both, since "no sessions
                    // exist yet" is the normal state for a workspace that's never run a scoped
                    // review. A genuine failure (corrupt db, permissions) still sets
                    // message.error - surface that rather than silently rendering as if there
                    // were simply no sessions, which is what happened before session_query.py's
                    // read-only/missing-file fix (an uncaught crash resolved as an error the
                    // sidebar then discarded entirely).
                    if (message.error) {
                        setScopedStatus('Could not load session list: ' + message.error);
                    }
                    renderScopedSessionsList(message.sessions);
                    break;
                case 'scopedResumeResult':
                    if (message.error) {
                        setScopedStatus('Error loading session: ' + message.error);
                        break;
                    }
                    applyScopedResume(message.result);
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
                    setScopedCancelVisible(false);
                    if (message.error) {
                        setScopedStatus('Error: ' + message.error);
                        document.getElementById('scopedScopeInput').style.display = 'block';
                        failScopedRound(currentScopedRoundId, message.error);
                        currentScopedRoundId = null;
                        break;
                    }
                    currentScopedSessionId = message.result.session_id;
                    // Capture the roster/arbiter round 0 ACTUALLY ran with, only on round 0's
                    // real completion (not overwritten by a later follow-up's result, which
                    // reviews the SAME fixed roster again, not a new one) - see the declaration
                    // comment above for why this must not be re-derived from live UI state later.
                    if (!currentScopedRoster) {
                        currentScopedRoster = Object.keys(message.result.reviews || {});
                        currentScopedArbiter = message.result.arbiter || null;
                    }
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
                    setScopedCancelVisible(false);
                    if (message.error) {
                        setScopedStatus('Error: ' + message.error);
                        failScopedRound(currentScopedRoundId, message.error);
                        currentScopedRoundId = null;
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
                    const finalizeUsage = message.result.usage && message.result.usage[actualWriter];
                    const finalizeUsageNote = finalizeUsage ? ' [' + formatUsage(finalizeUsage) + ']' : '';
                    setScopedStatus('Review doc written by ' + actualWriter.toUpperCase() + substitutionNote + finalizeUsageNote + ': ' + message.result.output_path);
                    vscode.postMessage({ command: 'openReviewDoc', path: message.result.output_path });
                    break;
                }
                case 'debateProgress':
                    updateDebateProgressLabel(message.text);
                    break;
                case 'debateResult':
                    stopDebateProgressTimer();
                    setDebateButtonsDisabled(false);
                    setScopedCancelVisible(false);
                    if (message.error) {
                        setScopedStatus('Error: ' + message.error);
                        break;
                    }
                    renderDebateRound(message.result);
                    // ai_council.py's debate command now auto-runs consolidate_debate right
                    // after the round and includes it as message.result.consolidation - render
                    // it the same way a standalone Consolidate click would, so the one Debate
                    // button drives the same visible outcome as debate-then-consolidate used to
                    // take two clicks to reach.
                    if (message.result.consolidation && !message.result.consolidation.error) {
                        renderConsolidated(message.result.consolidation);
                    }
                    setScopedStatus('');
                    break;
                case 'consolidateResult':
                    stopDebateProgressTimer();
                    setDebateButtonsDisabled(false);
                    setScopedCancelVisible(false);
                    if (message.error) {
                        setScopedStatus('Error: ' + message.error);
                        break;
                    }
                    renderConsolidated(message.result);
                    setScopedStatus(message.result.cached ? 'Showing cached consolidation.' : '');
                    break;
                case 'uncheckModel':
                    // Setting .checked programmatically does NOT fire a 'change' event, so the
                    // toggle listener's saveToggleStates()/refreshSeatSelects()/
                    // refreshScopedPickers() never ran for this - the checkbox visually
                    // unchecked, but globalState (saved eagerly the moment the toggle was first
                    // switched on, before validation could fail) still had the rejected seat as
                    // enabled. Reopening the sidebar then restored it as checked, silently, with
                    // no re-validation (reproduced: an invalid seat was live in the same
                    // globalState the checkbox visually disagreed with). Do explicitly what a
                    // real 'change' to unchecked would have done.
                    const checkbox = document.getElementById(message.modelId);
                    if (checkbox) {
                        checkbox.checked = false;
                    }
                    saveToggleStates();
                    refreshSeatSelects();
                    const uncheckScopedPanel = document.getElementById('scopedReviewPanel');
                    if (uncheckScopedPanel && uncheckScopedPanel.style.display === 'block') {
                        refreshScopedPickers();
                    }
                    break;
                case 'cacheSize':
                    const label = document.getElementById('cacheSizeLabel');
                    if (label) {
                        label.textContent = message.size ? ' (' + message.size + ')' : '';
                    }
                    break;
                case 'invokeAction':
                    // Command-palette/editor-title/context-menu entry points land here so they
                    // drive the exact same functions the sidebar's own buttons call.
                    if (message.action === 'review') {
                        runReview();
                    } else if (message.action === 'reviewPower') {
                        runReview(true);
                    } else if (message.action === 'reviewCommit') {
                        reviewCommit();
                    } else if (message.action === 'reviewWithScope') {
                        const panel = document.getElementById('scopedReviewPanel');
                        if (panel && panel.style.display !== 'block') {
                            toggleScopedReviewPanel();
                        }
                        const scopeText = document.getElementById('scopedScopeText');
                        if (scopeText) { scopeText.focus(); }
                    } else if (message.action === 'clearCache') {
                        clearCache();
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
                        refreshSeatSelects();
                        // A toggle restored as checked was never re-validated - .checked
                        // assignment above doesn't fire 'change', so _checkApiKey (the check
                        // that runs on an actual click) never ran for it. A key deleted or a
                        // CLI logged out since last session would otherwise sit enabled with
                        // nothing telling the user - the seat gets silently omitted from the
                        // council instead of running. Re-check every restored-enabled seat now,
                        // quietly (no popup per seat on every panel load - that would be its
                        // own kind of annoying); an invalid one still gets unchecked, and
                        // _sendApiKeyStatus's own status labels (already sent for this same
                        // refresh) explain why.
                        for (const [toggleId, cfg] of Object.entries(modelApiKeys)) {
                            const toggleEl = document.getElementById(toggleId);
                            if (toggleEl && toggleEl.checked) {
                                vscode.postMessage({ command: 'checkApiKey', modelId: toggleId, silent: true, ...cfg });
                            }
                        }
                    }
                    break;
                case 'restoreSeatSelections':
                    // Runs after 'restoreToggles' (webviewReady sends both, in order, and each
                    // message is handled synchronously before the next arrives) - restoreToggles
                    // already called refreshSeatSelects(), so all three <select>s are already
                    // populated from the restored roster by the time this applies the saved
                    // VALUE on top of that populated list. Only applies a saved value that is
                    // still a real option (the seat may have been removed/disabled since it was
                    // last saved) - falling through to whatever populateSeatSelect already
                    // defaulted to (Auto / blank / None) otherwise, same as a live session
                    // would if that seat simply isn't available.
                    if (message.selections) {
                        for (const id of ['synthesizerSelect', 'fixerSelect', 'arbiterSelect']) {
                            const sel = document.getElementById(id);
                            const saved = message.selections[id];
                            if (sel && saved && Array.from(sel.options).some(o => o.value === saved)) {
                                sel.value = saved;
                            }
                        }
                    }
                    break;
                case 'restoreSectionCollapsed':
                    // Applied WITHOUT persist (persist=false) - this is restoring what was
                    // already saved, not a new user action to save again. The per-seat re-checks
                    // just queued above (checkApiKey silent:true) will each eventually produce an
                    // apiKeyStatus message, which is what actually runs
                    // checkModelSelectionAutoOpen/checkReviewOptionsAutoOpen - so a section
                    // restored as collapsed can still immediately pop back open if something is
                    // genuinely wrong, rather than requiring the user to notice and expand it.
                    if (message.sections) {
                        setSectionCollapsed('modelSelection', 'modelSelectionHeader', 'modelSelectionContent', !!message.sections.modelSelection, false);
                        setSectionCollapsed('reviewOptions', 'reviewOptionsHeader', 'reviewOptionsContent', !!message.sections.reviewOptions, false);
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
                                orgEntries.push('<div class="status-row"><span class="status-label" style="color:#10a37f;">OpenAI:</span><span class="status-value">' + escapeHtml(message.orgInfo.openai) + '</span></div>');
                            }
                            if (message.orgInfo.anthropic) {
                                orgEntries.push('<div class="status-row"><span class="status-label" style="color:#d97706;">Anthropic:</span><span class="status-value">' + escapeHtml(message.orgInfo.anthropic) + '</span></div>');
                            }
                            if (message.orgInfo.xai) {
                                orgEntries.push('<div class="status-row"><span class="status-label" style="color:#1da1f2;">xAI:</span><span class="status-value">' + escapeHtml(message.orgInfo.xai) + '</span></div>');
                            }
                            if (orgEntries.length > 0) {
                                orgHtml = '<div class="status-section-title">Accounts</div>' + orgEntries.join('');
                            }
                        }

                        // Build CLI models HTML if available. These values come from a local CLI's
                        // own config file / stdout (not remote input), but are escaped like every
                        // other dynamic value written into this panel - a local config/CLI-output
                        // source is still an untrusted string as far as innerHTML is concerned.
                        var cliHtml = '';
                        if (message.cliModels) {
                            var cliEntries = [];
                            if (message.cliModels.claude) {
                                cliEntries.push('<div class="status-row"><span class="status-label" style="color:#d97706;">Claude CLI:</span><span class="status-value">' + escapeHtml(message.cliModels.claude) + '</span></div>');
                            }
                            if (message.cliModels.codex) {
                                cliEntries.push('<div class="status-row"><span class="status-label" style="color:#10a37f;">Codex CLI:</span><span class="status-value">' + escapeHtml(message.cliModels.codex) + '</span></div>');
                            }
                            if (message.cliModels.grok) {
                                cliEntries.push('<div class="status-row"><span class="status-label" style="color:#1da1f2;">Grok CLI:</span><span class="status-value">' + escapeHtml(message.cliModels.grok) + '</span></div>');
                            }
                            if (cliEntries.length > 0) {
                                cliHtml = '<div class="status-section-title">CLI Models</div>' + cliEntries.join('');
                            }
                        }

                        // Restore the panel content structure FIRST
                        document.getElementById('statusPanelContent').innerHTML =
                            orgHtml +
                            cliHtml +
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
                case 'operationCancelled':
                    handleOperationCancelled();
                    break;
                case 'reviewFailed':
                    stopReviewCardTimer();
                    document.getElementById('reviewPanelIcon').innerHTML = '&#9888;';
                    document.getElementById('reviewPanelTitle').textContent = 'Review Failed';
                    document.getElementById('reviewPanelTitle').style.color = '#ef4444';
                    var failCancelBtn = document.getElementById('cancelReviewBtn');
                    if (failCancelBtn) failCancelBtn.style.display = 'none';
                    // Mark all models as failed and stop animations - scoped to this panel's
                    // own cards, same reasoning as the reviewComplete handler above.
                    var cards = document.querySelectorAll('#modelCardsContainer .model-card');
                    cards.forEach(function(card) {
                        var status = card.querySelector('.model-status');
                        var spinner = card.querySelector('.model-spinner');
                        if (status) {
                            status.textContent = 'Failed';
                            status.style.color = '#ef4444';
                        }
                        if (spinner) spinner.style.display = 'none';
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
