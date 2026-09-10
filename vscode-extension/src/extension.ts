import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { AiCouncilSidebarProvider } from './sidePanel';

// Store for review results and diagnostics
let reviewResults: Map<string, ReviewResult> = new Map();
let diagnosticCollection: vscode.DiagnosticCollection;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let sidebarProvider: AiCouncilSidebarProvider;

interface ReviewIssue {
    severity: string;
    line: number | null;
    description: string;
    recommendation: string;
}

interface ModelReview {
    model: string;
    score: number;
    issues: ReviewIssue[];
    tokenUsage?: {
        input: number;
        output: number;
        cost: number;
    };
}

interface ReviewResult {
    filePath: string;
    timestamp: Date;
    reviews: ModelReview[];
    consensusIssues: ReviewIssue[];
    totalCost: number;
}

export function activate(context: vscode.ExtensionContext) {
    console.log('AI Council extension is now active');

    // Create output channel for logs
    outputChannel = vscode.window.createOutputChannel('AI Council');

    // Create diagnostics collection for inline hints
    diagnosticCollection = vscode.languages.createDiagnosticCollection('ai-council');
    context.subscriptions.push(diagnosticCollection);

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'ai-council.showLastReview';
    context.subscriptions.push(statusBarItem);

    // Register sidebar provider
    sidebarProvider = new AiCouncilSidebarProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('ai-council.sidebar', sidebarProvider)
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('ai-council.reviewFile', () => reviewFile(false)),
        vscode.commands.registerCommand('ai-council.reviewFilePower', () => reviewFile(true)),
        vscode.commands.registerCommand('ai-council.showLastReview', showLastReview),
        vscode.commands.registerCommand('ai-council.clearCache', clearCache)
    );

    // Auto-review on save (if enabled)
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((document) => {
            const config = vscode.workspace.getConfiguration('ai-council');
            if (config.get('autoReviewOnSave')) {
                reviewFileByPath(document.uri.fsPath, false);
            }
        })
    );

    outputChannel.appendLine('AI Council extension activated');
}

async function reviewFile(powerMode: boolean) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No file is currently open');
        return;
    }

    const filePath = editor.document.uri.fsPath;
    await reviewFileByPath(filePath, powerMode);
}

async function reviewFileByPath(filePath: string, powerMode: boolean) {
    const config = vscode.workspace.getConfiguration('ai-council');
    const pythonPath = config.get<string>('pythonPath') || 'python';
    let scriptPath = config.get<string>('scriptPath');

    // Default script path
    if (!scriptPath) {
        // Try common locations
        const possiblePaths = [
            'C:/AI COUNCIL/ai_council.py',
            path.join(process.env.HOME || '', 'ai-council', 'ai_council.py'),
            path.join(__dirname, '..', '..', 'ai_council.py')
        ];

        for (const p of possiblePaths) {
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(p));
                scriptPath = p;
                break;
            } catch {
                // Path doesn't exist, try next
            }
        }

        if (!scriptPath) {
            vscode.window.showErrorMessage(
                'AI Council script not found. Please set the path in settings (ai-council.scriptPath)'
            );
            return;
        }
    }

    const includeGemini = config.get<boolean>('includeGemini');
    const fileName = path.basename(filePath);

    // Show progress
    const modeText = powerMode ? 'Power Mode' : 'Standard';
    outputChannel.show(true);
    outputChannel.appendLine('');
    outputChannel.appendLine('='.repeat(60));
    outputChannel.appendLine(`  AI Council Review: ${fileName}`);
    outputChannel.appendLine(`  Mode: ${modeText}`);
    outputChannel.appendLine('='.repeat(60));

    // Update status bar
    statusBarItem.text = '$(sync~spin) AI Council: Reviewing...';
    statusBarItem.show();

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `AI Council: Reviewing ${fileName}`,
        cancellable: true
    }, async (progress, token) => {
        return new Promise<void>((resolve, reject) => {
            // Quote paths with spaces for shell execution
            const quotedScript = `"${scriptPath!}"`;
            const quotedFile = `"${filePath}"`;
            const cmdArgs = [quotedScript, 'review', quotedFile];
            if (powerMode) {
                cmdArgs.push('--power');
            }
            if (includeGemini) {
                cmdArgs.push('--gemini');
            }

            const process = spawn(pythonPath, cmdArgs, {
                env: { ...globalThis.process.env },
                shell: true
            });

            let stdout = '';
            let stderr = '';

            process.stdout?.on('data', (data: Buffer) => {
                const text = data.toString();
                stdout += text;
                outputChannel.append(text);

                // Parse progress updates
                if (text.includes('[+]')) {
                    const match = text.match(/\[(\d+)\/(\d+)\]/);
                    if (match) {
                        const current = parseInt(match[1]);
                        const total = parseInt(match[2]);
                        progress.report({
                            increment: (100 / total),
                            message: `Model ${current}/${total} complete`
                        });
                    }
                }
            });

            process.stderr?.on('data', (data: Buffer) => {
                stderr += data.toString();
                outputChannel.append(data.toString());
            });

            token.onCancellationRequested(() => {
                process.kill();
                reject(new Error('Review cancelled'));
            });

            process.on('close', (code: number | null) => {
                if (code === 0) {
                    parseAndDisplayResults(filePath, stdout);
                    resolve();
                } else {
                    vscode.window.showErrorMessage(`AI Council review failed: ${stderr || 'Unknown error'}`);
                    reject(new Error(stderr || 'Review failed'));
                }

                statusBarItem.text = '$(check) AI Council: Ready';
            });

            process.on('error', (err: Error) => {
                vscode.window.showErrorMessage(`Failed to run AI Council: ${err.message}`);
                reject(err);
                statusBarItem.text = '$(error) AI Council: Error';
            });
        });
    });
}

function parseAndDisplayResults(filePath: string, output: string) {
    const config = vscode.workspace.getConfiguration('ai-council');
    const showInlineHints = config.get<boolean>('showInlineHints');

    // Parse the output to extract results
    const result: ReviewResult = {
        filePath,
        timestamp: new Date(),
        reviews: [],
        consensusIssues: [],
        totalCost: 0
    };

    // Parse model scores
    const scoreMatches = output.matchAll(/\[(\w+)\]\s+Score:\s+(\d+)\/10/g);
    for (const match of scoreMatches) {
        result.reviews.push({
            model: match[1],
            score: parseInt(match[2]),
            issues: []
        });
    }

    // Parse token usage
    const costMatch = output.match(/TOTAL.*\(~\$(\d+\.\d+)\)/);
    if (costMatch) {
        result.totalCost = parseFloat(costMatch[1]);
    }

    // Store result
    reviewResults.set(filePath, result);

    // Show inline diagnostics if enabled
    if (showInlineHints) {
        updateDiagnostics(filePath, result);
    }

    // Show summary notification
    const avgScore = result.reviews.length > 0
        ? (result.reviews.reduce((sum, r) => sum + r.score, 0) / result.reviews.length).toFixed(1)
        : 'N/A';

    vscode.window.showInformationMessage(
        `AI Council: ${path.basename(filePath)} - Avg Score: ${avgScore}/10 | Cost: ~$${result.totalCost.toFixed(4)}`,
        'Show Details',
        'Show in HTML'
    ).then(selection => {
        if (selection === 'Show Details') {
            outputChannel.show();
        } else if (selection === 'Show in HTML') {
            // Run with --html flag and open report
            runWithHtml(filePath);
        }
    });

    // Update status bar
    statusBarItem.text = `$(check) AI Council: ${avgScore}/10`;
    statusBarItem.tooltip = `Last review: ${path.basename(filePath)}\nClick to show details`;
}

async function runWithHtml(filePath: string) {
    const config = vscode.workspace.getConfiguration('ai-council');
    const pythonPath = config.get<string>('pythonPath') || 'python';
    const scriptPath = config.get<string>('scriptPath') || 'C:/AI COUNCIL/ai_council.py';

    // Quote paths with spaces for shell execution
    const process = spawn(pythonPath, [`"${scriptPath}"`, 'review', `"${filePath}"`, '--html'], {
        env: { ...globalThis.process.env },
        shell: true
    });

    let stdout = '';

    process.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
    });

    process.on('close', () => {
        // Find the HTML report path in output
        const match = stdout.match(/HTML Report:\s*(.+\.html)/i);
        if (match) {
            const htmlPath = match[1].trim();
            vscode.env.openExternal(vscode.Uri.file(htmlPath));
        }
    });
}

function updateDiagnostics(filePath: string, result: ReviewResult) {
    const uri = vscode.Uri.file(filePath);
    const diagnostics: vscode.Diagnostic[] = [];

    // Parse issues from output and create diagnostics
    // This is a simplified version - real implementation would parse the full output
    for (const review of result.reviews) {
        for (const issue of review.issues) {
            if (issue.line !== null && issue.line > 0) {
                const range = new vscode.Range(
                    new vscode.Position(issue.line - 1, 0),
                    new vscode.Position(issue.line - 1, 1000)
                );

                const severity = mapSeverity(issue.severity);
                const diagnostic = new vscode.Diagnostic(
                    range,
                    `[${review.model}] ${issue.description}`,
                    severity
                );
                diagnostic.source = 'AI Council';
                diagnostic.code = review.model;
                diagnostics.push(diagnostic);
            }
        }
    }

    diagnosticCollection.set(uri, diagnostics);
}

function mapSeverity(severity: string): vscode.DiagnosticSeverity {
    switch (severity.toLowerCase()) {
        case 'critical':
        case 'high':
            return vscode.DiagnosticSeverity.Error;
        case 'medium':
            return vscode.DiagnosticSeverity.Warning;
        case 'low':
            return vscode.DiagnosticSeverity.Information;
        default:
            return vscode.DiagnosticSeverity.Hint;
    }
}

async function showLastReview() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        outputChannel.show();
        return;
    }

    const filePath = editor.document.uri.fsPath;
    const result = reviewResults.get(filePath);

    if (result) {
        // Show webview with results
        const panel = vscode.window.createWebviewPanel(
            'aiCouncilReview',
            `AI Council: ${path.basename(filePath)}`,
            vscode.ViewColumn.Beside,
            { enableScripts: true }
        );

        panel.webview.html = generateReviewHtml(result);
    } else {
        outputChannel.show();
    }
}

function generateReviewHtml(result: ReviewResult): string {
    const fileName = path.basename(result.filePath);
    const avgScore = result.reviews.length > 0
        ? (result.reviews.reduce((sum, r) => sum + r.score, 0) / result.reviews.length).toFixed(1)
        : 'N/A';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Council Review</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 20px;
            margin: 0;
        }
        h1 {
            color: var(--vscode-textLink-foreground);
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 10px;
        }
        .summary {
            display: flex;
            gap: 20px;
            margin: 20px 0;
        }
        .score-card {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 8px;
            padding: 15px;
            text-align: center;
            min-width: 100px;
        }
        .score {
            font-size: 2em;
            font-weight: bold;
            color: var(--vscode-textLink-foreground);
        }
        .model-name {
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
            margin-top: 5px;
        }
        .cost {
            margin-top: 20px;
            padding: 10px;
            background: var(--vscode-inputValidation-infoBackground);
            border-radius: 4px;
        }
    </style>
</head>
<body>
    <h1>AI Council Review: ${fileName}</h1>

    <div class="summary">
        ${result.reviews.map(r => `
            <div class="score-card">
                <div class="score">${r.score}/10</div>
                <div class="model-name">${r.model}</div>
            </div>
        `).join('')}
        <div class="score-card">
            <div class="score">${avgScore}/10</div>
            <div class="model-name">Average</div>
        </div>
    </div>

    <div class="cost">
        Total Cost: ~$${result.totalCost.toFixed(4)}
    </div>

    <p style="color: var(--vscode-descriptionForeground);">
        Reviewed: ${result.timestamp.toLocaleString()}
    </p>
</body>
</html>`;
}

async function clearCache() {
    const config = vscode.workspace.getConfiguration('ai-council');
    const pythonPath = config.get<string>('pythonPath') || 'python';
    const scriptPath = config.get<string>('scriptPath') || 'C:/AI COUNCIL/ai_council.py';

    // Clear in-memory cache
    reviewResults.clear();
    diagnosticCollection.clear();

    vscode.window.showInformationMessage('AI Council cache cleared');
}

export function deactivate() {
    if (diagnosticCollection) {
        diagnosticCollection.dispose();
    }
    if (outputChannel) {
        outputChannel.dispose();
    }
    if (statusBarItem) {
        statusBarItem.dispose();
    }
}
