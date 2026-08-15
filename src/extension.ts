import * as vscode from 'vscode';
import { ReaderState } from './state';
import { ReaderSidebar } from './sidebar';
import { makeCommands } from './commands';

export function activate(context: vscode.ExtensionContext): void {
  const state = new ReaderState(context);
  const sidebar = new ReaderSidebar(context);
  const commands = makeCommands(state, sidebar);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ReaderSidebar.viewType, sidebar),
    vscode.commands.registerCommand('zhihu.openFeed', commands.openFeed),
    vscode.commands.registerCommand('zhihu.importCookie', commands.importCookie),
    vscode.commands.registerCommand('zhihu.clearCookie', commands.clearCookie),
    vscode.commands.registerCommand('zhihu.openOriginal', commands.openOriginal),
    vscode.commands.registerCommand('zhihu.loadComments', commands.loadComments),
    vscode.commands.registerCommand('zhihu.loadMoreComments', commands.loadMoreComments),
    vscode.commands.registerCommand('zhihu.next', commands.next),
    vscode.commands.registerCommand('zhihu.prev', commands.prev),
    vscode.commands.registerCommand('zhihu.refresh', commands.refresh),
    vscode.commands.registerCommand('zhihu.openQuestion', commands.openQuestion),
    vscode.commands.registerCommand('zhihu.backToFeed', commands.backToFeed),
    vscode.commands.registerCommand('zhihu.chooseSidebarPosition', commands.chooseSidebarPosition),
    vscode.commands.registerCommand('zhihu.close', commands.close)
  );

  // 监听配置变化，动态调整请求间隔
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('zhihuReader.requestIntervalMs')) {
        state.refreshInterval();
      }
    })
  );
}

export function deactivate(): void {
  /* nothing to clean up */
}
