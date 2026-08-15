import * as vscode from 'vscode';
import { ZhihuClient, FeedPage, validateCookie, ZhihuError, ZhihuQuestionDetail, CommentPage } from './fetcher';
import { filterZhihuFeedItems, ZhihuFeedItem } from './converter';

const COOKIE_SECRET_KEY = 'zhihuReader.cookie';

export interface QuestionContext {
  id: number | string;
  title: string;
  detail: string;
  answerCount: number;
}

interface FeedSnapshot {
  items: ZhihuFeedItem[];
  nextUrl: string | null;
  prefetchedPage: FeedPage | null;
  index: number;
}

export class ReaderState {
  private client: ZhihuClient | null = null;
  private items: ZhihuFeedItem[] = [];
  private nextUrl: string | null = null;
  private prefetchedPage: FeedPage | null = null;
  private prefetchPromise: Promise<void> | null = null;
  private index = -1;
  private mode: 'feed' | 'question' = 'feed';
  private questionContext: QuestionContext | null = null;
  private feedSnapshot: FeedSnapshot | null = null;
  private commentAnswerId: string | null = null;
  private commentNextUrl: string | null = null;
  private statusBar: vscode.StatusBarItem;

  constructor(private ctx: vscode.ExtensionContext) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.ctx.subscriptions.push(this.statusBar);
  }

  get isActive(): boolean {
    return this.items.length > 0;
  }

  get currentIndex(): number {
    return this.index;
  }

  get total(): number {
    return this.items.length;
  }

  get displayTotal(): number {
    return this.questionContext ? Math.max(this.questionContext.answerCount, this.items.length) : this.items.length;
  }

  get isQuestionMode(): boolean {
    return this.mode === 'question';
  }

  get question(): QuestionContext | null {
    return this.questionContext;
  }

  get canOpenCurrentQuestion(): boolean {
    return this.mode === 'feed' && this.currentQuestionId() !== null;
  }

  get current(): ZhihuFeedItem | null {
    return this.index >= 0 && this.index < this.items.length ? this.items[this.index] : null;
  }

  get currentAnswerId(): string | null {
    const target = this.current?.target;
    if (!target || target.type !== 'answer' || target.id === undefined) return null;
    const id = String(target.id);
    return /^\d+$/.test(id) ? id : null;
  }

  get canGoNext(): boolean {
    return this.index >= 0 && (this.index < this.items.length - 1 || this.nextUrl !== null);
  }

  get canGoPrev(): boolean {
    return this.index > 0;
  }

  async getCookie(): Promise<string | null> {
    return (await this.ctx.secrets.get(COOKIE_SECRET_KEY)) ?? null;
  }

  async setCookie(cookie: string): Promise<void> {
    await this.ctx.secrets.store(COOKIE_SECRET_KEY, cookie.trim());
    this.client = new ZhihuClient(cookie.trim(), fetch, this.requestIntervalMs());
  }

  async clearCookie(): Promise<void> {
    await this.ctx.secrets.delete(COOKIE_SECRET_KEY);
    this.client = null;
    this.items = [];
    this.nextUrl = null;
    this.prefetchedPage = null;
    this.prefetchPromise = null;
    this.index = -1;
    this.mode = 'feed';
    this.questionContext = null;
    this.feedSnapshot = null;
    this.resetComments();
    this.statusBar.hide();
  }

  private requestIntervalMs(): number {
    const value = vscode.workspace.getConfiguration('zhihuReader').get<number>('requestIntervalMs', 1600);
    return Math.max(500, Math.min(60_000, Math.trunc(Number.isFinite(value) ? value : 1600)));
  }

  /** 配置变化后重置请求间隔 */
  refreshInterval(): void {
    if (this.client) this.client.setIntervalMs(this.requestIntervalMs());
  }

  private feedPageSize(): number {
    const value = vscode.workspace.getConfiguration('zhihuReader').get<number>('feedPageSize', 10);
    return Math.max(1, Math.min(20, Math.trunc(Number.isFinite(value) ? value : 10)));
  }

  private filterAdsEnabled(): boolean {
    return vscode.workspace.getConfiguration('zhihuReader').get<boolean>('filterAds', true);
  }

  /** 过滤推荐页中的显式广告；若整页都是广告，最多继续读取三页。 */
  private async filterFeedPage(page: FeedPage, client: ZhihuClient): Promise<FeedPage> {
    if (!this.filterAdsEnabled()) return page;
    let filtered: FeedPage = { ...page, items: filterZhihuFeedItems(page.items) };
    for (let skippedPages = 0; filtered.items.length === 0 && filtered.next && skippedPages < 3; skippedPages += 1) {
      const nextPage = await client.fetchNextPage(filtered.next);
      filtered = { ...nextPage, items: filterZhihuFeedItems(nextPage.items) };
    }
    return filtered;
  }

  private async ensureClient(): Promise<ZhihuClient> {
    if (this.client) return this.client;
    const cookie = await this.getCookie();
    if (!cookie) throw new ZhihuError('尚未导入登录 Cookie，请先执行「知乎：导入登录 Cookie」');
    this.client = new ZhihuClient(cookie, fetch, this.requestIntervalMs());
    return this.client;
  }

  /** 校验 cookie 是否有效 */
  async checkCookie(): Promise<void> {
    const cookie = await this.getCookie();
    if (!cookie) throw new ZhihuError('尚未导入登录 Cookie');
    await validateCookie(cookie, this.requestIntervalMs());
  }

  /** 拉取首页 feed（可预取下一页） */
  async loadFeed(): Promise<void> {
    const client = await this.ensureClient();
    const page = await this.filterFeedPage(
      await client.fetchRecommendFeed(this.feedPageSize()),
      client
    );
    this.items = page.items;
    this.nextUrl = page.next;
    this.prefetchedPage = null;
    this.prefetchPromise = null;
    this.index = this.items.length ? 0 : -1;
    this.mode = 'feed';
    this.questionContext = null;
    this.feedSnapshot = null;
    this.resetComments();
    this.schedulePrefetch();
  }

  /** 从当前推荐条目进入其所属问题，并载入第一页回答。 */
  async openCurrentQuestion(): Promise<void> {
    if (this.mode !== 'feed') return;
    const qid = this.currentQuestionId();
    if (qid === null) throw new ZhihuError('当前内容不属于某个知乎问题');
    if (this.prefetchPromise) await this.prefetchPromise;

    const current = this.current;
    const fallbackTitle = current?.target?.question?.title ?? current?.target?.title ?? `知乎问题 #${qid}`;
    const client = await this.ensureClient();
    let detail: ZhihuQuestionDetail = {
      id: qid,
      title: fallbackTitle,
      detail: current?.target?.type === 'question'
        ? current.target.content ?? current.target.excerpt ?? ''
        : '',
      answer_count: current?.target?.question?.answer_count ?? current?.target?.answer_count,
    };
    try {
      detail = await client.fetchQuestionDetail(qid);
    } catch (error) {
      // 问题元数据不是浏览回答的必要条件。参数兼容性异常时使用 feed 内信息降级。
      if (!(error instanceof ZhihuError) || error.code !== 403 || !/参数异常/.test(error.message)) throw error;
    }
    const page = await client.fetchQuestionAnswers(qid, this.feedPageSize());

    this.feedSnapshot = {
      items: this.items,
      nextUrl: this.nextUrl,
      prefetchedPage: this.prefetchedPage,
      index: this.index,
    };
    this.items = page.items;
    if (!this.items.length) {
      this.items = [{
        type: 'question',
        target: {
          id: qid,
          type: 'question',
          title: detail.title || fallbackTitle,
          content: '（这个问题暂时没有可显示的回答）',
        },
      }];
    }
    this.nextUrl = page.next;
    this.prefetchedPage = null;
    this.prefetchPromise = null;
    this.index = 0;
    this.resetComments();
    this.mode = 'question';
    this.questionContext = {
      id: qid,
      title: detail.title || fallbackTitle,
      detail: detail.detail ?? detail.excerpt ?? '',
      answerCount: detail.answer_count ?? page.items.length,
    };
    this.schedulePrefetch();
  }

  /** 重新获取当前问题及其回答。 */
  async reloadQuestion(): Promise<void> {
    if (!this.questionContext) return;
    if (this.prefetchPromise) await this.prefetchPromise;
    const qid = this.questionContext.id;
    const client = await this.ensureClient();
    let detail: ZhihuQuestionDetail = {
      id: qid,
      title: this.questionContext.title,
      detail: this.questionContext.detail,
      answer_count: this.questionContext.answerCount,
    };
    try {
      detail = await client.fetchQuestionDetail(qid);
    } catch (error) {
      // 与首次进入问题时保持一致：元数据参数不兼容时仍允许刷新回答。
      if (!(error instanceof ZhihuError) || error.code !== 403 || !/参数异常/.test(error.message)) throw error;
    }
    const page = await client.fetchQuestionAnswers(qid, this.feedPageSize());
    this.items = page.items.length ? page.items : [{
      type: 'question',
      target: { id: qid, type: 'question', title: detail.title, content: '（这个问题暂时没有可显示的回答）' },
    }];
    this.nextUrl = page.next;
    this.prefetchedPage = null;
    this.prefetchPromise = null;
    this.index = 0;
    this.resetComments();
    this.questionContext = {
      id: qid,
      title: detail.title || this.questionContext.title,
      detail: detail.detail ?? detail.excerpt ?? '',
      answerCount: detail.answer_count ?? page.items.length,
    };
    this.schedulePrefetch();
  }

  /** 返回进入问题前的推荐条目和分页位置。 */
  backToFeed(): ZhihuFeedItem | null {
    if (!this.feedSnapshot) return null;
    this.items = this.feedSnapshot.items;
    this.nextUrl = this.feedSnapshot.nextUrl;
    this.prefetchedPage = this.feedSnapshot.prefetchedPage;
    this.index = this.feedSnapshot.index;
    this.feedSnapshot = null;
    this.mode = 'feed';
    this.questionContext = null;
    this.resetComments();
    this.prefetchPromise = null;
    this.schedulePrefetch();
    return this.current;
  }

  /** 预取下一页，放到缓存 */
  async prefetchNext(): Promise<void> {
    if (!this.nextUrl || this.prefetchPromise) return;
    if (!vscode.workspace.getConfiguration('zhihuReader').get<boolean>('prefetchNextPage', true)) return;
    const client = await this.ensureClient();
    const requestedUrl = this.nextUrl;
    const requestedMode = this.mode;
    const task = (async () => {
      try {
        let page = requestedMode === 'question'
          ? await client.fetchNextAnswerPage(requestedUrl)
          : await client.fetchNextPage(requestedUrl);
        if (requestedMode === 'feed') page = await this.filterFeedPage(page, client);
        if (this.nextUrl === requestedUrl && this.mode === requestedMode) this.prefetchedPage = page;
      } catch {
        // 预取失败不影响用户稍后主动翻页。
      }
    })();
    this.prefetchPromise = task;
    try {
      await task;
    } finally {
      // 模式切换后可能已有新的预取任务，不应被旧任务清空。
      if (this.prefetchPromise === task) this.prefetchPromise = null;
    }
  }

  private schedulePrefetch(): void {
    setTimeout(() => {
      void this.prefetchNext().catch(() => undefined);
    }, 2000);
  }

  /** 切换到 index 指定的条目；越过末尾时追加下一页 */
  async goTo(index: number): Promise<ZhihuFeedItem | null> {
    if (index < 0) index = 0;
    if (index >= this.items.length) {
      if (!this.nextUrl) {
        // 没有下一页了，回到末尾
        index = this.items.length - 1;
      } else {
        if (this.prefetchPromise) await this.prefetchPromise;
        const client = await this.ensureClient();
        let page = this.prefetchedPage ?? (this.mode === 'question'
          ? await client.fetchNextAnswerPage(this.nextUrl)
          : await client.fetchNextPage(this.nextUrl));
        if (this.mode === 'feed' && !this.prefetchedPage) page = await this.filterFeedPage(page, client);
        this.items.push(...page.items);
        this.nextUrl = page.next;
        this.prefetchedPage = null;
        if (index >= this.items.length) index = this.items.length - 1;
      }
    }
    this.index = index;
    this.resetComments();
    this.schedulePrefetch();
    return this.current;
  }

  /** 刷新当前条目（重新从 feed 里读取） */
  currentRefreshed(): ZhihuFeedItem | null {
    return this.current;
  }

  /** 按需读取当前回答的第一页评论，不缓存评论正文。 */
  async loadCurrentComments(): Promise<CommentPage> {
    const answerId = this.currentAnswerId;
    if (!answerId) throw new ZhihuError('当前内容不是可读取评论的回答');
    const client = await this.ensureClient();
    const page = await client.fetchAnswerComments(answerId, 20);
    this.commentAnswerId = answerId;
    this.commentNextUrl = page.next;
    return page;
  }

  /** 读取当前回答的下一页评论；回答切换后旧分页自动失效。 */
  async loadMoreCurrentComments(): Promise<CommentPage | null> {
    const answerId = this.currentAnswerId;
    if (!answerId || answerId !== this.commentAnswerId || !this.commentNextUrl) return null;
    const client = await this.ensureClient();
    const page = await client.fetchNextComments(this.commentNextUrl);
    this.commentNextUrl = page.next;
    return page;
  }

  private resetComments(): void {
    this.commentAnswerId = null;
    this.commentNextUrl = null;
  }

  private currentQuestionId(): number | string | null {
    const target = this.current?.target;
    if (!target) return null;
    return target.question?.id ?? (target.type === 'question' ? target.id ?? null : null);
  }

  updateStatusBar(): void {
    if (!this.isActive) {
      this.statusBar.hide();
      return;
    }
    this.statusBar.text = `$(book) 知乎 · ${this.index + 1}/${this.items.length}`;
    this.statusBar.tooltip = 'Zhihu Reader';
    this.statusBar.show();
  }
}
