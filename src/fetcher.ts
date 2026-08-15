import { ZhihuFeedItem, ZhihuTarget } from './converter';

export interface FeedPage {
  items: ZhihuFeedItem[];
  next: string | null;
  sessionToken: string;
}

export interface ZhihuQuestionDetail {
  id: number | string;
  title: string;
  detail?: string;
  excerpt?: string;
  answer_count?: number;
  follower_count?: number;
  comment_count?: number;
}

export interface ZhihuComment {
  id: number | string;
  content: string;
  authorName: string;
  authorHeadline: string;
  replyToName: string;
  createdTime?: number;
  voteCount: number;
  childCommentCount: number;
}

export interface CommentPage {
  items: ZhihuComment[];
  next: string | null;
  source: 'legacy' | 'comment_v5';
}

// 知乎桌面网页使用的回答字段表达式。回答接口要求字段位于 data[*] 下，
// 直接传 content,author 等根字段会返回 403「请求参数异常」。
const ANSWER_INCLUDE = [
  'data[*].is_normal',
  'admin_closed_comment',
  'reward_info',
  'is_collapsed',
  'collapse_reason',
  'is_sticky',
  'comment_count',
  'can_comment',
  'content',
  'voteup_count',
  'comment_permission',
  'created_time',
  'updated_time',
  'question',
  'excerpt',
  'relationship.is_authorized',
  'is_author',
  'voting',
  'is_thanked',
  'is_nothelp',
  'is_recognized',
].join(',') + ';data[*].author.follower_count,vip_info,badge[*].topics';

export class ZhihuError extends Error {
  constructor(message: string, public readonly code?: number, public readonly body?: string) {
    super(message);
    this.name = 'ZhihuError';
  }
}

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const ALLOWED_API_HOSTS = new Set(['www.zhihu.com']);
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * 分页地址来自远端响应。发送 Cookie 前必须再次验证协议、主机与路径，
 * 避免异常分页地址把登录凭据带到非知乎站点。
 */
export function normalizeZhihuApiUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ZhihuError('知乎接口返回了无效的分页地址');
  }
  if (
    url.protocol !== 'https:' ||
    !ALLOWED_API_HOSTS.has(url.hostname.toLowerCase()) ||
    (url.port !== '' && url.port !== '443') ||
    url.username !== '' ||
    url.password !== '' ||
    !url.pathname.startsWith('/api/')
  ) {
    throw new ZhihuError('已阻止不安全的知乎分页地址');
  }
  return url.toString();
}

/** 评论分页只允许停留在两个已知的只读评论端点中。 */
export function normalizeZhihuCommentApiUrl(input: string): string {
  const normalized = normalizeZhihuApiUrl(input);
  const url = new URL(normalized);
  const allowedPath =
    /^\/api\/v4\/answers\/\d+\/comments$/.test(url.pathname) ||
    /^\/api\/v4\/comment_v5\/answers\/\d+\/root_comment$/.test(url.pathname);
  if (!allowedPath) throw new ZhihuError('已阻止非评论接口的分页地址');
  return normalized;
}

export function extractXsrf(cookie: string): string {
  const m = /(?:^|;)\s*_xsrf\s*=\s*([^;]+)/i.exec(cookie);
  return m ? m[1].trim() : '';
}

/**
 * 简单令牌桶限速器：保证任意两个请求间隔 >= intervalMs，且串行执行。
 */
export class RateLimiter {
  private last = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private intervalMs: number) {}

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const now = Date.now();
      const wait = Math.max(0, this.last + this.intervalMs - now);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      return fn();
    };
    const p = this.chain.then(run, run);
    this.chain = p.then(
      () => undefined,
      () => undefined
    );
    return p;
  }
}

export class ZhihuClient {
  private limiter: RateLimiter;

  constructor(
    private cookie: string,
    private fetchImpl: typeof fetch = fetch,
    intervalMs = 1600,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS
  ) {
    this.limiter = new RateLimiter(intervalMs);
  }

  setIntervalMs(ms: number): void {
    this.limiter = new RateLimiter(ms);
  }

  private async request<T>(input: string): Promise<T> {
    const url = normalizeZhihuApiUrl(input);
    let res: Response;
    try {
      res = await this.limiter.enqueue(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(1, this.timeoutMs));
        try {
          return await this.fetchImpl(url, {
            method: 'GET',
            headers: {
              'User-Agent': DESKTOP_UA,
              'Accept': 'application/json, text/plain, */*',
              'x-requested-with': 'fetch',
              'Referer': 'https://www.zhihu.com/',
              'Cookie': this.cookie,
            },
            // 不自动跟随跳转，避免登录 Cookie 被带到重定向目标。
            redirect: 'manual',
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      });
    } catch (error) {
      if (error instanceof ZhihuError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ZhihuError('知乎请求超时，请检查网络后重试');
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ZhihuError(`知乎网络请求失败：${message}`);
    }

    const text = await res.text();
    if (!res.ok) {
      let reason = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text);
        if (j?.error?.message) reason = `${reason}: ${j.error.message}`;
      } catch {
        /* ignore */
      }
      throw new ZhihuError(`知乎请求失败 ${reason}`, res.status, text);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ZhihuError('知乎响应不是合法 JSON', res.status, text);
    }
  }

  /**
   * 拉取个性化推荐 feed。
   * sessionToken 取自 cookie 的 _xsrf，缺省时用空串。
   */
  async fetchRecommendFeed(pageSize: number): Promise<FeedPage> {
    const xsrf = extractXsrf(this.cookie);
    const limit = Math.max(1, Math.min(20, Math.trunc(pageSize)));
    const url =
      `https://www.zhihu.com/api/v3/feed/topstory/recommend` +
      `?action=down&limit=${limit}&session_token=${encodeURIComponent(xsrf)}`;
    const data = await this.request<{
      data?: ZhihuFeedItem[];
      next?: string | null;
      paging?: { is_end?: boolean; next?: string };
    }>(url);

    const items = data?.data ?? [];
    let next = data?.next ?? data?.paging?.next ?? null;
    // 保证下一页同样带 session_token
    if (next) {
      const u = new URL(next);
      if (xsrf && !u.searchParams.has('session_token')) {
        u.searchParams.set('session_token', xsrf);
      }
      next = u.toString();
    }
    return { items, next, sessionToken: xsrf };
  }

  /** 按给定的 next 链接拉取后续页 */
  async fetchNextPage(nextUrl: string): Promise<FeedPage> {
    const xsrf = extractXsrf(this.cookie);
    let url = nextUrl;
    if (xsrf && !url.includes(`session_token=`)) {
      const u = new URL(url);
      u.searchParams.set('session_token', xsrf);
      url = u.toString();
    }
    const data = await this.request<{
      data?: ZhihuFeedItem[];
      next?: string | null;
      paging?: { is_end?: boolean; next?: string };
    }>(url);
    return {
      items: data?.data ?? [],
      next: data?.next ?? (data?.paging?.is_end ? null : data?.paging?.next ?? null),
      sessionToken: xsrf,
    };
  }

  /** 获取问题标题、描述和回答数。 */
  async fetchQuestionDetail(qid: number | string): Promise<ZhihuQuestionDetail> {
    const include = encodeURIComponent('detail,answer_count,follower_count,comment_count');
    try {
      return await this.request<ZhihuQuestionDetail>(
        `https://www.zhihu.com/api/v4/questions/${qid}?include=${include}`
      );
    } catch (error) {
      throw prefixZhihuError(error, '获取问题详情失败');
    }
  }

  /** 获取问题的第一页回答。 */
  async fetchQuestionAnswers(qid: number | string, pageSize: number): Promise<FeedPage> {
    const include = encodeURIComponent(ANSWER_INCLUDE);
    const limit = Math.max(1, Math.min(20, Math.trunc(pageSize)));
    const url =
      `https://www.zhihu.com/api/v4/questions/${qid}/answers` +
      `?include=${include}&limit=${limit}&offset=0&platform=desktop&sort_by=default`;
    try {
      return await this.fetchAnswerPage(url);
    } catch (error) {
      throw prefixZhihuError(error, '获取问题回答失败');
    }
  }

  /** 按 paging.next 获取后续回答页。 */
  async fetchNextAnswerPage(nextUrl: string): Promise<FeedPage> {
    try {
      return await this.fetchAnswerPage(nextUrl);
    } catch (error) {
      throw prefixZhihuError(error, '获取后续回答失败');
    }
  }

  /**
   * 按回答 ID 按需读取第一页根评论。仅使用 GET；旧版接口不可用时尝试新版 comment_v5。
   */
  async fetchAnswerComments(answerId: number | string, pageSize = 20): Promise<CommentPage> {
    const id = normalizeNumericId(answerId, '回答');
    const limit = Math.max(1, Math.min(20, Math.trunc(pageSize)));
    const legacy =
      `https://www.zhihu.com/api/v4/answers/${id}/comments` +
      `?order_by=score&limit=${limit}&offset=0&status=open`;
    try {
      return await this.fetchCommentPage(legacy, 'legacy');
    } catch (legacyError) {
      if (!(legacyError instanceof ZhihuError) || ![403, 404].includes(legacyError.code ?? 0)) {
        throw prefixZhihuError(legacyError, '读取回答评论失败');
      }
      const modern =
        `https://www.zhihu.com/api/v4/comment_v5/answers/${id}/root_comment` +
        `?order_by=score&limit=${limit}&offset=0`;
      try {
        return await this.fetchCommentPage(modern, 'comment_v5');
      } catch (modernError) {
        const oldCode = legacyError.code ?? '未知';
        const newCode = modernError instanceof ZhihuError ? modernError.code ?? '未知' : '未知';
        throw new ZhihuError(
          `只读评论接口验证失败：旧版 HTTP ${oldCode}，新版 HTTP ${newCode}`,
          modernError instanceof ZhihuError ? modernError.code : undefined
        );
      }
    }
  }

  /** 读取由知乎响应给出的后续评论页，发送 Cookie 前会重新校验地址。 */
  async fetchNextComments(nextUrl: string): Promise<CommentPage> {
    const url = normalizeZhihuCommentApiUrl(nextUrl);
    const source = url.includes('/comment_v5/') ? 'comment_v5' : 'legacy';
    return this.fetchCommentPage(url, source);
  }

  private async fetchAnswerPage(url: string): Promise<FeedPage> {
    const data = await this.request<{
      data?: Array<ZhihuTarget | ZhihuFeedItem>;
      next?: string | null;
      paging?: { is_end?: boolean; next?: string };
    }>(url);
    const items = (data.data ?? []).map((entry) => {
      if ('target' in entry && entry.target) return entry as ZhihuFeedItem;
      return { type: 'answer', target: entry as ZhihuTarget };
    });
    const next = data.next ?? (data.paging?.is_end ? null : data.paging?.next ?? null);
    return { items, next, sessionToken: extractXsrf(this.cookie) };
  }

  private async fetchCommentPage(
    input: string,
    source: CommentPage['source']
  ): Promise<CommentPage> {
    const url = normalizeZhihuCommentApiUrl(input);
    const data = await this.request<{
      data?: unknown[];
      paging?: { is_end?: boolean; next?: string | null };
      next?: string | null;
    }>(url);
    const items = (data.data ?? []).map(normalizeComment).filter((item): item is ZhihuComment => item !== null);
    const next = data.next ?? (data.paging?.is_end ? null : data.paging?.next ?? null);
    return { items, next: next ? normalizeZhihuCommentApiUrl(next) : null, source };
  }
}

function normalizeNumericId(value: number | string, label: string): string {
  const id = String(value).trim();
  if (!/^\d+$/.test(id)) throw new ZhihuError(`${label} ID 无效`);
  return id;
}

function normalizeComment(value: unknown): ZhihuComment | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = raw.id;
  if ((typeof id !== 'number' && typeof id !== 'string') || !String(id).trim()) return null;
  const author = readMember(raw.author ?? raw.member);
  const replyTo = readMember(raw.reply_to_author ?? raw.reply_to);
  return {
    id,
    content: typeof raw.content === 'string' ? raw.content : '',
    authorName: author.name || '知乎用户',
    authorHeadline: author.headline,
    replyToName: replyTo.name,
    createdTime: typeof raw.created_time === 'number' ? raw.created_time : undefined,
    voteCount: finiteCount(raw.vote_count),
    childCommentCount: finiteCount(raw.child_comment_count),
  };
}

function readMember(value: unknown): { name: string; headline: string } {
  if (!value || typeof value !== 'object') return { name: '', headline: '' };
  const raw = value as Record<string, unknown>;
  const nested = raw.member && typeof raw.member === 'object'
    ? raw.member as Record<string, unknown>
    : raw;
  return {
    name: typeof nested.name === 'string' ? nested.name : '',
    headline: typeof nested.headline === 'string' ? nested.headline : '',
  };
}

function finiteCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function prefixZhihuError(error: unknown, prefix: string): ZhihuError {
  if (error instanceof ZhihuError) {
    return new ZhihuError(`${prefix}：${error.message}`, error.code, error.body);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ZhihuError(`${prefix}：${message}`);
}

/** 校验 cookie 是否有效：请求一次推荐接口第一页，抛出异常说明原因 */
export async function validateCookie(cookie: string, intervalMs = 1600): Promise<void> {
  const client = new ZhihuClient(cookie, fetch, intervalMs);
  await client.fetchRecommendFeed(1);
}
