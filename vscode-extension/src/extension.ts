import * as vscode from 'vscode';
import { AiCouncilSidebarProvider, SUPPORTED_REVIEW_EXTENSIONS } from './sidePanel';

let sidebarProvider: AiCouncilSidebarProvider;

export function activate(context: vscode.ExtensionContext) {
    console.log('AI Council extension is now active');

    sidebarProvider = new AiCouncilSidebarProvider(context.extensionUri, context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('ai-council.sidebar', sidebarProvider)
    );

    // Every command below focuses the sidebar and asks its webview to run the same function
    // its own buttons call - one implementation of each review flow (the sidebar's), not a
    // second independent one per entry point. This also means these commands don't need an
    // active editor check of their own: the sidebar's own runReview()/reviewCommit() already
    // validate that and show the same warning either way.
    //
    // reviewFile takes an optional resourceUri: VS Code passes the clicked file as the first
    // argument when a command is invoked from a context menu (editor/context, explorer/context)
    // but passes nothing from the command palette or editor/title - so this reviews the clicked
    // Explorer resource when there is one, and falls back to activeTextEditor (via
    // triggerAction) exactly as before for every other invocation path.
    context.subscriptions.push(
        vscode.commands.registerCommand('ai-council.reviewFile', (resourceUri?: vscode.Uri) => {
            if (resourceUri instanceof vscode.Uri) {
                return sidebarProvider.reviewExplorerResource(resourceUri.fsPath);
            }
            return sidebarProvider.triggerAction('review');
        }),
        vscode.commands.registerCommand('ai-council.reviewFilePower', () => sidebarProvider.triggerAction('reviewPower')),
        vscode.commands.registerCommand('ai-council.reviewCommit', () => sidebarProvider.triggerAction('reviewCommit')),
        vscode.commands.registerCommand('ai-council.reviewWithScope', () => sidebarProvider.triggerAction('reviewWithScope')),
        vscode.commands.registerCommand('ai-council.showLastReview', () => sidebarProvider.showLastReport()),
        vscode.commands.registerCommand('ai-council.clearCache', () => sidebarProvider.triggerAction('clearCache'))
    );

    // Auto-review on save (if enabled) - reviews the saved document by explicit path via
    // runAutoReviewOnSave(), never activeTextEditor, so a background/auto-formatted save can't
    // steal editor focus or the sidebar's focus just to pick a file, and can't review whatever
    // happens to be active instead of what was actually saved. Only real source files - a
    // README.md or package.json save shouldn't launch a full multi-seat review.
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((document) => {
            if (document.uri.scheme !== 'file') { return; }
            const lower = document.uri.fsPath.toLowerCase();
            if (!SUPPORTED_REVIEW_EXTENSIONS.some(ext => lower.endsWith(ext))) { return; }
            const config = vscode.workspace.getConfiguration('ai-council');
            if (config.get('autoReviewOnSave')) {
                sidebarProvider.runAutoReviewOnSave(document.uri.fsPath);
            }
        })
    );
}

export function deactivate() {
}
