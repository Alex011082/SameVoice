// @ts-nocheck — сторож читает файлы через node:*, а в web нет @types/node (types: vite/client)
/**
 * Текст во всю ширину своего блока.
 *
 * Владелец 01.11.2026 (не первый раз): подзаголовки и абзацы не должны обрываться на середине экрана.
 * Поэтому на тексте нет ограничения длины строки в ch/em (и Tailwind max-w-prose, max-w-[NNch]),
 * нет балансировки переносов (text-wrap: balance|pretty, text-balance, text-pretty), а абзацы и
 * заголовки не сужаются ни классами max-w-xl/2xl/…, ни правилами CSS с max-width в px/rem/em
 * (h1 { max-width: 680px }, .hero .sub, .intro, *-copy, *-head…); ограничивать можно только внешний контейнер страницы.
 * Сторож читает все отслеживаемые исходники, кроме сборок, зависимостей и документации.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const ROOT = join(dirname(HERE), '..', '..');
const SELF = relative(ROOT, HERE);
const SKIP = /(^|\/)(node_modules|dist|build|vendor|docs|design)\/|\.min\.|\.(md|lock|json|map)$/;
const SOURCE = /\.(css|scss|sass|less|html|jsx?|tsx?|mjs|cjs|vue|svelte|astro|py)$/;

const files = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((f: string) => f && f !== SELF && SOURCE.test(f) && !SKIP.test(f));

const RULES: [string, RegExp][] = [
  ['caps the text line (inline style)', /style\s*=\s*["'][^"']*max-(?:width|inline-size)\s*:\s*[\d.]+ch\b/],
  ['balances wrapping', /text-wrap(?:-style)?\s*:\s*(?:balance|pretty)/],
  ['caps the text line (inline style)', /(?:maxWidth|maxInlineSize)\s*:\s*['"`][\d.]+ch['"`]/],
  ['balances wrapping (inline style)', /textWrap\s*:\s*['"`](?:balance|pretty)/],
  ['uses a Tailwind text measure', /(^|[\s"'`{:])(?:max-w-prose|max-w-\[[\d.]+(?:ch|em)\]|text-balance|text-pretty)(?=[\s"'`}]|$)/],
];
// правило CSS адресовано тексту: последний составной селектор — текстовый элемент или текстовый блок
const TEXT_EL = /^(p|h[1-6]|small|li|blockquote|figcaption|dd|dt)(?![\w-])/;
const TEXT_CLASS = /\.[\w-]*?(?:^|[-_]|\b)(lead|lede|sub|subtitle|subline|subhead|intro|desc|description|copy|note|hint|tagline|deck|kicker|eyebrow|title|heading|head|caption|blurb|summary|message|text|bio|headline)(?![\w-])/i;
const isTextSelector = (sel: string) => sel.split(',').every((part: string) => {
  const last = part.trim().split(/[\s>+~]+/).pop() || '';
  if (!last || /^[@:]/.test(last) || /media|img|image|svg|video|figure|avatar|logo|icon/i.test(last)) return false;
  return TEXT_EL.test(last) || TEXT_CLASS.test(last);
});
const TEXT_CAP = /(^|[;{\s])max-(?:width|inline-size)\s*:\s*(?!none|100%)[\d.]+(?:px|rem|em|ch)\b/;
const CH_CAP = /(^|[;{\s])max-(?:width|inline-size)\s*:\s*[\d.]+ch\b/;
const RULE = /(?<=^|[{}])([^{}]+)\{([^{}]*)\}/g;
const selOf = (raw: string) => raw.replace(/^[\s\S]*(?:[;}]|\*\/)/, '').trim().replace(/\s+/g, ' ');
const NARROW_TEXT_TAG = /<(p|h[1-6])(\s[^>]*)?>/gs;
const NARROW_CLASS = /(^|[\s"'`{:])max-w-(?:xs|sm|md|lg|xl|[2-7]xl|\[[\d.]+(?:rem|px)\])(?=[\s"'`}]|$)/;

test('no text line is capped and no wrapping is balanced', () => {
  assert.ok(files.length > 0, 'no source files found');
  const found: string[] = [];
  for (const file of files) {
    let src;
    try { src = readFileSync(join(ROOT, file), 'utf8'); } catch { continue; }
    src.split('\n').forEach((line: string, i: number) => {
      for (const [what, re] of RULES) if (re.test(line)) found.push(`${file}:${i + 1} ${what}: ${line.trim().slice(0, 120)}`);
    });
    if (/\.(css|scss|sass|less|html|py|tsx?|jsx?|mjs|cjs|vue|svelte|astro)$/.test(file)) {
      // обрезка с многоточием — не мера строки, в том числе если ограничение лежит в другом правиле того же селектора
      const truncating = new Set();
      for (const m of src.matchAll(RULE)) if (/ellipsis|nowrap/.test(m[2] ?? '')) truncating.add(selOf(m[1] ?? ''));
      for (const m of src.matchAll(RULE)) {
        const [whole, rawSel = '', body = ''] = m;
        const sel = selOf(rawSel);
        if (/ellipsis|nowrap/.test(body) || truncating.has(sel)) continue;
        if (CH_CAP.test(body) || (TEXT_CAP.test(body) && isTextSelector(sel))) {
          const line = src.slice(0, (m.index ?? 0) + whole.length).split('\n').length;
          found.push(`${file}:${line} narrows text block ${sel.slice(0, 60)}: ${body.trim().slice(0, 80)}`);
        }
      }
    }
    if (/\.(css|scss|sass|less)$/.test(file)) continue;
    for (const m of src.matchAll(NARROW_TEXT_TAG)) {
      if (!/truncate/.test(m[0]) && NARROW_CLASS.test(m[0])) {
        const line = src.slice(0, m.index ?? 0).split('\n').length;
        found.push(`${file}:${line} narrows <${m[1] ?? ''}> with max-w-*: ${m[0].replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
  }
  assert.deepEqual(found, [], `text must span its block:\n${found.join('\n')}`);
});
