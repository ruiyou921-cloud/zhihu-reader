const test = require('node:test');
const assert = require('node:assert/strict');

const { htmlToMarkdown } = require('../out/html2md');
const {
  feedItemToMarkdown,
  filterZhihuFeedItems,
  isZhihuAdvertisement,
  normalizeZhihuOriginalUrl,
} = require('../out/converter');

test('保留标题、强调、列表和代码块', () => {
  const markdown = htmlToMarkdown(
    '<h2>标题</h2><p>正文<strong>加粗</strong></p><ol><li>一</li><li>二</li></ol><pre><code>const a = 1;</code></pre>'
  );
  assert.match(markdown, /## 标题/);
  assert.match(markdown, /正文\*\*加粗\*\*/);
  assert.match(markdown, /1\. 一\n2\. 二/);
  assert.match(markdown, /```\nconst a = 1;\n```/);
});

test('表格按最大列数补齐表头', () => {
  const markdown = htmlToMarkdown(
    '<table><tr><th>A</th></tr><tr><td>1</td><td>2</td></tr></table>'
  );
  assert.equal(markdown.trim(), '| A |  |\n| --- | --- |\n| 1 | 2 |');
});

test('问题条目使用自身 ID 生成原文地址', () => {
  const doc = feedItemToMarkdown({
    type: 'question',
    target: { id: 123, type: 'question', title: '测试问题', content: '正文' },
  });
  assert.equal(doc.url, 'https://www.zhihu.com/question/123');
});

test('回答优先生成标准网页地址，不使用接口地址', () => {
  const doc = feedItemToMarkdown({
    type: 'feed',
    target: {
      id: 456,
      type: 'answer',
      question: { id: 123, title: '测试问题' },
      title: '测试回答',
      content: '正文',
      url: 'https://api.zhihu.com/answers/456',
    },
  });
  assert.equal(doc.url, 'https://www.zhihu.com/question/123/answer/456');
  assert.equal(normalizeZhihuOriginalUrl(doc.url), doc.url);
});

test('未知类型不会把知乎 API 地址暴露为原文地址', () => {
  const doc = feedItemToMarkdown({
    target: { id: 456, type: 'unknown', title: '未知条目', url: 'https://api.zhihu.com/items/456' },
  });
  assert.equal(doc.url, undefined);
});

test('广告过滤只匹配明确推广标记，不匹配正文关键词', () => {
  const normal = {
    type: 'feed',
    target: { id: 1, type: 'answer', title: '如何评价广告行业？', content: '讨论广告的普通回答' },
  };
  const items = [
    normal,
    { type: 'feed_advert', target: { id: 2, type: 'article' } },
    { type: 'feed', target: { id: 3, type: 'commercial' } },
    { type: 'feed', promotion_extra: { campaign_id: 4 }, target: { id: 4, type: 'article' } },
    { type: 'feed', extra: { is_sponsored: true }, target: { id: 5, type: 'answer' } },
  ];
  assert.equal(isZhihuAdvertisement(normal), false);
  assert.deepEqual(filterZhihuFeedItems(items), [normal]);
});

test('原文地址只允许知乎 HTTPS 页面', () => {
  assert.equal(
    normalizeZhihuOriginalUrl('https://www.zhihu.com/question/123'),
    'https://www.zhihu.com/question/123'
  );
  assert.throws(() => normalizeZhihuOriginalUrl('https://evil.example/question/123'), /不安全/);
  assert.throws(() => normalizeZhihuOriginalUrl('http://www.zhihu.com/question/123'), /不安全/);
});
