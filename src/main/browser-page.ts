// Keep this as plain JavaScript: the isolated world must not depend on bundler helpers.
export const browserPageSource = String.raw`(() => {
  if (globalThis.__workbenchPage) return;
  const docId = 'd' + (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));
  const ids = new WeakMap();
  const elements = new Map();
  const observers = new Map();
  const overlays = new WeakSet();
  const patches = new Map();
  const editOrder = [];
  const textLimit = 20000;
  const styleNames = ['color','background-color','font-size','font-weight','font-style','line-height','letter-spacing','text-align','text-decoration','white-space','margin','margin-top','margin-right','margin-bottom','margin-left','padding','padding-top','padding-right','padding-bottom','padding-left','border','border-color','border-width','border-style','border-radius','width','height','min-width','min-height','max-width','max-height','display','opacity','gap','row-gap','column-gap','flex-direction','justify-content','align-items'];
  const editableStyles = new Set(styleNames);
  const attributeNames = new Set(['id','class','role','aria-label','aria-labelledby','aria-describedby','aria-hidden','aria-expanded','aria-checked','aria-selected','title','alt','name','type','placeholder','data-testid','tabindex','disabled','readonly']);
  const blockedTextTags = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','HEAD','META','LINK','BASE','INPUT','TEXTAREA','SELECT','OPTION','IMG','IFRAME','OBJECT','EMBED','VIDEO','AUDIO','CANVAS','HTML','BODY','SVG','PATH','RECT','CIRCLE']);
  const blockedEditTags = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','HEAD','META','LINK','BASE','OBJECT','EMBED']);
  let nextId = 0;
  let nextEditId = 0;
  let source = 'human';
  let maskNodes = [];
  let outline;
  const clean = (text, limit=180) => String(text ?? '').replace(/Bearer\s+\S+/gi, 'Bearer [hidden]').replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '[hidden]').replace(/\b(password|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[hidden]').slice(0, limit);
  const parent = el => el.parentElement || (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);
  const leafText = el => [...el.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.nodeValue || '').join('');
  function sensitive(el) {
    if (!(el instanceof Element)) return false;
    for (let node=el, depth=0; node && depth<20; node=parent(node),depth++) {
      if (node.hasAttribute('data-private') || node.hasAttribute('data-sensitive') || node.classList.contains('rr-block')) return true;
      if (/password|secret|token|api.?key|credit|card.?number|cvv|cvc|ssn|email|phone|mobile|address/i.test([node.getAttribute('type'),node.getAttribute('name'),node.id,node.getAttribute('autocomplete'),node.getAttribute('aria-label')].filter(Boolean).join(' '))) return true;
    }
    return false;
  }
  function forget(node) {
    if (!(node instanceof Element)) return;
    const pending=[node];
    while (pending.length) {
      const current=pending.pop();
      const ref=ids.get(current);
      if (ref) { elements.delete(ref); ids.delete(current); }
      pending.push(...current.children);
      if (current.shadowRoot) {
        observers.get(current.shadowRoot)?.disconnect();
        observers.delete(current.shadowRoot);
        pending.push(...current.shadowRoot.children);
      }
    }
  }
  function changes(records) {
    for (const record of records) for (const removed of record.removedNodes) forget(removed);
  }
  function observe(root) {
    if (observers.has(root)) return;
    const observer = new MutationObserver(changes);
    observer.observe(root, {childList:true,subtree:true});
    observers.set(root, observer);
  }
  function flush() {
    for (const observer of observers.values()) changes(observer.takeRecords());
  }
  observe(document);
  function unique(root, candidate, el) {
    try { const found=root.querySelectorAll(candidate); return found.length===1 && found[0]===el; } catch { return false; }
  }
  function selector(el) {
    const root=el.getRootNode();
    if (!(root instanceof Document || root instanceof ShadowRoot)) return undefined;
    if (el.id) { const value='#'+CSS.escape(el.id); if (unique(root,value,el)) return value; }
    const testId=el.getAttribute('data-testid');
    if (testId) { const value='[data-testid="'+CSS.escape(testId)+'"]'; if (unique(root,value,el)) return value; }
    const parts=[];
    for (let node=el; node && parts.length<256; node=node.parentElement) {
      const owner=node.parentElement || root;
      const siblings=[...owner.children].filter(child=>child.localName===node.localName && child.namespaceURI===node.namespaceURI);
      parts.unshift(CSS.escape(node.localName)+':nth-of-type('+(siblings.indexOf(node)+1)+')');
      const value=parts.join(' > ');
      if (unique(root,value,el)) return value;
    }
    return undefined;
  }
  function shadowPath(el) {
    const result=[];
    let root=el.getRootNode();
    while (root instanceof ShadowRoot) {
      observe(root);
      result.unshift(selector(root.host));
      root=root.host.getRootNode();
    }
    return result;
  }
  function visible(el) {
    if (!el.isConnected || overlays.has(el)) return false;
    const rect=el.getBoundingClientRect();
    const style=getComputedStyle(el);
    return rect.width>0 && rect.height>0 && style.visibility!=='hidden' && style.visibility!=='collapse' && style.display!=='none';
  }
  function safeText(el, limit=4000) {
    const pieces=[];
    const seen=new Set();
    let length=0;
    function visit(node,depth=0) {
      if (!node || seen.has(node) || length>limit || depth>256 || seen.size>10000) return;
      seen.add(node);
      if (node.nodeType===Node.TEXT_NODE) {
        const value=node.nodeValue || '';
        pieces.push(value); length+=value.length; return;
      }
      if (!(node instanceof Element) || overlays.has(node) || sensitive(node) || ['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','TEXTAREA','INPUT','SELECT'].includes(node.localName.toUpperCase())) return;
      const style=getComputedStyle(node);
      if (style.display==='none' || style.visibility==='hidden') return;
      if (node instanceof HTMLSlotElement) {
        const assigned=node.assignedNodes({flatten:true});
        for (const child of assigned.length ? assigned : node.childNodes) visit(child,depth+1);
      } else if (node.shadowRoot) {
        observe(node.shadowRoot);
        for (const child of node.shadowRoot.childNodes) visit(child,depth+1);
      } else for (const child of node.childNodes) visit(child,depth+1);
      if (['block','flex','grid','list-item','table-row'].includes(style.display)) { pieces.push('\n'); length++; }
    }
    visit(el);
    return clean(pieces.join('').trim(),limit);
  }
  function role(el) {
    const explicit=el.getAttribute('role');
    if (explicit) return explicit;
    const tag=el.localName;
    if (tag==='a' && el.hasAttribute('href')) return 'link';
    if (tag==='input') return ({checkbox:'checkbox',radio:'radio',range:'slider',button:'button',submit:'button',reset:'button',search:'searchbox',hidden:undefined})[el.type] || (el.type==='hidden' ? undefined : 'textbox');
    if (tag==='select') return el.multiple ? 'listbox' : 'combobox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return ({button:'button',textarea:'textbox',img:'img',option:'option',ul:'list',ol:'list',li:'listitem',nav:'navigation',main:'main',aside:'complementary',table:'table',tr:'row',td:'cell',th:'columnheader'})[tag];
  }
  function describe(el) {
    if (!(el instanceof Element) || overlays.has(el)) return null;
    flush();
    observe(el.getRootNode());
    if (!ids.has(el)) { const ref=docId+':'+(++nextId); ids.set(el,ref); elements.set(ref,el); }
    const rect=el.getBoundingClientRect();
    const hidden=sensitive(el);
    const text=hidden ? '[hidden]' : safeText(el,180);
    const label=el.getAttribute('aria-label') || (el.labels && [...el.labels].map(label=>safeText(label,180)).join(' ')) || el.getAttribute('placeholder') || el.getAttribute('title') || text || el.getAttribute('alt') || el.localName;
    return {ref:ids.get(el),documentId:docId,tag:el.localName,role:role(el),name:hidden ? '[hidden]' : clean(label),selector:selector(el),shadowPath:shadowPath(el),text,
      value:'value' in el ? (hidden ? '[hidden]' : clean(el.value)) : undefined,
      bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}};
  }
  function resolve(ref) {
    flush();
    if (typeof ref!=='string' || !ref.startsWith(docId+':')) throw new Error('Element reference belongs to an old document. Query the page again.');
    const el=elements.get(ref);
    if (!el || !el.isConnected || el.ownerDocument!==document) throw new Error('Element reference is stale or the node was removed. Query the page again.');
    return el;
  }
  function scan() {
    const found=[];
    const pending=[...document.children].reverse();
    while (pending.length && found.length<10000) {
      const el=pending.pop();
      if (overlays.has(el)) continue;
      found.push(el);
      pending.push(...[...el.children].reverse());
      if (el.shadowRoot) { observe(el.shadowRoot); pending.push(...[...el.shadowRoot.children].reverse()); }
    }
    return {found,truncated:pending.length>0};
  }
  function atPoint(x,y) {
    let el=document.elementFromPoint(x,y);
    for (let depth=0; el?.shadowRoot && depth<256; depth++) {
      observe(el.shadowRoot);
      const inner=el.shadowRoot.elementFromPoint(x,y);
      if (!inner || inner===el) break;
      el=inner;
    }
    return el && !overlays.has(el) ? el : null;
  }
  function eventTarget(event) {
    return event.composedPath().find(node=>node instanceof Element && !overlays.has(node)) || null;
  }
  function send(payload) {
    try { globalThis.__workbenchEvent(JSON.stringify({...payload,docId,source})); } catch {}
  }
  function textEditState(el) {
    if (sensitive(el)) return {editableText:false,editReason:'Sensitive fields cannot be edited.'};
    if (blockedTextTags.has(el.localName.toUpperCase())) return {editableText:false,editReason:'Select a plain text leaf element.'};
    if (el.children.length || el.shadowRoot) return {editableText:false,editReason:'This element contains child elements. Select the text leaf to preserve its structure.'};
    const text=leafText(el);
    if (text.length>textLimit || clean(text,textLimit+1)!==text) return {editableText:false,editReason:'This text exceeds 20000 characters or contains sensitive content.'};
    return {editableText:true};
  }
  function inspect(ref) {
    const el=resolve(ref);
    const attributes={};
    for (const attribute of el.attributes) if (attributeNames.has(attribute.name)) attributes[attribute.name]=sensitive(el) && !['type','role','disabled','readonly','tabindex'].includes(attribute.name) ? '[hidden]' : clean(attribute.value,512);
    const computed={};
    const style=getComputedStyle(el);
    for (const name of styleNames) computed[name]=clean(style.getPropertyValue(name),256);
    const ancestors=[];
    for (let node=parent(el); node && ancestors.length<8; node=parent(node)) ancestors.push(describe(node));
    const textContent=sensitive(el) ? '[hidden]' : el.children.length || el.shadowRoot ? safeText(el,textLimit) : clean(leafText(el),textLimit);
    return {...describe(el),textContent,...textEditState(el),attributes,computed,ancestors};
  }
  document.addEventListener('click', event=> {
    if (!event.isTrusted && source!=='agent') return;
    const target=describe(eventTarget(event));
    if (target) send({kind:'click',target});
  },true);
  document.addEventListener('input', event=> {
    if (!event.isTrusted && source!=='agent') return;
    const el=eventTarget(event);
    if (!el) return;
    const target=describe(el);
    send({kind:el.tagName==='SELECT' ? 'select' : 'fill',target,value:target.value || ''});
  },true);
  document.addEventListener('change', event=> {
    const el=eventTarget(event);
    if (el instanceof HTMLSelectElement) { const target=describe(el); send({kind:'select',target,value:target.value || ''}); }
  },true);
  document.addEventListener('keydown', event=> {
    if (!['Enter','Tab','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) return;
    send({kind:'key',target:describe(eventTarget(event)),value:event.key});
  },true);
  let scrollTimer;
  document.addEventListener('scroll',()=> {
    clearTimeout(scrollTimer);
    scrollTimer=setTimeout(()=>send({kind:'scroll',value:JSON.stringify({x:scrollX,y:scrollY})}),180);
  },true);
  globalThis.__workbenchPage = {
    docId,
    setSource(value) { source=value==='agent' ? 'agent' : 'human'; },
    snapshot() {
      const {found,truncated}=scan();
      const candidates=found.filter(el=>visible(el) && !['HTML','HEAD','BODY','SCRIPT','STYLE','META','LINK','NOSCRIPT','TEMPLATE'].includes(el.localName.toUpperCase()));
      return {documentId:docId,url:location.href,title:document.title,text:safeText(document.body,4000),elements:candidates.slice(0,160).map(describe),truncated:truncated || candidates.length>160};
    },
    query(query={}) {
      if (!query || typeof query!=='object' || Array.isArray(query)) throw new Error('Invalid element query');
      for (const name of ['selector','text','role']) if (query[name]!==undefined && (typeof query[name]!=='string' || query[name].length>1000)) throw new Error('Invalid query '+name);
      if (query.selector) { try { document.querySelector(query.selector); } catch { throw new Error('Invalid CSS selector'); } }
      if (query.limit!==undefined && (!Number.isInteger(query.limit) || query.limit<1 || query.limit>200)) throw new Error('Query limit must be between 1 and 200');
      const limit=query.limit || 80;
      const {found,truncated}=scan();
      const result=[];
      const normalized=value=>String(value).replace(/\s+/g,' ').trim();
      for (const el of found) {
        if (['HTML','HEAD','BODY','SCRIPT','STYLE','META','LINK','NOSCRIPT','TEMPLATE'].includes(el.localName.toUpperCase()) && !query.selector) continue;
        if (query.selector && !el.matches(query.selector)) continue;
        if (!query.selector && !visible(el)) continue;
        if (query.role && role(el)!==query.role) continue;
        if (query.text!==undefined) {
          if (sensitive(el)) continue;
          if (!query.selector && !query.role && el.children.length && ![...el.childNodes].some(node=>node.nodeType===Node.TEXT_NODE && node.nodeValue.trim())) continue;
          const text=normalized(safeText(el,4000));
          const wanted=normalized(query.text);
          if (query.exact ? text!==wanted : !text.includes(wanted)) continue;
        }
        result.push(el);
        if (result.length>limit) break;
      }
      return {documentId:docId,elements:result.slice(0,limit).map(describe),truncated:truncated || result.length>limit};
    },
    inspect,
    reveal(ref) {
      const el=resolve(ref);
      el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
      return describe(el);
    },
    atPoint(x,y) { const el=atPoint(x,y); return el ? describe(el) : null; },
    edit(request) {
      if (!request || typeof request!=='object' || Array.isArray(request) || Object.keys(request).some(key=>!['ref','text','styles'].includes(key))) throw new Error('Only text and supported styles can be edited');
      const el=resolve(request.ref);
      if (sensitive(el) || blockedEditTags.has(el.localName.toUpperCase())) throw new Error('Sensitive or executable elements cannot be edited');
      const hasText=Object.hasOwn(request,'text');
      if (hasText && (typeof request.text!=='string' || request.text.length>textLimit || clean(request.text,textLimit+1)!==request.text)) throw new Error('Invalid or sensitive replacement text');
      if (hasText) { const state=textEditState(el); if (!state.editableText) throw new Error(state.editReason); }
      const styles=request.styles===undefined ? {} : request.styles;
      if (!styles || typeof styles!=='object' || Array.isArray(styles)) throw new Error('Invalid style changes');
      const entries=Object.entries(styles);
      if (!hasText && !entries.length) throw new Error('No preview changes were provided');
      if (entries.length>40) throw new Error('Too many style changes');
      for (const [name,value] of entries) {
        if (!editableStyles.has(name) || typeof value!=='string' || value.length>200 || /url\s*\(|expression\s*\(|var\s*\(|javascript\s*:|@|[;{}<>\\]/i.test(value) || (value!=='' && !CSS.supports(name,value))) throw new Error('Unsupported CSS property or value: '+name);
      }
      const textNodes=hasText ? [...el.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE) : [];
      const beforeText=textNodes.map(node=>node.nodeValue);
      const created=hasText && textNodes.length===0;
      const beforeCssText=el.style.cssText;
      if (created) { const node=document.createTextNode(''); el.appendChild(node); textNodes.push(node); }
      if (hasText) textNodes.forEach((node,index)=> { node.nodeValue=index===0 ? request.text : ''; });
      for (const [name,value] of entries) value==='' ? el.style.removeProperty(name) : el.style.setProperty(name,value);
      const editId=docId+':edit:'+(++nextEditId);
      patches.set(editId,{ref:request.ref,el,textNodes,beforeText,created,hasText,afterText:textNodes.map(node=>node.nodeValue),hasStyles:entries.length>0,beforeCssText,afterCssText:el.style.cssText});
      editOrder.push(editId);
      send({kind:'edit',target:describe(el),editId,value:JSON.stringify({...(hasText ? {text:request.text} : {}),...(entries.length ? {styles} : {})})});
      return {editId,element:inspect(request.ref)};
    },
    undo(editId) {
      const id=editId===undefined ? editOrder[editOrder.length-1] : editId;
      const patch=patches.get(id);
      if (!patch) throw new Error('No active edit with this ID exists in the current document');
      const el=resolve(patch.ref);
      if (el!==patch.el || sensitive(el)) throw new Error('The edited element is no longer safe to restore');
      if (patch.hasText) {
        const current=[...el.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE);
        if (el.children.length || current.length!==patch.textNodes.length || current.some((node,index)=>node!==patch.textNodes[index] || node.nodeValue!==patch.afterText[index])) throw new Error('Page text changed after this edit; refusing to overwrite newer changes');
      }
      if (patch.hasStyles && el.style.cssText!==patch.afterCssText) throw new Error('Page styles changed after this edit; refusing to overwrite newer changes');
      if (patch.hasText) {
        if (patch.created) patch.textNodes[0].remove();
        else patch.textNodes.forEach((node,index)=> { node.nodeValue=patch.beforeText[index]; });
      }
      if (patch.hasStyles) el.style.cssText=patch.beforeCssText;
      patches.delete(id);
      editOrder.splice(editOrder.indexOf(id),1);
      send({kind:'undo',target:describe(el),editId:id,value:JSON.stringify({editId:id})});
      return {editId:id,element:inspect(patch.ref)};
    },
    bounds(ref) {
      const el=resolve(ref); el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
      const rect=el.getBoundingClientRect();
      if (rect.width<=0 || rect.height<=0) throw new Error('Element is not visible');
      const hit=atPoint(rect.x+rect.width/2,rect.y+rect.height/2);
      let inside=false;
      for (let node=hit; node; node=parent(node)) if (node===el) { inside=true; break; }
      if (!inside) throw new Error('Element is covered by another page element');
      return {x:rect.x+rect.width/2,y:rect.y+rect.height/2,tag:el.localName,disabled:!!el.disabled};
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
      if (![...el.options].some(option=>option.value===value)) throw new Error('The requested option does not exist');
      el.value=value; el.dispatchEvent(new Event('input',{bubbles:true,composed:true})); el.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
    },
    outline(ref) {
      outline?.remove();
      if (!ref) return;
      const rect=resolve(ref).getBoundingClientRect(); outline=document.createElement('div'); overlays.add(outline);
      outline.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #5f75ed;border-radius:3px;box-sizing:border-box;left:'+rect.x+'px;top:'+rect.y+'px;width:'+rect.width+'px;height:'+rect.height+'px';
      document.documentElement.appendChild(outline);
    },
    mask(enabled) {
      maskNodes.forEach(node=>node.remove()); maskNodes=[];
      if (!enabled) return;
      for (const el of scan().found) {
        if (!sensitive(el) || !visible(el)) continue;
        const rect=el.getBoundingClientRect();
        const mask=document.createElement('div'); overlays.add(mask);
        mask.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;background:#e6e8ed;color:#4b4e57;font:12px system-ui;display:flex;align-items:center;justify-content:center;left:'+rect.x+'px;top:'+rect.y+'px;width:'+rect.width+'px;height:'+rect.height+'px';
        mask.textContent='[hidden]'; document.documentElement.appendChild(mask); maskNodes.push(mask);
      }
    }
  };
})();`;
