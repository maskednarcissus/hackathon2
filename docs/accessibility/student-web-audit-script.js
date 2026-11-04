const { chromium } = require('playwright');
const fs = require('fs');
// Usage: start the app (next start -p 47100) against a mock or real backend, put a test access token in
// token.txt, then: NODE_PATH=$(npm root -g) node student-web-audit-script.js
const BASE = process.env.BASE_URL || 'http://127.0.0.1:47100';
const TOKEN = fs.readFileSync('token.txt', 'utf8').trim();
const SC = '11111111-1111-4111-8111-111111111111';
const PAGES = [
  ['entrar', '/entrar', false],
  ['inicio', '/', true],
  ['aulas', '/aulas', true],
  ['aula', `/aulas/${SC}`, true],
  ['transcricao', `/aulas/${SC}/transcricao?t=60000`, true],
  ['busca', '/busca?q=curva', true],
  ['calendario-mes', '/calendario', true],
  ['calendario-semana', '/calendario?view=semana', true],
  ['calendario-agenda', '/calendario?view=agenda', true],
  ['evento', '/calendario/e1', true],
  ['assistente', '/assistente', true],
  ['revisao', '/revisao?foco=55555555-5555-4555-8555-555555555555&termo=Curva%20IS', true],
  ['revisao-plano', '/revisao/66666666-6666-4666-8666-666666666666', true],
  ['notificacoes', '/notificacoes', true],
  ['preferencias', '/preferencias', true],
];

function checks() {
  const out = { issues: [] };
  const push = (k, d) => out.issues.push(`${k}: ${d}`);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const isSrOnly = (el) => {
    const r = el.getBoundingClientRect();
    return r.width <= 1 && r.height <= 1;
  };
  // landmarks & headings
  if (!document.querySelector('main')) push('landmark', 'no <main>');
  const h1 = document.querySelectorAll('h1').length;
  if (h1 !== 1) push('heading', `${h1} h1 elements`);
  let prev = 0;
  document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
    const l = +h.tagName[1];
    if (prev && l > prev + 1)
      push('heading-order', `${h.tagName} "${h.textContent.trim().slice(0, 40)}" after h${prev}`);
    prev = l;
  });
  if (!document.documentElement.lang) push('lang', 'missing html lang');
  document.querySelectorAll('img').forEach((i) => {
    if (!i.hasAttribute('alt')) push('img-alt', i.src);
  });
  // form labels
  document.querySelectorAll('input:not([type=hidden]),select,textarea').forEach((el) => {
    const labelled =
      el.getAttribute('aria-label') ||
      el.getAttribute('aria-labelledby') ||
      el.closest('label') ||
      (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
    if (!labelled) push('label', `${el.tagName} ${el.name || el.id}`);
  });
  // accessible names
  document.querySelectorAll('a[href],button').forEach((el) => {
    const name =
      (el.getAttribute('aria-label') || el.textContent || '').trim() || el.getAttribute('title');
    if (!name && visible(el)) push('name', `${el.tagName} ${el.outerHTML.slice(0, 80)}`);
  });
  // target size (2.5.8), excluding inline links within text blocks
  const small = [];
  document
    .querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,summary')
    .forEach((el) => {
      if (!visible(el) || isSrOnly(el)) return;
      const r = el.getBoundingClientRect();
      const inline = el.tagName === 'A' && getComputedStyle(el).display === 'inline';
      if (!inline && (r.width < 24 || r.height < 24))
        small.push(
          `${el.tagName}.${el.className} ${Math.round(r.width)}x${Math.round(r.height)} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`,
        );
    });
  small.forEach((s) => push('target-size', s));
  if (document.documentElement.scrollWidth > window.innerWidth + 1)
    push(
      'reflow',
      `horizontal scroll ${document.documentElement.scrollWidth} > ${window.innerWidth}`,
    );
  // contrast
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1]
      .split(/[ ,/]+/)
      .filter(Boolean)
      .map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const bgOf = (el) => {
    let e = el;
    while (e) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0.5) return c;
      e = e.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode;
    if (!t.textContent.trim()) continue;
    const el = t.parentElement;
    if (!el || !visible(el) || isSrOnly(el)) continue;
    const s = getComputedStyle(el);
    const fg = parse(s.color);
    if (!fg) continue;
    const bg = bgOf(el);
    const L1 = lum(fg),
      L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(s.fontSize);
    const bold = +s.fontWeight >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const min = large ? 3 : 4.5;
    const op = parseFloat(s.opacity);
    if (ratio < min && op === 1) {
      const k = `${s.color}|${bg.r},${bg.g},${bg.b}`;
      if (!seen.has(k)) {
        seen.add(k);
        push(
          'contrast',
          `${ratio.toFixed(2)}:1 "${t.textContent.trim().slice(0, 30)}" ${s.color} on rgb(${bg.r},${bg.g},${bg.b})`,
        );
      }
    }
  }
  return out;
}

(async () => {
  const browser = await chromium.launch();
  const report = {};
  for (const scheme of ['light', 'dark']) {
    for (const [w, h] of [
      [375, 812],
      [1280, 900],
    ]) {
      const ctx = await browser.newContext({
        viewport: { width: w, height: h },
        colorScheme: scheme,
        deviceScaleFactor: 1,
      });
      await ctx.addCookies([{ name: 'ci_at', value: TOKEN, url: BASE }]);
      for (const [name, path, auth] of PAGES) {
        if (!auth) await ctx.clearCookies();
        const page = await ctx.newPage();
        await page.goto(BASE + path, { waitUntil: 'networkidle' });
        const res = await page.evaluate(checks);
        // focus visibility: tab through first 15 focusables
        const focus = [];
        for (let i = 0; i < 15; i++) {
          await page.keyboard.press('Tab');
          const f = await page.evaluate(() => {
            const el = document.activeElement;
            if (!el || el === document.body) return null;
            const s = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return {
              tag: el.tagName,
              text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 25),
              outline: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0,
              shadow: s.boxShadow !== 'none',
              onScreen: r.bottom > 0 && r.top < innerHeight,
            };
          });
          if (f && !f.outline && !f.shadow) focus.push(`no-visible-focus ${f.tag} "${f.text}"`);
          if (f && !f.onScreen) focus.push(`focus-obscured/offscreen ${f.tag} "${f.text}"`);
        }
        if (scheme === 'light')
          await page.screenshot({ path: `shots/${name}-${w}.png`, fullPage: true });
        report[`${scheme} ${w} ${name}`] = [...res.issues, ...focus];
        await page.close();
        if (!auth) await ctx.addCookies([{ name: 'ci_at', value: TOKEN, url: BASE }]);
      }
      await ctx.close();
    }
  }
  await browser.close();
  fs.writeFileSync('report.json', JSON.stringify(report, null, 2));
  for (const [k, v] of Object.entries(report))
    console.log(k, v.length ? '\n  - ' + [...new Set(v)].join('\n  - ') : 'OK');
})();
