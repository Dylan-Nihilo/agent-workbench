// Keep this as plain JavaScript: the isolated world must not depend on bundler helpers.
export const browserPageSource = String.raw`(() => {
  if (globalThis.__workbenchPage) return;
  const docId = 'd' + Math.random().toString(36).slice(2);
  const ids = new WeakMap();
  const elements = new Map();
  let nextId = 0;
  let source = 'human';
  let maskNodes = [];
  let outline;
  const clean = (text, limit=180) => String(text || '').replace(/Bearer\s+\S+/gi, 'Bearer [hidden]').replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '[hidden]').slice(0, limit);
  const sensitive = el => /password|secret|token|api.?key|credit|card.?number|cvv|cvc|ssn|email|phone|mobile|address/i.test([el.type, el.name, el.id, el.autocomplete, el.getAttribute('aria-label')].filter(Boolean).join(' '));
  function selector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.getAttribute('data-testid')) return '[data-testid=' + JSON.stringify(el.getAttribute('data-testid')) + ']';
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      const siblings = node.parentElement ? [...node.parentElement.children].filter(x => x.tagName === node.tagName) : [];
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
  function describe(el) {
    if (!(el instanceof Element)) return null;
    if (!ids.has(el)) { const ref = docId + ':' + (++nextId); ids.set(el, ref); elements.set(ref, el); }
    const r = el.getBoundingClientRect();
    const hidden = sensitive(el);
    const label = el.getAttribute('aria-label') || (el.labels && [...el.labels].map(x => x.textContent).join(' ')) || el.getAttribute('placeholder') || el.getAttribute('title') || el.innerText || el.getAttribute('alt') || el.tagName.toLowerCase();
    return { ref: ids.get(el), tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || undefined,
      name: clean(label), selector: selector(el), text: clean(el.innerText),
      value: 'value' in el ? (hidden ? '[hidden]' : clean(el.value)) : undefined,
      bounds: { x:r.x, y:r.y, width:r.width, height:r.height } };
  }
  function resolve(ref) {
    if (!String(ref).startsWith(docId + ':')) throw new Error('Element reference belongs to an old document. Take a new snapshot.');
    const el = elements.get(ref);
    if (!el || !el.isConnected) throw new Error('Element is no longer on the page. Take a new snapshot.');
    return el;
  }
  function send(payload) {
    try { globalThis.__workbenchEvent(JSON.stringify({ ...payload, docId, source })); } catch {}
  }
  function interactive(el) {
    return el.closest('button,a,input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[contenteditable="true"]') || el;
  }
  document.addEventListener('click', e => {
    if (!e.isTrusted && source !== 'agent') return;
    const target = describe(interactive(e.target));
    if (target) send({kind:'click',target});
  }, true);
  document.addEventListener('input', e => {
    if (!e.isTrusted && source !== 'agent') return;
    if (!(e.target instanceof Element)) return;
    const target = describe(e.target);
    send({kind:e.target.tagName === 'SELECT' ? 'select' : 'fill', target, value:target.value || ''});
  }, true);
  document.addEventListener('change', e => {
    if (e.target instanceof HTMLSelectElement) {
      const target = describe(e.target); send({kind:'select',target,value:target.value || ''});
    }
  }, true);
  document.addEventListener('keydown', e => {
    if (!['Enter','Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) return;
    send({kind:'key',target:describe(e.target),value:e.key});
  }, true);
  let scrollTimer;
  document.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => send({kind:'scroll',value:JSON.stringify({x:scrollX,y:scrollY})}), 180);
  }, true);
  globalThis.__workbenchPage = {
    docId,
    setSource(value) { source = value === 'agent' ? 'agent' : 'human'; },
    snapshot() {
      const nodes = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[contenteditable="true"]')];
      return {documentId:docId,url:location.href,title:document.title,text:clean(document.body?.innerText || '',4000),elements:nodes.filter(el => {
        const r=el.getBoundingClientRect(); return r.width>0 && r.height>0 && getComputedStyle(el).visibility !== 'hidden';
      }).slice(0,120).map(describe)};
    },
    atPoint(x,y) { const el=document.elementFromPoint(x,y); return el ? describe(interactive(el)) : null; },
    bounds(ref) {
      const el=resolve(ref); el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
      const r=el.getBoundingClientRect();
      if (r.width<=0 || r.height<=0) throw new Error('Element is not visible');
      const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      if (!hit || (hit!==el && !el.contains(hit))) throw new Error('Element is covered by another page element');
      return {x:r.x+r.width/2,y:r.y+r.height/2,tag:el.tagName.toLowerCase(),disabled:!!el.disabled};
    },
    focus(ref) {
      const el=resolve(ref);
      if (!['INPUT','TEXTAREA'].includes(el.tagName) || ['file','checkbox','radio','button','submit','hidden'].includes(el.type)) throw new Error('This element is not a supported text input');
      if (el.disabled || el.readOnly) throw new Error('Input is not editable');
      el.scrollIntoView({block:'center',behavior:'instant'}); el.focus(); el.select();
    },
    select(ref,value) {
      const el=resolve(ref);
      if (!(el instanceof HTMLSelectElement) || el.disabled) throw new Error('This element is not an enabled select');
      if (![...el.options].some(x=>x.value===value)) throw new Error('The requested option does not exist');
      el.value=value; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
    },
    outline(ref) {
      outline?.remove();
      if (!ref) return;
      const r=resolve(ref).getBoundingClientRect(); outline=document.createElement('div');
      outline.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #5f75ed;border-radius:3px;box-sizing:border-box;left:'+r.x+'px;top:'+r.y+'px;width:'+r.width+'px;height:'+r.height+'px';
      document.documentElement.appendChild(outline);
    },
    mask(enabled) {
      maskNodes.forEach(n=>n.remove()); maskNodes=[];
      if (!enabled) return;
      for (const el of document.querySelectorAll('input,textarea')) {
        if (!sensitive(el)) continue;
        const r=el.getBoundingClientRect(); if (!r.width || !r.height) continue;
        const mask=document.createElement('div');
        mask.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;background:#e6e8ed;color:#4b4e57;font:12px system-ui;display:flex;align-items:center;justify-content:center;left:'+r.x+'px;top:'+r.y+'px;width:'+r.width+'px;height:'+r.height+'px';
        mask.textContent='[hidden]'; document.documentElement.appendChild(mask); maskNodes.push(mask);
      }
    }
  };
})();`;
