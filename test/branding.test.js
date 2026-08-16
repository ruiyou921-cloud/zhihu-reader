const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

function readPngInfo(file) {
  const data = fs.readFileSync(file);
  assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), colorType: data[25] };
}

test('扩展清单使用独立 PNG 图标和品牌简介', () => {
  assert.equal(manifest.icon, 'resources/icon.png');
  assert.match(manifest.displayName, /知乎阅读/);
  assert.match(manifest.description, /只读评论/);
  assert.equal(manifest.galleryBanner.theme, 'dark');
});

test('默认启用基于明确接口标记的推荐广告过滤', () => {
  assert.equal(manifest.contributes.configuration.properties['zhihuReader.filterAds'].default, true);
});

test('品牌图标和 README 介绍图尺寸正确', () => {
  assert.deepEqual(readPngInfo(path.join(root, 'resources', 'icon.png')), { width: 256, height: 256, colorType: 6 });
  assert.deepEqual(readPngInfo(path.join(root, 'resources', 'overview.png')), { width: 1200, height: 675, colorType: 6 });
  assert.match(readme, /!\[知乎阅读演示\]\(resources\/demo\.gif\)/);
  assert.equal(fs.existsSync(path.join(root, 'resources', 'demo.gif')), true);
});
