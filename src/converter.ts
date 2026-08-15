import { htmlToMarkdown } from './html2md';

export interface ZhihuAuthor {
  name?: string;
  url?: string;
  headline?: string;
  is_following?: boolean;
}

export interface ZhihuQuestion {
  id?: number | string;
  type?: string;
  title?: string;
  answer_count?: number;
  follower_count?: number;
}

export interface ZhihuTarget {
  id?: number | string;
  type?: string;
  title?: string;
  content?: string;
  excerpt?: string;
  answer_type?: string;
  voteup_count?: number;
  comment_count?: number;
  answer_count?: number;
  created_time?: number;
  updated_time?: number;
  author?: ZhihuAuthor;
  question?: ZhihuQuestion;
  url?: string;
  [key: string]: unknown;
}

export interface ZhihuFeedItem {
  type?: string;
  target?: ZhihuTarget;
  [key: string]: unknown;
}

export interface TyporaDocument {
  title: string;
  meta: string[];
  content: string;
  body: string;
  url?: string;
  kind: string;
}

/** 只允许浏览器打开明确的知乎 HTTPS 页面。 */
export function normalizeZhihuOriginalUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('原文地址无效');
  }
  const allowedHosts = new Set(['www.zhihu.com', 'zhuanlan.zhihu.com']);
  if (
    url.protocol !== 'https:' ||
    !allowedHosts.has(url.hostname.toLowerCase()) ||
    (url.port !== '' && url.port !== '443') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error('原文地址不安全');
  }
  return url.toString();
}

function guessTitle(item: ZhihuFeedItem, target: ZhihuTarget): string {
  if (target.title) return target.title;
  if (target.question?.title) return target.question.title;
  if (target.type === 'answer' && target.question?.title) return target.question.title;
  return `知乎条目 #${target.id ?? 'unknown'}`;
}

function guessUrl(item: ZhihuFeedItem, target: ZhihuTarget): string | undefined {
  const kind = target.type ?? item.type;
  const entityId = safeEntityId(target.id);
  const questionId = safeEntityId(target.question?.id ?? (kind === 'question' ? target.id : undefined));

  // 推荐接口里的 target.url 可能是 api.zhihu.com 地址，不能直接交给浏览器。
  // 已知内容类型优先根据实体 ID 生成稳定的知乎网页地址。
  if (kind === 'answer' && questionId && entityId) {
    return `https://www.zhihu.com/question/${questionId}/answer/${entityId}`;
  }
  if (kind === 'article' && entityId) {
    return `https://zhuanlan.zhihu.com/p/${entityId}`;
  }
  if (kind === 'question' && questionId) {
    return `https://www.zhihu.com/question/${questionId}`;
  }
  if (kind === 'pin' && entityId) {
    return `https://www.zhihu.com/pin/${entityId}`;
  }

  // 未知类型只接受已经是白名单网页的地址；API 地址会被丢弃，避免点击时才报错。
  if (target.url) {
    try {
      return normalizeZhihuOriginalUrl(target.url);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function safeEntityId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const id = String(value);
  return /^\d+$/.test(id) ? id : undefined;
}

type UnknownRecord = Record<string, unknown>;

const AD_BOOLEAN_FIELDS = [
  'is_ad',
  'is_advert',
  'is_advertisement',
  'is_commercial',
  'is_promotion',
  'is_promoted',
  'is_sponsored',
] as const;

const AD_PAYLOAD_FIELDS = [
  'ad',
  'advert',
  'advertisement',
  'commercial',
  'promotion',
  'promotion_extra',
  'sponsor',
] as const;

const AD_TYPE_FIELDS = ['type', 'card_type', 'content_type', 'feed_type', 'business_type'] as const;
const AD_TYPE_MARKER = /(^|[_-])(ad|ads|advert|advertisement|commercial|promotion|promoted|sponsor|sponsored)([_-]|$)/i;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function hasExplicitAdMarker(record: UnknownRecord): boolean {
  if (AD_BOOLEAN_FIELDS.some((field) => record[field] === true || record[field] === 1)) return true;
  if (AD_PAYLOAD_FIELDS.some((field) => {
    const value = record[field];
    return value !== undefined && value !== null && value !== false && value !== '';
  })) return true;
  return AD_TYPE_FIELDS.some((field) => {
    const value = record[field];
    return typeof value === 'string' && AD_TYPE_MARKER.test(value.trim());
  });
}

/**
 * 只依据知乎接口中的明确广告/推广结构判断，不使用标题或正文关键词。
 * 这样可以过滤 feed 广告，同时保留讨论“广告”话题的普通回答与文章。
 */
export function isZhihuAdvertisement(item: ZhihuFeedItem): boolean {
  const itemRecord = item as UnknownRecord;
  const targetRecord = asRecord(item.target);
  const records = [
    itemRecord,
    targetRecord,
    asRecord(itemRecord.extra),
    targetRecord ? asRecord(targetRecord.extra) : null,
  ].filter((record): record is UnknownRecord => record !== null);
  return records.some(hasExplicitAdMarker);
}

/** 返回新的推荐条目数组，不修改接口原始数据。 */
export function filterZhihuFeedItems(items: ZhihuFeedItem[]): ZhihuFeedItem[] {
  return items.filter((item) => !isZhihuAdvertisement(item));
}

function fmtTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtCount(n?: number): string {
  if (n === undefined || n === null) return '';
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function feedItemToMarkdown(item: ZhihuFeedItem): TyporaDocument {
  const target = item.target ?? {};
  const kind = target.type ?? item.type ?? 'unknown';

  const title = guessTitle(item, target);
  const url = guessUrl(item, target);

  const authorName = target.author?.name;
  const authorUrl = target.author?.url;

  let rawContent = target.content ?? target.excerpt ?? '';
  if (!rawContent) rawContent = '';

  let body = htmlToMarkdown(rawContent, { imagePlaceholder: '' });

  // 去掉空内容占位
  if (!body.trim()) {
    body = target.excerpt ? htmlToMarkdown(target.excerpt, { imagePlaceholder: '' }).trim() : '';
    if (!body) body = '（无正文）';
  }

  const meta: string[] = [];
  const typeName = { answer: '回答', article: '文章', question: '问题', pin: '想法' }[kind] ?? kind;
  meta.push(typeName);
  if (authorName) {
    meta.push(authorUrl ? `[${authorName}](${authorUrl})` : authorName);
  }
  if (target.question?.title && target.title && target.question.title !== target.title) {
    meta.push(`问题：${target.question.title}`);
  }
  const t = fmtTime(target.created_time);
  if (t) meta.push(t);
  if (target.voteup_count !== undefined) meta.push(`赞 ${fmtCount(target.voteup_count)}`);
  if (target.comment_count !== undefined) meta.push(`评 ${fmtCount(target.comment_count)}`);

  const out: string[] = [];
  out.push(`# ${title}`);
  out.push('');
  if (meta.length) {
    out.push(`> ${meta.join(' · ')}`);
    out.push('');
  }
  out.push(body.trim());
  if (url) {
    out.push('');
    out.push('---');
    out.push(`[查看知乎原文](${url})`);
  }
  return {
    title,
    meta,
    content: body.trim(),
    body: out.join('\n'),
    url,
    kind,
  };
}
