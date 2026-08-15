const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'sidebar.ts'), 'utf8');

test('Webview 内嵌脚本语法有效', () => {
  const match = /<script nonce="\$\{nonce\}">([\s\S]*?)<\/script>/.exec(source);
  assert.ok(match, '应能找到 Webview 脚本');
  assert.doesNotThrow(() => new Function(match[1]));
});

test('打开原文按钮位于顶部栏而非正文', () => {
  const header = /<header class="topbar">([\s\S]*?)<\/header>/.exec(source);
  assert.ok(header, '应能找到顶部栏');
  assert.match(header[1], /id="original"/);
  const body = /<main id="viewport">([\s\S]*?)<\/main>/.exec(source);
  assert.ok(body, '应能找到正文容器');
  assert.doesNotMatch(body[1], /id="original"/);
});

test('阅读器包含进度、显示设置和防误触提示', () => {
  assert.match(source, /id="progress"/);
  assert.match(source, /\.progress \{[^}]*background: var\(--vscode-descriptionForeground/);
  assert.doesNotMatch(source, /\.progress \{[^}]*#1772f6/);
  assert.match(source, /id="displayPanel"/);
  assert.match(source, /继续滚动切换下一条/);
  assert.doesNotMatch(source, /阅读历史/);
});

test('显示设置使用可收起浮层且不占正文布局', () => {
  assert.match(source, /\.app \{[^}]*grid-template-rows: auto minmax\(0, 1fr\)/);
  assert.match(source, /\.display-panel \{[\s\S]*?position: absolute/);
  assert.match(source, /id="displayClose"/);
  assert.match(source, /displayPanel\.hidden = true/);
});

test('回答评论使用独立只读抽屉且按需触发', () => {
  assert.match(source, /id="commentDrawer"/);
  assert.match(source, /class="comment-drawer"/);
  assert.match(source, /action\('loadComments'\)/);
  assert.match(source, /element\('button', 'comment-action'\)/);
  assert.match(source, /createElementNS\('http:\/\/www\.w3\.org\/2000\/svg', 'svg'\)/);
  assert.match(source, /class', 'comment-icon'/);
  assert.match(source, /\.comment-action \{[\s\S]*?border: 1px solid var\(--vscode-widget-border, #484c55\)/);
  assert.match(source, /setAttribute\('aria-label', '查看 '/);
  assert.doesNotMatch(source, />旧版接口</);
  assert.doesNotMatch(source, /发布评论|回复评论|删除评论/);
});

test('回答元数据删除重复类型并优先保持单行对齐', () => {
  assert.match(source, /doc\.kind === 'answer'.*value === '回答'/);
  assert.match(source, /\.meta-row \{[^}]*align-items: center/);
  assert.match(source, /\.meta \{[^}]*flex-wrap: nowrap/);
  assert.doesNotMatch(source, /item\.kind === 'question' \? '问题' : '回答'/);
});
