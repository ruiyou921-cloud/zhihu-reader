import * as vscode from 'vscode';
import { ReaderState } from './state';
import { ReaderSidebar } from './sidebar';
import { ZhihuError } from './fetcher';
import { feedItemToMarkdown, normalizeZhihuOriginalUrl } from './converter';

async function withFs(
  fn: () => Promise<void>,
  state: ReaderState,
  sidebar: ReaderSidebar,
  options: { preserveContent?: boolean } = {}
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ZhihuError) {
      if (/cookie|未登录|登录失效|身份认证/i.test(e.message) || e.code === 401) {
        const pick = await vscode.window.showWarningMessage(
          `${e.message}。可以重新导入 Cookie 解决。`,
          '重新导入 Cookie',
          '取消'
        );
        sidebar.showError(e.message, 'importCookie');
        if (pick === '重新导入 Cookie') {
          await vscode.commands.executeCommand('zhihu.importCookie');
        }
        return;
      }
      void vscode.window.showErrorMessage(e.message);
      if (options.preserveContent) sidebar.showNotice(e.message, 'error');
      else sidebar.showError(e.message);
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    void vscode.window.showErrorMessage(`发生错误：${msg}`);
    if (options.preserveContent) sidebar.showNotice(msg, 'error');
    else sidebar.showError(msg);
  }
}

export async function importCookie(state: ReaderState): Promise<boolean> {
  const clip = await vscode.env.clipboard.readText();
  const value = await vscode.window.showInputBox({
    prompt: '粘贴知乎登录后的 Cookie 字符串（从浏览器 DevTools 的知乎请求头复制）',
    placeHolder: 'd_c0=xxx; _xsrf=yyy; z_c0=zzz ...',
    value: clip.includes('=') ? clip : undefined,
    ignoreFocusOut: true,
    password: true,
  });
  if (value === undefined) return false;
  const cookie = value.trim();
  if (!cookie) {
    void vscode.window.showWarningMessage('Cookie 不能为空');
    return false;
  }
  const previous = await state.getCookie();
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '校验知乎 Cookie…' },
      async () => {
        await state.setCookie(cookie);
        await state.checkCookie();
      }
    );
  } catch (error) {
    if (previous) await state.setCookie(previous);
    else await state.clearCookie();
    throw error;
  }
  void vscode.window.showInformationMessage('Cookie 校验通过，可以打开推荐流了');
  return true;
}

export interface Commands {
  openFeed: () => Promise<void>;
  importCookie: () => Promise<void>;
  clearCookie: () => Promise<void>;
  openOriginal: () => Promise<void>;
  loadComments: () => Promise<void>;
  loadMoreComments: () => Promise<void>;
  next: () => Promise<void>;
  prev: () => Promise<void>;
  refresh: () => Promise<void>;
  openQuestion: () => Promise<void>;
  backToFeed: () => void;
  chooseSidebarPosition: () => Promise<void>;
  close: () => void;
}

export function makeCommands(state: ReaderState, sidebar: ReaderSidebar): Commands {
  const showCurrent = (): void => {
    const item = state.current;
    if (!item) return;
    sidebar.showItem(
      item,
      state.currentIndex,
      state.displayTotal,
      state.question,
      state.canOpenCurrentQuestion
    );
    state.updateStatusBar();
  };

  const openFeed = async () => {
    await sidebar.reveal();
    sidebar.showLoading('正在获取知乎推荐…');
    await withFs(
      async () => {
        await state.loadFeed();
        const item = state.current;
        if (!item) {
          void vscode.window.showInformationMessage('推荐流为空，换一批试试');
          sidebar.showError('推荐流暂时为空，可以稍后换一批重试。');
          return;
        }
        showCurrent();
      },
      state,
      sidebar
    );
  };

  const next = async () => {
    if (!state.isActive) {
      void vscode.window.showInformationMessage('请先执行「知乎：打开推荐流」');
      return;
    }
    if (!state.canGoNext) {
      sidebar.showNotice('已经是最后一条内容');
      return;
    }
    await withFs(
      async () => {
        const item = await state.goTo(state.currentIndex + 1);
        if (item) {
          showCurrent();
        }
      },
      state,
      sidebar,
      { preserveContent: true }
    );
  };

  const prev = async () => {
    if (!state.isActive) return;
    if (!state.canGoPrev) {
      sidebar.showNotice('已经是第一条内容');
      return;
    }
    await withFs(
      async () => {
        const item = await state.goTo(state.currentIndex - 1);
        if (item) {
          showCurrent();
        }
      },
      state,
      sidebar,
      { preserveContent: true }
    );
  };

  const refresh = async () => {
    if (!state.isQuestionMode) {
      await openFeed();
      return;
    }
    sidebar.showLoading('正在刷新问题回答…');
    await withFs(
      async () => {
        await state.reloadQuestion();
        showCurrent();
      },
      state,
      sidebar
    );
  };

  const openQuestion = async () => {
    if (!state.canOpenCurrentQuestion) return;
    sidebar.showLoading('正在获取问题和回答…');
    await withFs(
      async () => {
        await state.openCurrentQuestion();
        showCurrent();
      },
      state,
      sidebar
    );
  };

  const backToFeed = () => {
    if (state.backToFeed()) showCurrent();
  };

  const chooseSidebarPosition = async () => {
    // 显式传入视图 ID，避免依赖 Webview 焦点状态。原生选择器只移动该视图，
    // 不会改变 Explorer 等主侧栏内容的位置。
    await vscode.commands.executeCommand(
      'workbench.action.moveFocusedView',
      ReaderSidebar.viewType
    );
  };

  const importAndOpen = async () => {
    await withFs(
      async () => {
        if (await importCookie(state)) await openFeed();
      },
      state,
      sidebar
    );
  };

  const clearCookie = async () => {
    const cookie = await state.getCookie();
    if (!cookie) {
      sidebar.showWelcome();
      void vscode.window.showInformationMessage('当前没有已保存的知乎 Cookie');
      return;
    }
    const pick = await vscode.window.showWarningMessage(
      '清除后需要重新导入 Cookie 才能读取知乎内容。',
      { modal: true },
      '清除登录信息'
    );
    if (pick !== '清除登录信息') return;
    await withFs(
      async () => {
        await state.clearCookie();
        sidebar.showWelcome();
        void vscode.window.showInformationMessage('知乎登录信息已清除');
      },
      state,
      sidebar
    );
  };

  const openOriginal = async () => {
    const item = state.current;
    const rawUrl = item ? feedItemToMarkdown(item).url : undefined;
    if (!rawUrl) {
      sidebar.showNotice('当前内容没有可用的原文地址');
      return;
    }
    let url: string;
    try {
      url = normalizeZhihuOriginalUrl(rawUrl);
    } catch {
      sidebar.showNotice('已阻止不安全的原文地址', 'error');
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url, true));
  };

  const showCommentFailure = (error: unknown): void => {
    if (error instanceof ZhihuError) {
      sidebar.showCommentsError(error.message);
      return;
    }
    sidebar.showCommentsError(error instanceof Error ? error.message : String(error));
  };

  const loadComments = async () => {
    sidebar.showCommentsLoading();
    try {
      const page = await state.loadCurrentComments();
      sidebar.showComments(page, false);
    } catch (error) {
      showCommentFailure(error);
    }
  };

  const loadMoreComments = async () => {
    try {
      const page = await state.loadMoreCurrentComments();
      if (page) sidebar.showComments(page, true);
      else sidebar.showNotice('已经没有更多评论');
    } catch (error) {
      showCommentFailure(error);
    }
  };

  const close = () => {
    void vscode.commands.executeCommand('workbench.action.closeSidebar');
  };

  return {
    openFeed,
    importCookie: importAndOpen,
    clearCookie,
    openOriginal,
    loadComments,
    loadMoreComments,
    next,
    prev,
    refresh,
    openQuestion,
    backToFeed,
    chooseSidebarPosition,
    close,
  };
}
