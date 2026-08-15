import * as vscode from 'vscode';
import { feedItemToMarkdown, ZhihuFeedItem } from './converter';
import { htmlToMarkdown } from './html2md';
import { QuestionContext } from './state';
import { CommentPage } from './fetcher';

type SidebarMessage =
  | { type: 'welcome' }
  | { type: 'loading'; text: string }
  | { type: 'error'; text: string; action: 'refresh' | 'importCookie' }
  | { type: 'notice'; text: string; tone: 'info' | 'error' }
  | { type: 'commentsLoading' }
  | { type: 'commentsError'; text: string }
  | {
      type: 'comments';
      append: boolean;
      source: CommentPage['source'];
      hasMore: boolean;
      items: Array<{
        id: string;
        content: string;
        authorName: string;
        authorHeadline: string;
        replyToName: string;
        createdTime?: number;
        voteCount: number;
        childCommentCount: number;
      }>;
    }
  | {
      type: 'item';
      item: {
        title: string;
        meta: string[];
        content: string;
        kind: string;
        index: number;
        total: number;
        canOpenQuestion: boolean;
        canLoadComments: boolean;
        commentCount: number;
        url?: string;
        question?: QuestionContext;
      };
    };

interface WebviewMessage {
  action?: string;
  text?: unknown;
}

export class ReaderSidebar implements vscode.WebviewViewProvider {
  static readonly viewType = 'zhihuReader.sidebar';

  private view: vscode.WebviewView | undefined;
  private latest: SidebarMessage = { type: 'welcome' };

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };
    view.webview.html = this.html(view.webview);

    this.ctx.subscriptions.push(
      view.webview.onDidReceiveMessage((message: WebviewMessage) => {
        switch (message.action) {
          case 'ready':
            this.post(this.latest);
            break;
          case 'next':
            void vscode.commands.executeCommand('zhihu.next');
            break;
          case 'prev':
            void vscode.commands.executeCommand('zhihu.prev');
            break;
          case 'refresh':
            void vscode.commands.executeCommand('zhihu.refresh');
            break;
          case 'importCookie':
            void vscode.commands.executeCommand('zhihu.importCookie');
            break;
          case 'clearCookie':
            void vscode.commands.executeCommand('zhihu.clearCookie');
            break;
          case 'openQuestion':
            void vscode.commands.executeCommand('zhihu.openQuestion');
            break;
          case 'backToFeed':
            void vscode.commands.executeCommand('zhihu.backToFeed');
            break;
          case 'openOriginal':
            void vscode.commands.executeCommand('zhihu.openOriginal');
            break;
          case 'loadComments':
            void vscode.commands.executeCommand('zhihu.loadComments');
            break;
          case 'loadMoreComments':
            void vscode.commands.executeCommand('zhihu.loadMoreComments');
            break;
          case 'copyText':
            if (typeof message.text === 'string' && message.text.length <= 200_000) {
              void vscode.env.clipboard.writeText(message.text);
            }
            break;
        }
      }),
      view.onDidDispose(() => {
        if (this.view === view) this.view = undefined;
      })
    );
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.zhihu-reader');
    this.view?.show(false);
  }

  showItem(
    item: ZhihuFeedItem,
    index: number,
    total: number,
    question: QuestionContext | null,
    canOpenQuestion: boolean
  ): void {
    const doc = feedItemToMarkdown(item);
    this.latest = {
      type: 'item',
      item: {
        title: doc.title,
        meta: doc.meta
          .map(stripMarkdownLink)
          .filter((value, index) => !(doc.kind === 'answer' && index === 0 && value === '回答')),
        content: doc.content,
        kind: doc.kind,
        index,
        total,
        canOpenQuestion,
        canLoadComments: item.target?.type === 'answer' && stateSafeNumericId(item.target.id),
        commentCount: Number.isFinite(item.target?.comment_count)
          ? Math.max(0, Math.trunc(item.target?.comment_count ?? 0))
          : 0,
        url: doc.url,
        question: question ? {
          ...question,
          detail: htmlToMarkdown(question.detail, { imagePlaceholder: '' }),
        } : undefined,
      },
    };
    this.post(this.latest);
  }

  showLoading(text: string): void {
    this.latest = { type: 'loading', text };
    this.post(this.latest);
  }

  showWelcome(): void {
    this.latest = { type: 'welcome' };
    this.post(this.latest);
  }

  showError(text: string, action: 'refresh' | 'importCookie' = 'refresh'): void {
    this.latest = { type: 'error', text, action };
    this.post(this.latest);
  }

  showNotice(text: string, tone: 'info' | 'error' = 'info'): void {
    this.post({ type: 'notice', text, tone });
  }

  showCommentsLoading(): void {
    this.post({ type: 'commentsLoading' });
  }

  showCommentsError(text: string): void {
    this.post({ type: 'commentsError', text });
  }

  showComments(page: CommentPage, append: boolean): void {
    this.post({
      type: 'comments',
      append,
      source: page.source,
      hasMore: Boolean(page.next),
      items: page.items.map((item) => ({
        id: String(item.id),
        content: htmlToMarkdown(item.content, { imagePlaceholder: '' }),
        authorName: item.authorName,
        authorHeadline: item.authorHeadline,
        replyToName: item.replyToName,
        createdTime: item.createdTime,
        voteCount: item.voteCount,
        childCommentCount: item.childCommentCount,
      })),
    });
  }

  private post(message: SidebarMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    :root {
      color-scheme: light dark;
      --reader-font-size: 14px;
      --reader-line-height: 1.78;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      overflow: hidden;
    }
    button { font: inherit; }
    button:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .app { position: relative; height: 100%; display: grid; grid-template-rows: auto minmax(0, 1fr); }
    .progress { position: absolute; z-index: 8; top: 0; left: 0; width: 0; height: 2px; background: var(--vscode-descriptionForeground, #8a8a8a); opacity: .48; transition: width .1s linear; }
    .topbar {
      min-height: 43px;
      padding: 8px 8px 8px 10px;
      display: flex;
      align-items: center;
      gap: 6px;
      border-bottom: 1px solid var(--vscode-sideBar-border, transparent);
    }
    .brand { display: flex; align-items: center; gap: 7px; font-weight: 600; min-width: 0; }
    .brand-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--vscode-descriptionForeground); opacity: .65; }
    .dot.connected { background: #2da44e; opacity: 1; box-shadow: 0 0 0 3px color-mix(in srgb, #2da44e 18%, transparent); }
    .dot.pending { background: #d29922; opacity: 1; }
    .dot.error { background: #f85149; opacity: 1; }
    .top-actions { margin-left: auto; display: flex; align-items: center; gap: 2px; }
    .position { color: var(--vscode-descriptionForeground); font-size: 11px; white-space: nowrap; margin-right: 2px; }
    .icon-button {
      min-width: 28px;
      height: 28px;
      padding: 0 6px;
      border: 1px solid transparent;
      border-radius: 5px;
      color: var(--vscode-foreground);
      background: transparent;
      cursor: pointer;
    }
    .icon-button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .back { font-size: 16px; }
    .display-panel {
      position: absolute;
      z-index: 12;
      top: 46px;
      right: 6px;
      width: min(272px, calc(100% - 12px));
      padding: 8px;
      border: 1px solid var(--vscode-widget-border, #555);
      border-radius: 7px;
      background: var(--vscode-menu-background, var(--vscode-sideBar-background, #1e1e1e));
      box-shadow: 0 6px 22px color-mix(in srgb, black 30%, transparent);
    }
    .display-panel[hidden] { display: none; }
    .display-panel-head { min-height: 25px; display: flex; align-items: center; gap: 6px; margin-bottom: 7px; }
    .display-controls { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
    .display-label { color: var(--vscode-descriptionForeground); font-size: 11px; margin-right: auto; white-space: nowrap; }
    .display-close { width: 25px; min-width: 25px; padding: 0; border: 0; background: transparent; }
    .small-button {
      min-width: 30px;
      height: 26px;
      padding: 0 7px;
      border: 1px solid var(--vscode-button-border, var(--vscode-widget-border));
      border-radius: 5px;
      color: var(--vscode-foreground);
      background: var(--vscode-button-secondaryBackground);
      cursor: pointer;
    }
    .small-button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .comment-drawer {
      position: absolute;
      z-index: 11;
      top: 43px;
      right: 0;
      bottom: 0;
      width: 100%;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      border-top: 1px solid var(--vscode-sideBar-border, var(--vscode-widget-border));
      background: var(--vscode-sideBar-background, #1e1e1e);
      box-shadow: -8px 0 24px color-mix(in srgb, black 24%, transparent);
    }
    .comment-drawer[hidden] { display: none; }
    .comment-head { min-height: 43px; display: flex; align-items: center; gap: 8px; padding: 7px 8px 7px 12px; border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-widget-border)); }
    .comment-title { font-weight: 600; }
    .comment-close { width: 28px; min-width: 28px; margin-left: auto; padding: 0; border: 0; background: transparent; }
    .comment-list { overflow-y: auto; padding: 4px 12px 18px; }
    .comment-card { padding: 12px 0; border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-widget-border)); }
    .comment-author { font-size: 12px; font-weight: 600; }
    .comment-headline { margin-top: 2px; color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 1.45; }
    .comment-content { margin-top: 7px; font-size: 13px; line-height: 1.68; word-break: break-word; }
    .comment-content p { margin: 0 0 7px; }
    .comment-meta { margin-top: 7px; display: flex; flex-wrap: wrap; gap: 9px; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .comment-empty { min-height: 45vh; display: grid; place-items: center; padding: 24px; color: var(--vscode-descriptionForeground); text-align: center; line-height: 1.65; }
    .comment-footer { padding: 8px 12px 10px; border-top: 1px solid var(--vscode-sideBar-border, var(--vscode-widget-border)); }
    .comment-more { width: 100%; }
    .meta-row { min-height: 28px; display: flex; align-items: center; gap: 8px; margin-bottom: 13px; }
    .comment-action {
      min-width: 40px;
      height: 26px;
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 0 6px;
      border: 1px solid var(--vscode-widget-border, #484c55);
      border-radius: 5px;
      color: var(--vscode-descriptionForeground, #b0b0b0);
      background: var(--vscode-button-secondaryBackground, rgba(127, 127, 127, .055));
      cursor: pointer;
    }
    .comment-action:hover { color: var(--vscode-foreground, #eeeeee); background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, .16)); border-color: var(--vscode-focusBorder, #777); }
    .comment-icon { width: 14px; height: 14px; display: block; overflow: visible; }
    .comment-count { font-size: 11px; line-height: 1; }
    #viewport { position: relative; overflow-y: auto; overscroll-behavior: contain; scroll-behavior: smooth; }
    #screen { min-height: 100%; padding: 16px 12px 32px; }
    .article { animation: enter .18s ease-out; }
    @keyframes enter { from { opacity: .35; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    .meta { min-width: 0; flex: 1; display: flex; align-items: center; flex-wrap: nowrap; gap: 8px; overflow: hidden; }
    .chip {
      color: var(--vscode-descriptionForeground);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 11px;
      line-height: 18px;
    }
    h1 { font-size: calc(var(--reader-font-size) + 5px); line-height: 1.42; margin: 0 0 18px; letter-spacing: -.15px; }
    .content { font-size: var(--reader-font-size); line-height: var(--reader-line-height); word-break: break-word; }
    .content p { margin: 0 0 13px; }
    .content h2, .content h3, .content h4, .content h5 { margin: 20px 0 10px; line-height: 1.45; }
    .content h2 { font-size: calc(var(--reader-font-size) + 3px); }
    .content h3, .content h4, .content h5 { font-size: calc(var(--reader-font-size) + 1px); }
    .content blockquote { margin: 12px 0; padding: 5px 0 5px 12px; color: var(--vscode-descriptionForeground); border-left: 3px solid var(--vscode-textBlockQuote-border); }
    .content blockquote p:last-child { margin-bottom: 0; }
    .content code.inline { padding: 1px 4px; border-radius: 4px; color: var(--vscode-textPreformat-foreground); background: var(--vscode-textPreformat-background); font-family: var(--vscode-editor-font-family); font-size: .9em; }
    .content .link-text { color: var(--vscode-textLink-foreground); text-decoration: underline; text-decoration-style: dotted; }
    .content .list-row { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px; margin: 3px 0; padding-left: calc(var(--depth, 0) * 16px); }
    .content .list-marker { color: #1772f6; min-width: 13px; text-align: right; }
    .content hr { border: 0; border-top: 1px solid var(--vscode-sideBar-border, var(--vscode-widget-border)); margin: 18px 0; }
    .code-block { margin: 13px 0; border: 1px solid var(--vscode-widget-border); border-radius: 7px; overflow: hidden; background: var(--vscode-textCodeBlock-background); }
    .code-head { min-height: 28px; padding: 3px 5px 3px 9px; display: flex; align-items: center; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-widget-border); font-size: 11px; }
    .copy-code { margin-left: auto; border: 0; border-radius: 4px; padding: 3px 7px; color: inherit; background: transparent; cursor: pointer; }
    .copy-code:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
    .code-block pre { margin: 0; overflow-x: auto; padding: 11px; font-family: var(--vscode-editor-font-family); font-size: 12px; line-height: 1.55; white-space: pre; }
    .table-wrap { margin: 13px 0; overflow-x: auto; border: 1px solid var(--vscode-widget-border); border-radius: 6px; }
    .content table { width: 100%; border-collapse: collapse; font-size: .94em; }
    .content th, .content td { padding: 7px 9px; border-right: 1px solid var(--vscode-widget-border); border-bottom: 1px solid var(--vscode-widget-border); text-align: left; vertical-align: top; }
    .content th { background: color-mix(in srgb, var(--vscode-foreground) 7%, transparent); }
    .content tr:last-child td { border-bottom: 0; }
    .content th:last-child, .content td:last-child { border-right: 0; }
    .question-box { margin-bottom: 18px; padding-bottom: 16px; border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-widget-border)); }
    .question-box h1 { margin-bottom: 10px; }
    .question-detail { color: var(--vscode-descriptionForeground); font-size: calc(var(--reader-font-size) - 1px); line-height: var(--reader-line-height); }
    .answer-label { margin: 0 0 10px; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .4px; }
    .open-question { width: 100%; margin-top: 18px; padding: 9px 10px; border: 1px solid var(--vscode-button-border, var(--vscode-widget-border)); border-radius: 7px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    .open-question:hover { background: var(--vscode-button-hoverBackground); }
    .empty { min-height: 55vh; display: grid; place-items: center; text-align: center; color: var(--vscode-descriptionForeground); padding: 24px; }
    .empty-card { max-width: 270px; }
    .empty-icon { width: 42px; height: 42px; display: grid; place-items: center; margin: 0 auto 14px; border-radius: 12px; color: white; background: #1772f6; font-weight: 700; font-size: 18px; }
    .empty h2 { color: var(--vscode-foreground); font-size: 16px; margin: 0 0 8px; }
    .empty p { line-height: 1.65; margin: 0 0 15px; }
    .empty .hint { font-size: 11px; }
    .button-row { display: flex; justify-content: center; flex-wrap: wrap; gap: 7px; }
    .primary, .secondary { border-radius: 5px; padding: 7px 12px; cursor: pointer; }
    .primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; }
    .primary:hover { background: var(--vscode-button-hoverBackground); }
    .secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 0; }
    .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .skeleton { padding: 8px 2px; }
    .skeleton i { display: block; height: 11px; margin: 11px 0; border-radius: 4px; background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); animation: pulse 1.1s infinite alternate; }
    .skeleton i:nth-child(1) { width: 82%; height: 18px; }
    .skeleton i:nth-child(2) { width: 54%; }
    .skeleton i:nth-child(4) { width: 93%; }
    .skeleton i:nth-child(5) { width: 68%; }
    @keyframes pulse { to { opacity: .35; } }
    .edge-hint, .notice { position: absolute; z-index: 10; left: 50%; pointer-events: none; opacity: 0; transition: opacity .14s ease, transform .14s ease; }
    .edge-hint { padding: 5px 10px; border-radius: 99px; color: var(--vscode-notifications-foreground); background: var(--vscode-notifications-background); border: 1px solid var(--vscode-notifications-border, var(--vscode-widget-border)); font-size: 11px; transform: translate(-50%, 6px); white-space: nowrap; }
    .edge-hint.top { top: 50px; }
    .edge-hint.bottom { bottom: 12px; }
    .edge-hint.visible { opacity: .96; transform: translate(-50%, 0); }
    .notice { bottom: 14px; max-width: calc(100% - 24px); padding: 7px 11px; border-radius: 6px; color: var(--vscode-notifications-foreground); background: var(--vscode-notifications-background); border: 1px solid var(--vscode-notifications-border, var(--vscode-widget-border)); box-shadow: 0 4px 16px color-mix(in srgb, black 28%, transparent); transform: translate(-50%, 8px); text-align: center; }
    .notice.error { border-color: var(--vscode-inputValidation-errorBorder); }
    .notice.visible { opacity: 1; transform: translate(-50%, 0); }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; scroll-behavior: auto !important; transition: none !important; } }
  </style>
</head>
<body>
  <div class="app">
    <div id="progress" class="progress" aria-hidden="true"></div>
    <header class="topbar">
      <button id="back" class="icon-button back" title="返回推荐流（Esc）" aria-label="返回推荐流" hidden>←</button>
      <div class="brand"><span id="statusDot" class="dot"></span><span id="brandLabel" class="brand-label">知乎阅读</span></div>
      <div class="top-actions">
        <span id="position" class="position"></span>
        <button id="original" class="icon-button" title="在浏览器打开原文（O）" aria-label="在浏览器打开原文" hidden>↗</button>
        <button id="displayToggle" class="icon-button" title="阅读显示设置" aria-label="阅读显示设置" aria-expanded="false">Aa</button>
      </div>
    </header>
    <aside id="commentDrawer" class="comment-drawer" aria-label="回答评论" hidden>
      <div class="comment-head">
        <span id="commentTitle" class="comment-title">评论</span>
        <button id="commentClose" class="small-button comment-close" title="收起评论" aria-label="收起评论">×</button>
      </div>
      <div id="commentList" class="comment-list"></div>
      <div id="commentFooter" class="comment-footer" hidden>
        <button id="commentMore" class="small-button comment-more">加载更多评论</button>
      </div>
    </aside>
    <section id="displayPanel" class="display-panel" aria-label="阅读显示设置" hidden>
      <div class="display-panel-head">
        <span id="displayLabel" class="display-label">字号 14 · 标准行距</span>
        <button id="displayClose" class="small-button display-close" title="收起显示设置" aria-label="收起显示设置">×</button>
      </div>
      <div class="display-controls">
        <button id="fontDown" class="small-button" title="减小字号" aria-label="减小字号">A−</button>
        <button id="fontUp" class="small-button" title="增大字号" aria-label="增大字号">A＋</button>
        <button id="lineToggle" class="small-button" title="切换行距">行距</button>
        <button id="displayReset" class="small-button" title="恢复默认显示">重置</button>
      </div>
    </section>
    <main id="viewport"><div id="screen"></div></main>
    <div id="edgeHint" class="edge-hint" role="status"></div>
    <div id="notice" class="notice" role="status" aria-live="polite"></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const viewport = document.getElementById('viewport');
    const screen = document.getElementById('screen');
    const progress = document.getElementById('progress');
    const position = document.getElementById('position');
    const back = document.getElementById('back');
    const original = document.getElementById('original');
    const brandLabel = document.getElementById('brandLabel');
    const statusDot = document.getElementById('statusDot');
    const displayToggle = document.getElementById('displayToggle');
    const displayPanel = document.getElementById('displayPanel');
    const displayLabel = document.getElementById('displayLabel');
    const commentDrawer = document.getElementById('commentDrawer');
    const commentTitle = document.getElementById('commentTitle');
    const commentList = document.getElementById('commentList');
    const commentFooter = document.getElementById('commentFooter');
    const commentMore = document.getElementById('commentMore');
    const edgeHint = document.getElementById('edgeHint');
    const notice = document.getElementById('notice');
    let busy = false;
    let currentHasOriginal = false;
    let currentQuestionMode = false;
    let currentCanLoadComments = false;
    let currentCommentCount = 0;
    let commentsBusy = false;
    let noticeTimer = 0;
    let cooldownUntil = 0;

    const saved = vscode.getState() || {};
    const reading = {
      fontSize: clamp(Number(saved.fontSize) || 14, 12, 20),
      lineHeight: clamp(Number(saved.lineHeight) || 1.78, 1.45, 2.15),
    };

    function clamp(value, min, max) {
      return Math.max(min, Math.min(max, value));
    }

    function applyReadingSettings() {
      document.documentElement.style.setProperty('--reader-font-size', reading.fontSize + 'px');
      document.documentElement.style.setProperty('--reader-line-height', String(reading.lineHeight));
      const spacing = reading.lineHeight > 1.9 ? '宽松行距' : reading.lineHeight < 1.65 ? '紧凑行距' : '标准行距';
      displayLabel.textContent = '字号 ' + reading.fontSize + ' · ' + spacing;
      vscode.setState({ fontSize: reading.fontSize, lineHeight: reading.lineHeight });
    }

    function closeDisplayPanel() {
      displayPanel.hidden = true;
      displayToggle.setAttribute('aria-expanded', 'false');
    }

    function closeComments() {
      commentDrawer.hidden = true;
      commentsBusy = false;
    }

    function openComments() {
      if (!currentCanLoadComments || commentsBusy) return;
      closeDisplayPanel();
      commentDrawer.hidden = false;
      commentTitle.textContent = '评论' + (currentCommentCount ? '（' + currentCommentCount + '）' : '');
      commentFooter.hidden = true;
      commentList.replaceChildren();
      const empty = element('div', 'comment-empty', '正在读取评论…');
      commentList.appendChild(empty);
      commentsBusy = true;
      action('loadComments');
    }

    function showCommentsError(text) {
      commentDrawer.hidden = false;
      commentsBusy = false;
      commentFooter.hidden = true;
      commentList.replaceChildren();
      const wrap = element('div', 'comment-empty');
      const box = element('div');
      box.appendChild(element('div', '', text || '评论读取失败'));
      const retry = element('button', 'secondary', '重新验证');
      retry.style.marginTop = '12px';
      retry.addEventListener('click', openComments);
      box.appendChild(retry);
      wrap.appendChild(box);
      commentList.appendChild(wrap);
    }

    function formatCommentTime(timestamp) {
      if (!timestamp) return '';
      try { return new Date(timestamp * 1000).toLocaleString('zh-CN', { hour12: false }); }
      catch { return ''; }
    }

    function renderComments(message) {
      commentDrawer.hidden = false;
      commentsBusy = false;
      if (!message.append) commentList.replaceChildren();
      if (!message.items.length && !message.append) {
        commentList.appendChild(element('div', 'comment-empty', '当前回答暂无可显示评论'));
      }
      for (const item of message.items) {
        const card = element('article', 'comment-card');
        let author = item.authorName || '知乎用户';
        if (item.replyToName) author += ' 回复 ' + item.replyToName;
        card.appendChild(element('div', 'comment-author', author));
        if (item.authorHeadline) card.appendChild(element('div', 'comment-headline', item.authorHeadline));
        const content = element('div', 'comment-content');
        renderMarkdown(item.content || '（无文字内容）', content);
        card.appendChild(content);
        const meta = element('div', 'comment-meta');
        const time = formatCommentTime(item.createdTime);
        if (time) meta.appendChild(element('span', '', time));
        if (item.voteCount) meta.appendChild(element('span', '', '赞 ' + item.voteCount));
        if (item.childCommentCount) meta.appendChild(element('span', '', item.childCommentCount + ' 条回复'));
        card.appendChild(meta);
        commentList.appendChild(card);
      }
      commentFooter.hidden = !message.hasMore;
      commentMore.disabled = false;
      commentMore.textContent = '加载更多评论';
    }

    function action(name, extra) {
      if (busy && (name === 'next' || name === 'prev')) return;
      if (name === 'next' || name === 'prev') busy = true;
      vscode.postMessage(Object.assign({ action: name }, extra || {}));
    }

    function element(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function appendInline(text, root) {
      const value = String(text || '');
      const token = /(\x60[^\x60]+\x60|\*\*[^*]+\*\*|~~[^~]+~~|\*[^*]+\*|!\[[^\]]*\]\([^)]*\)|\[[^\]]+\]\([^)]*\))/g;
      let cursor = 0;
      let match;
      while ((match = token.exec(value)) !== null) {
        if (match.index > cursor) root.appendChild(document.createTextNode(value.slice(cursor, match.index)));
        const raw = match[0];
        let node;
        if (raw.startsWith('![')) {
          const alt = /^!\[([^\]]*)\]/.exec(raw)?.[1] || '图片';
          node = element('span', 'link-text', '〔' + alt + '〕');
        } else if (raw.startsWith('**')) {
          node = element('strong', '', raw.slice(2, -2));
        } else if (raw.startsWith('~~')) {
          node = element('del', '', raw.slice(2, -2));
        } else if (raw.startsWith('*')) {
          node = element('em', '', raw.slice(1, -1));
        } else if (raw.startsWith(String.fromCharCode(96))) {
          node = element('code', 'inline', raw.slice(1, -1));
        } else {
          const label = /^\[([^\]]+)\]/.exec(raw)?.[1] || raw;
          node = element('span', 'link-text', label);
          node.title = '正文链接已隐藏';
        }
        root.appendChild(node);
        cursor = match.index + raw.length;
      }
      if (cursor < value.length) root.appendChild(document.createTextNode(value.slice(cursor)));
    }

    function splitTableRow(line) {
      const value = line.trim().replace(/^\|/, '').replace(/\|$/, '');
      const cells = [];
      let current = '';
      let escaped = false;
      for (const char of value) {
        if (escaped) {
          current += char;
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '|') {
          cells.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      cells.push(current.trim());
      return cells;
    }

    function isTableDivider(line) {
      const cells = splitTableRow(line);
      return cells.length > 0 && cells.every(function (cell) { return /^:?-{3,}:?$/.test(cell); });
    }

    function renderTable(lines, start, root) {
      const headers = splitTableRow(lines[start]);
      const rows = [];
      let index = start + 2;
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        rows.push(splitTableRow(lines[index]));
        index++;
      }
      const wrap = element('div', 'table-wrap');
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const header of headers) {
        const th = document.createElement('th');
        appendInline(header, th);
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      for (const values of rows) {
        const tr = document.createElement('tr');
        for (let column = 0; column < headers.length; column++) {
          const td = document.createElement('td');
          appendInline(values[column] || '', td);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      root.appendChild(wrap);
      return index;
    }

    function appendCodeBlock(code, language, root) {
      const wrap = element('section', 'code-block');
      const head = element('div', 'code-head', language || '代码');
      const copy = element('button', 'copy-code', '复制');
      copy.type = 'button';
      copy.addEventListener('click', function () {
        vscode.postMessage({ action: 'copyText', text: code });
        copy.textContent = '已复制';
        setTimeout(function () { copy.textContent = '复制'; }, 1200);
      });
      head.appendChild(copy);
      wrap.appendChild(head);
      wrap.appendChild(element('pre', '', code));
      root.appendChild(wrap);
    }

    function renderMarkdown(markdown, root) {
      const lines = String(markdown || '').replace(/\r/g, '').split('\n');
      const fence = String.fromCharCode(96).repeat(3);
      let index = 0;
      while (index < lines.length) {
        const raw = lines[index];
        const line = raw.trim();
        if (!line) { index++; continue; }
        if (line.startsWith(fence)) {
          const language = line.slice(3).trim();
          const code = [];
          index++;
          while (index < lines.length && !lines[index].trim().startsWith(fence)) {
            code.push(lines[index]);
            index++;
          }
          if (index < lines.length) index++;
          appendCodeBlock(code.join('\n'), language, root);
          continue;
        }
        if (/^\s*\|.*\|\s*$/.test(raw) && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
          index = renderTable(lines, index, root);
          continue;
        }
        if (/^---+$/.test(line)) {
          root.appendChild(document.createElement('hr'));
          index++;
          continue;
        }
        const heading = /^(#{1,5})\s+(.+)$/.exec(line);
        if (heading) {
          const level = Math.min(5, heading[1].length + 1);
          const node = document.createElement('h' + level);
          appendInline(heading[2], node);
          root.appendChild(node);
          index++;
          continue;
        }
        if (line.startsWith('>')) {
          const quote = document.createElement('blockquote');
          while (index < lines.length && lines[index].trim().startsWith('>')) {
            const paragraph = document.createElement('p');
            appendInline(lines[index].trim().replace(/^>\s?/, ''), paragraph);
            quote.appendChild(paragraph);
            index++;
          }
          root.appendChild(quote);
          continue;
        }
        const list = /^(\s*)([-*]|\d+\.)\s+(.+)$/.exec(raw);
        if (list) {
          const row = element('div', 'list-row');
          row.style.setProperty('--depth', String(Math.min(6, Math.floor(list[1].length / 2))));
          row.appendChild(element('span', 'list-marker', /^\d/.test(list[2]) ? list[2] : '•'));
          const value = element('span', 'list-value');
          appendInline(list[3], value);
          row.appendChild(value);
          root.appendChild(row);
          index++;
          continue;
        }
        const paragraph = document.createElement('p');
        appendInline(line, paragraph);
        root.appendChild(paragraph);
        index++;
      }
    }

    function setStatus(kind, title) {
      statusDot.className = 'dot' + (kind ? ' ' + kind : '');
      statusDot.title = title || '';
    }

    function showNotice(text, tone) {
      clearTimeout(noticeTimer);
      notice.textContent = text;
      notice.className = 'notice' + (tone === 'error' ? ' error' : '') + ' visible';
      noticeTimer = setTimeout(function () { notice.className = 'notice'; }, tone === 'error' ? 4200 : 2200);
    }

    function showWelcome(errorText, errorAction) {
      busy = false;
      currentHasOriginal = false;
      currentQuestionMode = false;
      currentCanLoadComments = false;
      currentCommentCount = 0;
      closeComments();
      back.hidden = true;
      original.hidden = true;
      brandLabel.textContent = '知乎阅读';
      position.textContent = '';
      progress.style.width = '0';
      setStatus(errorText ? 'error' : '', errorText ? '读取失败' : '尚未开始');
      screen.replaceChildren();
      const wrap = element('section', 'empty');
      const card = element('div', 'empty-card');
      card.appendChild(element('div', 'empty-icon', '知'));
      card.appendChild(element('h2', '', errorText ? '暂时无法读取' : '在侧边栏刷知乎'));
      card.appendChild(element('p', '', errorText || '导入登录 Cookie 后，即可连续浏览推荐内容。'));
      const buttons = element('div', 'button-row');
      const shouldImport = !errorText || errorAction === 'importCookie';
      const button = element('button', 'primary', errorText ? (shouldImport ? '重新导入 Cookie' : '重试') : '导入 Cookie 并开始');
      button.addEventListener('click', function () { action(shouldImport ? 'importCookie' : 'refresh'); });
      buttons.appendChild(button);
      if (errorText && shouldImport) {
        const clear = element('button', 'secondary', '清除登录信息');
        clear.addEventListener('click', function () { action('clearCookie'); });
        buttons.appendChild(clear);
      }
      card.appendChild(buttons);
      card.appendChild(element('p', 'hint', '快捷键：J/K 切换 · R 刷新 · O 打开原文 · Esc 返回'));
      wrap.appendChild(card);
      screen.appendChild(wrap);
      viewport.scrollTop = 0;
    }

    function showLoading(text) {
      busy = true;
      currentHasOriginal = false;
      currentQuestionMode = false;
      currentCanLoadComments = false;
      currentCommentCount = 0;
      closeComments();
      original.hidden = true;
      back.hidden = true;
      position.textContent = text || '加载中';
      progress.style.width = '0';
      setStatus('pending', '正在读取');
      screen.replaceChildren();
      const box = element('div', 'skeleton');
      for (let i = 0; i < 6; i++) box.appendChild(document.createElement('i'));
      screen.appendChild(box);
    }

    function showItem(item) {
      busy = false;
      cooldownUntil = Date.now() + 550;
      currentHasOriginal = Boolean(item.url);
      currentQuestionMode = Boolean(item.question);
      currentCanLoadComments = Boolean(item.canLoadComments);
      currentCommentCount = Number(item.commentCount) || 0;
      closeComments();
      original.hidden = !currentHasOriginal;
      back.hidden = !currentQuestionMode;
      brandLabel.textContent = currentQuestionMode ? '问题详情' : '知乎阅读';
      position.textContent = (currentQuestionMode ? '回答 ' : '') + String(item.index + 1) + ' / ' + String(item.total);
      setStatus('connected', 'Cookie 有效，内容已加载');
      screen.replaceChildren();
      const article = element('article', 'article');
      if (item.question) {
        const questionBox = element('section', 'question-box');
        questionBox.appendChild(element('h1', '', item.question.title));
        if (item.index === 0 && item.question.detail) {
          const detail = element('div', 'question-detail content');
          renderMarkdown(item.question.detail, detail);
          questionBox.appendChild(detail);
        }
        article.appendChild(questionBox);
        if (item.kind === 'question') article.appendChild(element('div', 'answer-label', '问题'));
      }
      const metaRow = element('div', 'meta-row');
      const meta = element('div', 'meta');
      for (const value of item.meta) {
        if (currentCanLoadComments && /^评\s/.test(value)) continue;
        meta.appendChild(element('span', 'chip', value));
      }
      metaRow.appendChild(meta);
      if (currentCanLoadComments) {
        const commentButton = element('button', 'comment-action');
        commentButton.type = 'button';
        commentButton.title = '查看评论';
        commentButton.setAttribute('aria-label', '查看 ' + currentCommentCount + ' 条评论');
        const commentIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        commentIcon.setAttribute('class', 'comment-icon');
        commentIcon.setAttribute('viewBox', '0 0 16 16');
        commentIcon.setAttribute('aria-hidden', 'true');
        const commentPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        commentPath.setAttribute('d', 'M3.25 2.75h9.5c.97 0 1.75.78 1.75 1.75v5c0 .97-.78 1.75-1.75 1.75H7.4L4.25 14v-2.75h-1c-.97 0-1.75-.78-1.75-1.75v-5c0-.97.78-1.75 1.75-1.75Z');
        commentPath.setAttribute('fill', 'none');
        commentPath.setAttribute('stroke', 'currentColor');
        commentPath.setAttribute('stroke-width', '1.25');
        commentPath.setAttribute('stroke-linejoin', 'round');
        commentIcon.appendChild(commentPath);
        commentButton.appendChild(commentIcon);
        commentButton.appendChild(element('span', 'comment-count', String(currentCommentCount)));
        commentButton.addEventListener('click', openComments);
        metaRow.appendChild(commentButton);
      }
      article.appendChild(metaRow);
      if (!item.question) article.appendChild(element('h1', '', item.title));
      const content = element('div', 'content');
      renderMarkdown(item.content, content);
      article.appendChild(content);
      if (item.canOpenQuestion) {
        const openQuestion = element('button', 'open-question', '查看该问题的全部回答');
        openQuestion.addEventListener('click', function () { action('openQuestion'); });
        article.appendChild(openQuestion);
      }
      screen.appendChild(article);
      viewport.scrollTop = 0;
      updateProgress();
      resetEdgeHint();
    }

    function updateProgress() {
      const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const ratio = max === 0 ? 1 : clamp(viewport.scrollTop / max, 0, 1);
      progress.style.width = String(ratio * 100) + '%';
    }

    let edgeDirection = '';
    let edgeAmount = 0;
    let edgeArmedAt = 0;

    function resetEdgeHint() {
      edgeDirection = '';
      edgeAmount = 0;
      edgeArmedAt = 0;
      edgeHint.className = 'edge-hint';
    }

    function armEdge(direction, delta) {
      const now = Date.now();
      if (now < cooldownUntil || busy) return;
      if (edgeDirection !== direction) {
        edgeDirection = direction;
        edgeAmount = 0;
        edgeArmedAt = now;
      }
      edgeAmount += Math.abs(delta);
      if (edgeAmount >= 35) {
        edgeHint.textContent = direction === 'next' ? '继续滚动切换下一条' : '继续滚动返回上一条';
        edgeHint.className = 'edge-hint ' + (direction === 'next' ? 'bottom' : 'top') + ' visible';
      }
      if (edgeAmount >= 220 && now - edgeArmedAt >= 180) {
        resetEdgeHint();
        cooldownUntil = now + 650;
        action(direction);
      }
    }

    window.addEventListener('message', function (event) {
      const message = event.data;
      if (message.type === 'item') showItem(message.item);
      else if (message.type === 'loading') showLoading(message.text);
      else if (message.type === 'error') showWelcome(message.text, message.action);
      else if (message.type === 'welcome') showWelcome();
      else if (message.type === 'notice') { busy = false; showNotice(message.text, message.tone); }
      else if (message.type === 'commentsLoading') openComments();
      else if (message.type === 'commentsError') showCommentsError(message.text);
      else if (message.type === 'comments') renderComments(message);
    });

    back.addEventListener('click', function () { action('backToFeed'); });
    original.addEventListener('click', function () { action('openOriginal'); });
    displayToggle.addEventListener('click', function () {
      displayPanel.hidden = !displayPanel.hidden;
      displayToggle.setAttribute('aria-expanded', String(!displayPanel.hidden));
    });
    document.getElementById('fontDown').addEventListener('click', function () { reading.fontSize = clamp(reading.fontSize - 1, 12, 20); applyReadingSettings(); });
    document.getElementById('fontUp').addEventListener('click', function () { reading.fontSize = clamp(reading.fontSize + 1, 12, 20); applyReadingSettings(); });
    document.getElementById('lineToggle').addEventListener('click', function () {
      reading.lineHeight = reading.lineHeight < 1.65 ? 1.78 : reading.lineHeight < 1.9 ? 2.05 : 1.55;
      applyReadingSettings();
    });
    document.getElementById('displayReset').addEventListener('click', function () { reading.fontSize = 14; reading.lineHeight = 1.78; applyReadingSettings(); });
    document.getElementById('displayClose').addEventListener('click', closeDisplayPanel);
    document.getElementById('commentClose').addEventListener('click', closeComments);
    commentMore.addEventListener('click', function () {
      if (commentsBusy) return;
      commentsBusy = true;
      commentMore.disabled = true;
      commentMore.textContent = '正在加载…';
      action('loadMoreComments');
    });
    document.addEventListener('pointerdown', function (event) {
      if (displayPanel.hidden) return;
      if (displayPanel.contains(event.target) || displayToggle.contains(event.target)) return;
      closeDisplayPanel();
    });

    let touchY = 0;
    viewport.addEventListener('touchstart', function (event) { touchY = event.changedTouches[0].clientY; }, { passive: true });
    viewport.addEventListener('touchend', function (event) {
      const delta = event.changedTouches[0].clientY - touchY;
      if (Date.now() >= cooldownUntil && Math.abs(delta) > 110) action(delta < 0 ? 'next' : 'prev');
    }, { passive: true });

    viewport.addEventListener('scroll', function () {
      updateProgress();
      const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 3;
      const atTop = viewport.scrollTop < 3;
      if (!atBottom && !atTop) resetEdgeHint();
    }, { passive: true });

    viewport.addEventListener('wheel', function (event) {
      const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 3;
      const atTop = viewport.scrollTop < 3;
      if (atBottom && event.deltaY > 0) armEdge('next', event.deltaY);
      else if (atTop && event.deltaY < 0) armEdge('prev', event.deltaY);
      else resetEdgeHint();
    }, { passive: true });

    window.addEventListener('keydown', function (event) {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLButtonElement) return;
      const key = event.key.toLowerCase();
      if (key === 'j' || key === 'n') { event.preventDefault(); action('next'); }
      else if (key === 'k' || key === 'p') { event.preventDefault(); action('prev'); }
      else if (key === 'r') { event.preventDefault(); action('refresh'); }
      else if (key === 'o' && currentHasOriginal) { event.preventDefault(); action('openOriginal'); }
      else if (event.key === 'Escape' && !commentDrawer.hidden) { event.preventDefault(); closeComments(); }
      else if (event.key === 'Escape' && !displayPanel.hidden) { event.preventDefault(); closeDisplayPanel(); }
      else if (event.key === 'Escape' && currentQuestionMode) { event.preventDefault(); action('backToFeed'); }
    });

    applyReadingSettings();
    showWelcome();
    vscode.postMessage({ action: 'ready' });
  </script>
</body>
</html>`;
  }
}

function stripMarkdownLink(value: string): string {
  return value.replace(/^\[([^\]]+)\]\([^)]+\)$/, '$1');
}

function stateSafeNumericId(value: unknown): boolean {
  return (typeof value === 'number' || typeof value === 'string') && /^\d+$/.test(String(value));
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}
