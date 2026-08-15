const test = require('node:test');
const assert = require('node:assert/strict');

const { ZhihuClient, normalizeZhihuApiUrl, normalizeZhihuCommentApiUrl } = require('../out/fetcher');

test('拒绝非知乎域名和非 API 路径', () => {
  assert.throws(
    () => normalizeZhihuApiUrl('https://evil.example/api/v3/feed'),
    /不安全/
  );
  assert.throws(
    () => normalizeZhihuApiUrl('https://www.zhihu.com/question/1'),
    /不安全/
  );
});

test('恶意分页地址不会触发携带 Cookie 的请求', async () => {
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return new Response('{}', { status: 200 });
  };
  const client = new ZhihuClient('z_c0=secret', fakeFetch, 0);
  await assert.rejects(
    client.fetchNextPage('https://evil.example/api/v3/feed?page=2'),
    /不安全/
  );
  assert.equal(called, false);
});

test('后续推荐页兼容 paging.next 并限制请求参数', async () => {
  let requestedUrl = '';
  let requestedInit;
  const fakeFetch = async (url, init) => {
    requestedUrl = String(url);
    requestedInit = init;
    return new Response(JSON.stringify({
      data: [],
      paging: {
        is_end: false,
        next: 'https://www.zhihu.com/api/v3/feed/topstory/recommend?limit=20&page=3',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new ZhihuClient('_xsrf=token; z_c0=secret', fakeFetch, 0);
  const first = await client.fetchRecommendFeed(999);
  assert.match(requestedUrl, /limit=20/);
  assert.equal(requestedInit.redirect, 'manual');
  assert.equal(requestedInit.headers.Cookie, '_xsrf=token; z_c0=secret');
  assert.match(first.next, /page=3/);

  const next = await client.fetchNextPage(first.next);
  assert.match(next.next, /page=3/);
});

test('超过超时时间后终止请求', async () => {
  const fakeFetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const client = new ZhihuClient('z_c0=secret', fakeFetch, 0, 20);
  await assert.rejects(client.fetchRecommendFeed(1), /请求超时/);
});

test('评论分页只允许两个知乎只读端点', () => {
  assert.doesNotThrow(() => normalizeZhihuCommentApiUrl(
    'https://www.zhihu.com/api/v4/answers/123/comments?limit=20&offset=20'
  ));
  assert.doesNotThrow(() => normalizeZhihuCommentApiUrl(
    'https://www.zhihu.com/api/v4/comment_v5/answers/123/root_comment?limit=20&offset=20'
  ));
  assert.throws(() => normalizeZhihuCommentApiUrl(
    'https://www.zhihu.com/api/v4/questions/123/answers'
  ), /非评论接口/);
});

test('旧版评论接口受限时回退 comment_v5 且始终使用 GET', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/answers/123/comments')) {
      return new Response('{"error":{"message":"forbidden"}}', { status: 403 });
    }
    return new Response(JSON.stringify({
      data: [{
        id: 456,
        content: '<p>只读评论</p>',
        author: { member: { name: '测试用户', headline: '签名' } },
        created_time: 1700000000,
        vote_count: 3,
        child_comment_count: 2,
      }],
      paging: { is_end: true },
    }), { status: 200 });
  };
  const client = new ZhihuClient('z_c0=secret', fakeFetch, 0);
  const page = await client.fetchAnswerComments(123);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.init.method === 'GET'));
  assert.ok(calls.every((call) => call.init.headers.Cookie === 'z_c0=secret'));
  assert.match(calls[1].url, /comment_v5\/answers\/123\/root_comment/);
  assert.equal(page.source, 'comment_v5');
  assert.equal(page.items[0].authorName, '测试用户');
  assert.equal(page.items[0].childCommentCount, 2);
});

test('恶意评论分页地址不会触发携带 Cookie 的请求', async () => {
  let called = false;
  const client = new ZhihuClient('z_c0=secret', async () => {
    called = true;
    return new Response('{}', { status: 200 });
  }, 0);
  await assert.rejects(
    client.fetchNextComments('https://www.zhihu.com/api/v4/me'),
    /非评论接口/
  );
  assert.equal(called, false);
});
