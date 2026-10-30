import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { browserPageSource } from '../src/main/browser-page.ts';

interface ElementInfo {
  ref: string;
  documentId: string;
  tag: string;
  name: string;
  role?: string;
  selector: string;
  shadowPath: string[];
  value?: string;
  bounds: { x: number; y: number; width: number; height: number };
}
interface Details extends ElementInfo {
  textContent: string;
  editableText: boolean;
  editReason?: string;
  attributes: Record<string, string>;
  computed: Record<string, string>;
  ancestors: ElementInfo[];
}
interface QueryResult {
  documentId: string;
  elements: ElementInfo[];
  truncated: boolean;
}
interface EditResult {
  editId: string;
  element: Details;
}
interface PageEvent {
  kind: string;
  target?: ElementInfo;
  value?: string;
  source: string;
  editId?: string;
}

const executable = [
  process.env.WORKBENCH_BROWSEROS_TEST_BINARY,
  path.resolve('../browseros-runtime/BrowserOS neo.app/Contents/MacOS/BrowserOS neo'),
  '/Applications/BrowserOS neo.app/Contents/MacOS/BrowserOS neo',
  chromium.executablePath(),
].find((value): value is string => Boolean(value && existsSync(value)));
let browser: Browser | undefined;
before(async () => {
  if (!executable) return;
  browser = await chromium.launch({
    executablePath: executable,
    headless: true,
    args: [
      '--disable-browseros-server',
      '--disable-browseros-server-updater',
      '--disable-browseros-extensions',
      '--browseros-disable-url-overrides',
      '--disable-background-networking',
      '--disable-component-update',
      '--use-mock-keychain',
      '--disable-sync',
    ],
  });
});
after(async () => {
  await browser?.close();
});

async function bridge<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ({ method, args }) => {
      const api = (
        globalThis as unknown as {
          __workbenchPage: Record<string, (...args: unknown[]) => unknown>;
        }
      ).__workbenchPage;
      return api[method](...args);
    },
    { method, args },
  ) as Promise<T>;
}

async function fixture(t: TestContext) {
  const context = await browser!.newContext({ viewport: { width: 1200, height: 1000 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const events: PageEvent[] = [];
  await page.route('**/*', (route) => route.abort());
  await page.exposeFunction('__workbenchEvent', (payload: string) => {
    events.push(JSON.parse(payload));
  });
  await page.addInitScript(browserPageSource);
  const html = `<!doctype html><meta charset="utf-8"><title>Element fixture</title>
    <style>body{font:16px sans-serif;padding:20px}p{margin:12px 0}button{padding:16px}#button-label{display:inline-block;padding:12px}#box{width:300px;height:60px;padding:20px;background:#eee}#leaf{display:inline-block;padding:8px}#shadow-host{display:block;margin-top:20px}#long{display:none}</style>
    <h1 id="heading">普通标题</h1>
    <p id="duplicate" data-testid="duplicate">同样文字</p><p id="duplicate" data-testid="duplicate">同样文字</p>
    <button id="complex"><svg width="20" height="20"><circle cx="10" cy="10" r="8" /></svg><span id="button-label">保存</span></button>
    <p><span id="leaf" style="color:rgb(10, 20, 30);margin-left:3px !important">  原始文字  </span></p>
    <img id="photo" alt="示例图片" width="80" height="60" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='60'%3E%3Crect width='80' height='60' fill='green'/%3E%3C/svg%3E">
    <div id="box">普通容器</div><div id="shadow-host"></div>
    <input id="password-input" type="password" value="unusual-sensitive-value">
    <textarea id="private-area" data-private>private-textarea-content</textarea>
    <p id="long"></p><iframe id="child-frame" srcdoc="<p id='child-text'>子页面</p>" width="200" height="80"></iframe>
    <script>
      globalThis.clicked=0;
      document.querySelector('#complex').addEventListener('click',()=>globalThis.clicked++);
      const outer=document.querySelector('#shadow-host').attachShadow({mode:'open'});
      outer.innerHTML='<style>:host{display:block}#inner-host{display:block;padding:10px}</style><div id="inner-host"></div>';
      const inner=outer.querySelector('#inner-host').attachShadow({mode:'open'});
      inner.innerHTML='<style>#deep-leaf{display:inline-block;padding:10px}input{display:block}</style><div><span id="deep-leaf">Shadow 文本</span><input id="deep-input" aria-label="Shadow input"></div>';
      document.querySelector('#long').textContent='x'.repeat(20001);
      globalThis.originalTextNode=document.querySelector('#leaf').firstChild;
    </script>`;
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const find = async (selector: string) =>
    (await bridge<QueryResult>(page, 'query', { selector })).elements[0];
  return { page, events, find };
}

async function eventually(condition: () => boolean) {
  const until = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > until) assert.fail('Expected page event did not arrive');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test(
  'reveal scrolls an offscreen non-interactive node without requiring it to receive pointer events',
  { skip: !executable },
  async (t) => {
    const { page, find } = await fixture(t);
    await page.evaluate(() => {
      const label = document.createElement('p');
      label.id = 'offscreen-label';
      label.textContent = '不可点击的远处文字';
      label.style.cssText = 'margin-top:2000px;pointer-events:none';
      document.body.appendChild(label);
    });
    const element = await find('#offscreen-label');
    assert(element.bounds.y > 1000);
    const revealed = await bridge<ElementInfo>(page, 'reveal', element.ref);
    assert.equal(revealed.ref, element.ref);
    assert(revealed.bounds.y >= 0 && revealed.bounds.y + revealed.bounds.height <= 1000);
    await assert.rejects(bridge(page, 'bounds', element.ref), /covered/);
    await page.locator('#offscreen-label').evaluate((el) => el.remove());
    await assert.rejects(bridge(page, 'reveal', element.ref), /stale|removed/);
  },
);

test(
  'page bridge selects ordinary text, images and containers exactly, with unique selectors for duplicate labels',
  { skip: !executable },
  async (t) => {
    const { page, find } = await fixture(t);
    const matches = await bridge<QueryResult>(page, 'query', { text: '同样文字', exact: true });
    assert.equal(matches.elements.length, 2);
    assert.notEqual(matches.elements[0].ref, matches.elements[1].ref);
    for (const element of matches.elements) {
      assert.notEqual(element.selector, '#duplicate');
      assert.equal(
        await page.evaluate(
          (selector) => document.querySelectorAll(selector).length,
          element.selector,
        ),
        1,
      );
    }
    assert.equal(
      (await bridge<QueryResult>(page, 'query', { text: '同样文字', exact: true, limit: 1 }))
        .truncated,
      true,
    );
    assert.equal(
      (await bridge<QueryResult>(page, 'query', { role: 'button' })).elements[0].selector,
      '#complex',
    );
    await assert.rejects(bridge(page, 'query', { selector: 'div[' }), /Invalid CSS selector/);
    const first = await find('#button-label');
    const again = await find('#button-label');
    assert.equal(first.ref, again.ref);
    for (const selector of ['#heading', '#button-label', '#photo', '#box']) {
      const element = await find(selector);
      const r = element.bounds;
      const picked = await bridge<ElementInfo>(
        page,
        'atPoint',
        r.x + r.width / 2,
        r.y + r.height / 2,
      );
      assert.equal(picked.ref, element.ref, `Exact point target for ${selector}`);
    }
    assert.equal(await page.evaluate(() => (globalThis as any).clicked), 0);
    const snapshot = await bridge<QueryResult>(page, 'snapshot');
    for (const selector of ['#heading', '#photo', '#box'])
      assert(snapshot.elements.some((item) => item.selector === selector));
  },
);

test(
  'open shadow roots keep exact point/event targets and a reconstructable selector path',
  { skip: !executable },
  async (t) => {
    const { page, find, events } = await fixture(t);
    const deep = await find('#deep-leaf');
    assert.deepEqual(deep.shadowPath, ['#shadow-host', '#inner-host']);
    const r = deep.bounds;
    assert.equal(
      (await bridge<ElementInfo>(page, 'atPoint', r.x + r.width / 2, r.y + r.height / 2)).ref,
      deep.ref,
    );
    const matches = await page.evaluate((element) => {
      let root: Document | ShadowRoot = document;
      for (const host of element.shadowPath) root = root.querySelector(host)!.shadowRoot!;
      return root.querySelectorAll(element.selector).length;
    }, deep);
    assert.equal(matches, 1);
    await page.locator('#deep-leaf').click();
    await page.locator('#deep-input').fill('Shadow 输入');
    await eventually(() => events.some((event) => event.kind === 'fill'));
    assert.equal(events.find((event) => event.kind === 'click')?.target?.ref, deep.ref);
    const fill = events.find((event) => event.kind === 'fill');
    assert.equal(fill?.target?.selector, '#deep-input');
    assert.equal(fill?.value, 'Shadow 输入');
    assert.deepEqual(fill?.target?.shadowPath, ['#shadow-host', '#inner-host']);
    const details = await bridge<Details>(page, 'inspect', deep.ref);
    assert.equal(details.editableText, true);
    assert(details.ancestors.some((item) => item.selector === '#inner-host'));
    assert(details.ancestors.some((item) => item.selector === '#shadow-host'));
  },
);

test(
  'text and CSS preview preserve Text nodes and restore exact prior inline styles',
  { skip: !executable },
  async (t) => {
    const { page, find, events } = await fixture(t);
    const leaf = await find('#leaf');
    const before = await bridge<Details>(page, 'inspect', leaf.ref);
    const beforeStyle = await page.locator('#leaf').getAttribute('style');
    assert.equal(before.textContent, '  原始文字  ');
    assert.equal(before.editableText, true);
    await bridge(page, 'setSource', 'agent');
    const literal = '<img src=x onerror="globalThis.injected=true">';
    const edited = await bridge<EditResult>(page, 'edit', {
      ref: leaf.ref,
      text: literal,
      styles: { color: '#123456', 'font-size': '24px', margin: '8px' },
    });
    assert.equal(edited.element.textContent, literal);
    assert.equal(edited.element.computed['font-size'], '24px');
    assert.equal(edited.element.computed.color, 'rgb(18, 52, 86)');
    assert.equal(await page.locator('#leaf img').count(), 0);
    assert.equal(
      await page.evaluate(
        () => (globalThis as any).originalTextNode === document.querySelector('#leaf')!.firstChild,
      ),
      true,
    );
    assert.equal(await page.evaluate(() => (globalThis as any).injected), undefined);
    await bridge(page, 'setSource', 'human');
    const undone = await bridge<EditResult>(page, 'undo', edited.editId);
    assert.equal(undone.element.textContent, '  原始文字  ');
    const restoredStyle = await page.locator('#leaf').getAttribute('style');
    assert.equal(
      await page.evaluate(() =>
        document.querySelector<HTMLElement>('#leaf')!.style.getPropertyPriority('margin-left'),
      ),
      'important',
    );
    assert.equal(
      await page.locator('#leaf').evaluate((el) => getComputedStyle(el).marginLeft),
      '3px',
    );
    assert(beforeStyle && restoredStyle);
    await eventually(
      () => events.filter((event) => event.kind === 'edit' || event.kind === 'undo').length === 2,
    );
    assert.deepEqual(
      events
        .filter((event) => event.kind === 'edit' || event.kind === 'undo')
        .map((event) => [event.kind, event.source, event.target?.ref]),
      [
        ['edit', 'agent', leaf.ref],
        ['undo', 'human', leaf.ref],
      ],
    );
    await assert.rejects(bridge(page, 'undo', edited.editId), /No active edit/);
  },
);

test(
  'complex elements retain their children and CSS validation rejects the entire invalid patch',
  { skip: !executable },
  async (t) => {
    const { page, find } = await fixture(t);
    const complex = await find('#complex');
    const detail = await bridge<Details>(page, 'inspect', complex.ref);
    assert.equal(detail.editableText, false);
    assert.match(detail.editReason!, /child elements/);
    await assert.rejects(
      bridge(page, 'edit', { ref: complex.ref, text: 'replacement', styles: { color: 'red' } }),
      /child elements/,
    );
    assert.equal(await page.locator('#complex > svg').count(), 1);
    assert.equal(await page.locator('#complex > span').count(), 1);
    assert.equal(await page.locator('#complex').getAttribute('style'), null);
    const leaf = await find('#button-label');
    for (const patch of [
      { styles: { color: 'red', 'background-image': 'url(https://invalid.test/image)' } },
      { styles: { color: 'red;display:none' } },
      { styles: { color: 'var(--untrusted)' } },
      { attributes: { onclick: 'alert(1)' } },
      { innerHTML: '<script>alert(1)</script>' },
    ])
      await assert.rejects(
        bridge(page, 'edit', { ref: leaf.ref, ...patch }),
        /Unsupported|Only text/,
      );
    assert.equal(await page.locator('#button-label').getAttribute('style'), null);
    const edit = await bridge<EditResult>(page, 'edit', { ref: leaf.ref, text: '保存预览' });
    await page.locator('#button-label').click();
    assert.equal(await page.evaluate(() => (globalThis as any).clicked), 1);
    assert.equal(await page.locator('#complex > svg').count(), 1);
    await bridge(page, 'undo', edit.editId);
    assert.equal(await page.locator('#button-label').textContent(), '保存');
  },
);

test(
  'sensitive fields remain masked and truncated text is never editable',
  { skip: !executable },
  async (t) => {
    const { page, find, events } = await fixture(t);
    for (const selector of ['#password-input', '#private-area']) {
      const element = await find(selector);
      const details = await bridge<Details>(page, 'inspect', element.ref);
      assert.equal(details.editableText, false);
      assert.equal(details.textContent, '[hidden]');
      assert.equal(details.value, '[hidden]');
      await assert.rejects(
        bridge(page, 'edit', { ref: element.ref, styles: { color: 'red' } }),
        /Sensitive/,
      );
      await assert.rejects(
        bridge(page, 'edit', { ref: element.ref, text: 'replacement' }),
        /Sensitive/,
      );
    }
    await page.locator('#password-input').fill('new-private-value');
    await eventually(() => events.some((event) => event.kind === 'fill'));
    // The data: fixture URL contains its literal HTML; URL redaction belongs to the runtime.
    const snapshot = await bridge<{ text: string; elements: ElementInfo[] }>(page, 'snapshot');
    const serialized = JSON.stringify({ events, text: snapshot.text, elements: snapshot.elements });
    for (const secret of [
      'new-private-value',
      'unusual-sensitive-value',
      'private-textarea-content',
    ])
      assert.equal(serialized.includes(secret), false);
    const long = await find('#long');
    const longDetails = await bridge<Details>(page, 'inspect', long.ref);
    assert.equal(longDetails.textContent.length, 20000);
    assert.equal(longDetails.editableText, false);
    assert.match(longDetails.editReason!, /20000/);
    await assert.rejects(bridge(page, 'edit', { ref: long.ref, text: 'short' }), /20000/);
  },
);

test(
  'removed/reinserted nodes and old documents invalidate refs instead of matching a replacement',
  { skip: !executable },
  async (t) => {
    const { page, find } = await fixture(t);
    const leaf = await find('#leaf');
    const edit = await bridge<EditResult>(page, 'edit', { ref: leaf.ref, text: 'preview' });
    await assert.rejects(
      page.evaluate((ref) => {
        const el = document.querySelector('#leaf')!;
        el.remove();
        document.body.appendChild(el);
        return (globalThis as any).__workbenchPage.inspect(ref);
      }, leaf.ref),
      /stale|removed/,
    );
    const reinserted = await find('#leaf');
    assert.notEqual(reinserted.ref, leaf.ref);
    await assert.rejects(bridge(page, 'undo', edit.editId), /stale|removed/);
    await page.goto('data:text/html,<p id="leaf">A different document</p>');
    const current = await find('#leaf');
    assert.notEqual(current.documentId, leaf.documentId);
    await assert.rejects(
      bridge(page, 'edit', { ref: reinserted.ref, text: 'must not apply' }),
      /old document/,
    );
    assert.equal(await page.locator('#leaf').textContent(), 'A different document');
  },
);

test(
  'undo refuses conflicting text/styles and allows reversing later edits first',
  { skip: !executable },
  async (t) => {
    const { page, find } = await fixture(t);
    const leaf = await find('#leaf');
    const first = await bridge<EditResult>(page, 'edit', { ref: leaf.ref, text: 'first' });
    const second = await bridge<EditResult>(page, 'edit', { ref: leaf.ref, text: 'second' });
    await assert.rejects(bridge(page, 'undo', first.editId), /changed after/);
    assert.equal(
      (await bridge<EditResult>(page, 'undo', second.editId)).element.textContent,
      'first',
    );
    assert.equal((await bridge<EditResult>(page, 'undo')).element.textContent, '  原始文字  ');
    const style = await bridge<EditResult>(page, 'edit', {
      ref: leaf.ref,
      text: 'preview remains',
      styles: { width: '200px' },
    });
    await page.locator('#leaf').evaluate((el) => {
      (el as HTMLElement).style.color = 'pink';
    });
    await assert.rejects(bridge(page, 'undo', style.editId), /styles changed/);
    assert.equal(await page.locator('#leaf').textContent(), 'preview remains');
    assert.equal(
      await page.locator('#leaf').evaluate((el) => (el as HTMLElement).style.width),
      '200px',
    );
  },
);

test(
  'iframe ownership stays separate from the parent page and document references',
  { skip: !executable },
  async (t) => {
    const { page, find } = await fixture(t);
    const iframe = await find('#child-frame');
    const r = iframe.bounds;
    assert.equal(
      (await bridge<ElementInfo>(page, 'atPoint', r.x + r.width / 2, r.y + r.height / 2)).tag,
      'iframe',
    );
    assert.equal(
      (await bridge<QueryResult>(page, 'query', { selector: '#child-text' })).elements.length,
      0,
    );
    const child = page.frames().find((frame) => frame.parentFrame());
    assert(child);
    const childElement = (await child.evaluate(
      () => (globalThis as any).__workbenchPage.query({ selector: '#child-text' }).elements[0],
    )) as ElementInfo;
    assert.notEqual(childElement.documentId, iframe.documentId);
    await assert.rejects(bridge(page, 'inspect', childElement.ref), /old document/);
  },
);
