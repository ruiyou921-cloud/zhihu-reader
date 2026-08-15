import { parse, HTMLElement, Node } from 'node-html-parser';

export interface HtmlToMdOptions {
  imagePlaceholder?: string;
}

/**
 * 将知乎正文/回答的 HTML 转换成 Markdown。
 * - 保留代码块（含语言标注）、链接、加粗/斜体、列表、引用、表格、标题
 * - 图片一律替换为占位文本
 */
export function htmlToMarkdown(html: string, opts: HtmlToMdOptions = {}): string {
  const placeholder = opts.imagePlaceholder ?? '[图片]';
  const root = parse(html);
  const lines: string[] = [];
  for (const child of root.childNodes) {
    collectBlock(child as Node, lines, placeholder);
  }
  return lines.join('\n');
}

const CODE_LANG_RE = /language-([\w#+-]+)/i;

function isElement(n: Node): n is HTMLElement {
  return !!(n as HTMLElement).tagName;
}

function collectBlock(node: Node, out: string[], placeholder: string): void {
  if (!isElement(node)) {
    const text = (node as any).rawText ?? '';
    const cleaned = cleanupInline(text);
    if (cleaned.trim()) out.push(cleaned.trim());
    return;
  }
  const el = node as HTMLElement;
  const tag = el.rawTagName.toLowerCase();

  switch (tag) {
    case 'br':
      out.push('');
      return;
    case 'hr':
      out.push('---');
      return;
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const level = parseInt(tag[1], 10);
      const text = inline(el, placeholder).trim();
      out.push(`${'#'.repeat(level)} ${text}`);
      out.push('');
      return;
    }
    case 'blockquote': {
      for (const child of el.childNodes) {
        const sub: string[] = [];
        collectBlock(child as Node, sub, placeholder);
        for (const line of sub) out.push(line ? `> ${line}` : '>');
      }
      out.push('');
      return;
    }
    case 'ul':
    case 'ol': {
      collectList(el, out, placeholder, tag === 'ol', 0);
      out.push('');
      return;
    }
    case 'pre': {
      out.push(codeBlockFromPre(el));
      out.push('');
      return;
    }
    case 'code': {
      out.push(codeBlock(el, placeholder));
      out.push('');
      return;
    }
    case 'figure': {
      // 知乎代码块/图片常被包在 <figure> 里
      const pre = el.querySelector('pre');
      if (pre) {
        out.push(codeBlockFromPre(pre as HTMLElement));
        out.push('');
        return;
      }
      const img = el.querySelector('img');
      if (img) {
        out.push(placeholder);
        out.push('');
        return;
      }
      for (const child of el.childNodes) collectBlock(child as Node, out, placeholder);
      return;
    }
    case 'img':
      out.push(placeholder);
      out.push('');
      return;
    case 'table': {
      const tbl = tableMd(el, placeholder);
      if (tbl) out.push(tbl, '');
      return;
    }
    case 'p': {
      const text = inline(el, placeholder).trim();
      if (text) out.push(text, '');
      return;
    }
    case 'div':
    case 'section':
    case 'article': {
      for (const child of el.childNodes) collectBlock(child as Node, out, placeholder);
      return;
    }
    default: {
      const text = inline(el, placeholder).trim();
      if (text) out.push(text, '');
    }
  }
}

function collectList(el: HTMLElement, out: string[], placeholder: string, ordered: boolean, depth: number): void {
  let idx = 1;
  for (const child of el.childNodes) {
    if (!isElement(child)) continue;
    const li = child as HTMLElement;
    if (li.rawTagName.toLowerCase() !== 'li') continue;
    const bullet = ordered ? `${idx}.` : '-';
    const head = `${'  '.repeat(depth)}${bullet} `;
    // li 的第一个文本/内联作为行首，后续块级继续缩进
    let firstLine = '';
    const rest: string[] = [];
    const inlineNodes: Node[] = [];
    for (const c of li.childNodes) {
      if (isElement(c) && isBlockTag((c as HTMLElement).rawTagName.toLowerCase())) {
        const tmp: string[] = [];
        collectBlock(c as Node, tmp, placeholder);
        rest.push(...tmp);
      } else {
        inlineNodes.push(c as Node);
      }
    }
    firstLine = inline(el, placeholder, inlineNodes).trim();
    out.push(`${head}${firstLine}`);
    for (const r of rest) out.push(r ? `${'  '.repeat(depth)}  ${r}` : '');
    idx++;
  }
}

function isBlockTag(tag: string): boolean {
  return ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'pre', 'figure', 'table', 'div', 'hr'].includes(tag);
}

/** 计算节点内的内联 markdown（不含 block 容器） */
function inline(el: HTMLElement, placeholder: string, only?: Node[]): string {
  const nodes = only ?? el.childNodes;
  let outStr = '';
  for (const child of nodes) {
    outStr += inlineNode(child as Node, placeholder);
  }
  return cleanupInline(outStr);
}

function inlineNode(node: Node, placeholder: string): string {
  if (!isElement(node)) {
    return (node as any).rawText ?? '';
  }
  const el = node as HTMLElement;
  const tag = el.rawTagName.toLowerCase();

  switch (tag) {
    case 'br':
      return '\n';
    case 'img':
      return placeholder;
    case 'a': {
      const href = el.getAttribute('href') ?? '';
      const text = inline(el, placeholder);
      if (!href || !text) return text;
      return `[${text}](${normalizeUrl(href)})`;
    }
    case 'strong':
    case 'b':
      return `**${inline(el, placeholder)}**`;
    case 'em':
    case 'i':
      return `*${inline(el, placeholder)}*`;
    case 'del':
    case 's':
    case 'strike':
      return `~~${inline(el, placeholder)}~~`;
    case 'code': {
      const code = el.text;
      const tick = code.includes('`') ? '``' : '`';
      return `${tick}${code}${tick}`;
    }
    case 'sup':
    case 'sub':
      return inline(el, placeholder);
    case 'span':
    case 'font':
    case 'bdi':
    case 'em-c':
    case 'u':
      return inline(el, placeholder);
    default:
      return inline(el, placeholder);
  }
}

function codeBlock(el: HTMLElement, placeholder: string): string {
  if (el.rawTagName.toLowerCase() === 'code') {
    // 可能是行内 code 当作块；检查是否被提为块使用
    const parent = el.parentNode;
    if (parent && (parent as HTMLElement).rawTagName?.toLowerCase() === 'pre') {
      return codeBlockFromPre(parent as HTMLElement);
    }
    const code = el.text;
    return tooltipCode(code);
  }
  return codeBlockFromPre(el);
}

function codeBlockFromPre(pre: HTMLElement): string {
  // node-html-parser 将 <pre>/<code> 当作 raw text 容器，
  // 内部 markup（<code> 包装、token span）会原样留在 text 里，需手工清洗。
  const raw = pre.text;
  let lang = '';
  if (!lang) {
    const m = CODE_LANG_RE.exec(raw);
    lang = m ? m[1] : '';
  }
  let code = raw
    .replace(/<code[^>]*>/i, '')
    .replace(/<\/code>/i, '')
    .replace(/<\/?(?:span|i|em|b|font|br)[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  code = code.replace(/\r/g, '').replace(/\s+$/, '');
  return `\`\`\`${lang}\n${code.trim()}\n\`\`\``;
}

function tooltipCode(code: string): string {
  return `\`\`\`\n${code}\n\`\`\``;
}

function tableMd(table: HTMLElement, placeholder: string): string {
  const rows = table.querySelectorAll('tr');
  if (rows.length === 0) return '';
  const grid: string[][] = [];
  let cols = 0;
  for (const tr of rows) {
    const cells = tr.querySelectorAll('th, td');
    const row: string[] = [];
    for (const c of cells) {
      const text = inline(c as HTMLElement, placeholder).replace(/\s+/g, ' ').trim();
      row.push(text.replaceAll('|', '\\|'));
    }
    cols = Math.max(cols, row.length);
    grid.push(row);
  }
  if (cols === 0) return '';
  const pad = (r: string[], c: number) => (c < r.length ? r[c] : '');
  const header = grid[0];
  const lines = [`| ${new Array(cols).fill(0).map((_, i) => pad(header, i)).join(' | ')} |`];
  lines.push(`| ${new Array(cols).fill('---').join(' | ')} |`);
  for (let i = 1; i < grid.length; i++) {
    lines.push(`| ${new Array(cols).fill(0).map((_, c) => pad(grid[i], c)).join(' | ')} |`);
  }
  return lines.join('\n');
}

function normalizeUrl(href: string): string {
  let url = href;
  if (url.startsWith('//')) url = `https:${url}`;
  url = url.replace(/&amp;/g, '&');
  return url;
}

/** 压缩空白，但保留换行与列表标记需要的空格 */
function cleanupInline(text: string): string {
  return text
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/ *\n{2,} */g, '\n\n')
    .replace(/\n+$/, '');
}
