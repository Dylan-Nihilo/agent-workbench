import {
  ELEMENT_STYLE_PROPERTIES,
  ELEMENT_ANIMATION_PROPERTIES,
  ELEMENT_BACKGROUND_FUNCTIONS,
  ELEMENT_PREVIEW_LIMITS,
  ELEMENT_UNSAFE_CSS_PATTERN,
} from '../shared/types';

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
  const ownedAnimations = new Map();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const textLimit = 20000;
  const styleNames = ${JSON.stringify(ELEMENT_STYLE_PROPERTIES)};
  const limits = ${JSON.stringify(ELEMENT_PREVIEW_LIMITS)};
  const unsafeCss = new RegExp(${JSON.stringify(ELEMENT_UNSAFE_CSS_PATTERN)},'i');
  const editableStyles = new Set(styleNames);
  const animationStyles = new Set(${JSON.stringify(ELEMENT_ANIMATION_PROPERTIES)});
  const backgroundFunctions = new Set(${JSON.stringify(ELEMENT_BACKGROUND_FUNCTIONS)});
  const attributeNames = new Set(['id','class','role','aria-label','aria-labelledby','aria-describedby','aria-hidden','aria-expanded','aria-checked','aria-selected','title','alt','name','type','placeholder','data-testid','tabindex','disabled','readonly']);
  const blockedTextTags = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','HEAD','META','LINK','BASE','INPUT','TEXTAREA','SELECT','OPTION','IMG','IFRAME','OBJECT','EMBED','VIDEO','AUDIO','CANVAS','HTML','BODY','SVG','PATH','RECT','CIRCLE']);
  const blockedEditTags = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','HEAD','META','LINK','BASE','OBJECT','EMBED']);
  let nextId = 0;
  let nextEditId = 0;
  let nextAnimationId = 0;
  let source = 'human';
  let maskNodes = [];
  let inspecting = false;
  let overlayHost, overlayRoot, overlayFrame = 0;
  let hoverElement, selectedElement, feedbackElement, feedbackPhase, feedbackTimer;
  let hoverPoint;
  const overlayBoxes = {};
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
      ownedAnimations.get(current)?.player?.cancel();
      ownedAnimations.delete(current);
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
  function semantics(el) {
    const explicit=el.getAttribute('role'), native=role(el);
    if (native) return {kind:native,source:explicit?'aria':'html',evidence:[explicit?'role='+explicit:'tag='+el.localName]};
    const evidence=[];
    if (el.hasAttribute('onclick')) evidence.push('onclick attribute');
    if (el.tabIndex>=0) evidence.push('keyboard focusable');
    if (getComputedStyle(el).cursor==='pointer') evidence.push('pointer cursor');
    return {kind:evidence.includes('onclick attribute') || evidence.length>=2 ? 'button':'element',source:evidence.length?'inferred':'unknown',evidence};
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
  function overlayBox(kind) {
    if (!overlayHost?.isConnected) {
      overlayHost=document.createElement('div'); overlays.add(overlayHost);
      overlayHost.setAttribute('data-workbench-overlay',''); overlayHost.setAttribute('aria-hidden','true');
      overlayHost.style.cssText='all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;contain:layout style!important;';
      overlayRoot=overlayHost.attachShadow({mode:'closed'});
      const css=document.createElement('style');
      css.textContent=':host{pointer-events:none}.box{position:absolute;box-sizing:border-box;pointer-events:none;border-radius:4px;display:none}.hover{border:1px solid #8291ed;background:#7e8dfa18;box-shadow:0 0 0 1px #fff9}.selected{border:2px solid #7e8dfa;box-shadow:0 0 0 1px #151b3480}.label{position:absolute;left:0;bottom:calc(100% + 5px);max-width:min(320px,90vw);box-sizing:border-box;padding:4px 7px;background:#202639;color:#fff;border:1px solid #6471b1;border-radius:5px;font:500 11px/16px ui-monospace,SFMono-Regular,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.feedback{overflow:hidden;border:1px solid #b6bcff;background:#969fff13;box-shadow:0 0 0 1px #7e8dfa66,0 0 18px #9ba5ff55}.feedback::after{content:"";position:absolute;inset:-60% -80%;background:linear-gradient(110deg,transparent 35%,#e6e9ff80 49%,transparent 63%);transform:translateX(-60%);animation:sweep 1.4s ease-in-out infinite}.feedback.applied{animation:finish 560ms ease-out both}.feedback.applied::after{animation:sweep 500ms ease-out both}@keyframes sweep{to{transform:translateX(60%)}}@keyframes finish{0%{opacity:1;box-shadow:0 0 0 1px #bac2ff,0 0 22px #a5b2ff88}100%{opacity:0;box-shadow:0 0 0 5px #bac2ff00,0 0 8px #a5b2ff00}}@media(prefers-reduced-motion:reduce){.feedback,.feedback::after{animation:none!important}.feedback::after{display:none}.feedback.applied{background:#b5bfff22}}';
      overlayRoot.appendChild(css); document.documentElement.appendChild(overlayHost);
      for(const name of Object.keys(overlayBoxes)) delete overlayBoxes[name];
    }
    if(!overlayBoxes[kind]) {
      const box=document.createElement('div'); box.className='box '+kind; box.dataset.kind=kind;
      if(kind!=='feedback') { const label=document.createElement('span');label.className='label';box.appendChild(label); }
      overlayRoot.appendChild(box);overlayBoxes[kind]=box;
    }
    return overlayBoxes[kind];
  }
  function drawOverlay(kind,el) {
    if(!el?.isConnected || !visible(el)) { if(overlayBoxes[kind]) {overlayBoxes[kind].style.display='none';overlayBoxes[kind].lastBounds='';}return; }
    const rect=el.getBoundingClientRect();
    const left=Math.max(0,rect.left),top=Math.max(0,rect.top),right=Math.min(innerWidth,rect.right),bottom=Math.min(innerHeight,rect.bottom);
    if(right<=left || bottom<=top) { if(overlayBoxes[kind]) {overlayBoxes[kind].style.display='none';overlayBoxes[kind].lastBounds='';}return; }
    const box=overlayBox(kind);
    const css='display:block;left:'+left+'px;top:'+top+'px;width:'+(right-left)+'px;height:'+(bottom-top)+'px;';
    if(box.lastBounds!==css) {box.style.cssText=css;box.lastBounds=css;}
    if(kind!=='feedback') {
      const label=box.firstChild;
      const text=el.localName+' · '+Math.round(rect.width)+' × '+Math.round(rect.height);
      if(label.textContent!==text) label.textContent=text;
      label.style.bottom=top<30 ? 'auto' : 'calc(100% + 5px)';
      label.style.top=top<30 ? 'calc(100% + 5px)' : 'auto';
      label.style.maxWidth=Math.max(30,innerWidth-left-6)+'px';
    }
  }
  function paintOverlays() {
    overlayFrame=0;
    if(inspecting && hoverPoint) {
      const target=atPoint(hoverPoint.x,hoverPoint.y);
      hoverElement=target?.localName==='iframe' ? null : target;
    }
    if(hoverElement && !hoverElement.isConnected) hoverElement=null;
    if(selectedElement && !selectedElement.isConnected) selectedElement=null;
    if(feedbackElement && !feedbackElement.isConnected) feedbackElement=null;
    drawOverlay('selected',selectedElement);
    drawOverlay('hover',inspecting && hoverElement!==selectedElement ? hoverElement : null);
    drawOverlay('feedback',feedbackElement);
    if(hoverPoint || selectedElement || feedbackElement) overlayFrame=requestAnimationFrame(paintOverlays);
  }
  function refreshOverlays() { if(!overlayFrame) paintOverlays(); }
  function feedback(ref,phase) {
    if(phase===null && feedbackPhase==='applied') return;
    if(phase===null && ref && feedbackElement!==elements.get(ref)) return;
    clearTimeout(feedbackTimer);
    feedbackElement=phase && ref ? resolve(ref) : null;feedbackPhase=phase;
    if(feedbackElement) {
      const box=overlayBox('feedback');box.className='box feedback'+(phase==='applied' ? ' applied' : '');
      for(const player of box.getAnimations({subtree:true})) {player.currentTime=0;player.play();}
      if(phase==='applied') feedbackTimer=setTimeout(()=>{feedbackElement=null;feedbackPhase=null;refreshOverlays();},560);
    }
    refreshOverlays();
  }
  document.addEventListener('mousemove',event=>{
    if(!inspecting) return;
    if(!hoverPoint) send({kind:'hover-frame'});
    hoverPoint={x:event.clientX,y:event.clientY};refreshOverlays();
  },true);
  document.addEventListener('mouseout',event=>{
    if(!event.relatedTarget || event.relatedTarget?.localName==='iframe') {hoverPoint=null;hoverElement=null;refreshOverlays();}
  },true);
  window.addEventListener('pagehide',()=>globalThis.__workbenchPage?.clearOverlays());
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
  function validateStyles(value, animated=false) {
    if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('Invalid style changes');
    const entries=Object.entries(value);
    if (entries.length>limits.styleCount || (animated && !entries.length)) throw new Error('Invalid number of style changes');
    const output={};
    for (const [name,raw] of entries) {
      if (!(animated ? animationStyles : editableStyles).has(name) || typeof raw!=='string' || raw.length>limits.styleValueLength) throw new Error('Unsupported CSS property or value: '+name);
      const text=raw.trim();
      if ((animated && !text) || unsafeCss.test(text) || (text!=='' && !CSS.supports(name,text))) throw new Error('Unsupported CSS property or value: '+name);
      if (name==='background' || name==='background-image') for (const match of text.matchAll(/([a-z_-][a-z0-9_-]*)\s*\(/gi)) if (!backgroundFunctions.has(match[1].toLowerCase())) throw new Error('Unsupported background image function');
      output[name]=text;
    }
    return output;
  }
  function validEasing(value) {
    if (typeof value!=='string' || value.length>limits.easingLength || unsafeCss.test(value)) return false;
    const easing=value.trim().toLowerCase();
    if (/^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end)$/.test(easing)) return true;
    const bezier=easing.match(/^cubic-bezier\(([^()]*)\)$/);
    if (bezier) {
      const parts=bezier[1].split(',').map(part=>part.trim());
      const numbers=parts.map(Number);
      return parts.length===4 && parts.every(Boolean) && numbers.every(Number.isFinite) && numbers[0]>=0 && numbers[0]<=1 && numbers[2]>=0 && numbers[2]<=1 && CSS.supports('animation-timing-function',easing);
    }
    const steps=easing.match(/^steps\(\s*(\d+)\s*(?:,\s*(start|end|jump-start|jump-end|jump-none|jump-both))?\s*\)$/);
    return !!steps && Number(steps[1])>=1 && Number(steps[1])<=limits.stepsMax && !(steps[2]==='jump-none' && Number(steps[1])<2) && CSS.supports('animation-timing-function',easing);
  }
  function normalizeAnimation(value) {
    if (value===null) return null;
    if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!['keyframes','duration','iterations','easing','direction'].includes(key))) throw new Error('Invalid preview animation configuration');
    if (!Array.isArray(value.keyframes) || value.keyframes.length<limits.keyframesMin || value.keyframes.length>limits.keyframesMax) throw new Error('Animation requires 2 to 12 keyframes');
    if (typeof value.duration!=='number' || !Number.isFinite(value.duration) || value.duration<limits.durationMin || value.duration>limits.durationMax) throw new Error('Animation duration must be between 100 and 60000ms');
    const iterations=value.iterations ?? 1;
    if (iterations!=='infinite' && (typeof iterations!=='number' || !Number.isFinite(iterations) || iterations<1 || iterations>limits.iterationsMax)) throw new Error('Animation iterations must be 1 to 100 or infinite');
    const easing=value.easing ?? 'linear';
    if (!validEasing(easing)) throw new Error('Unsupported animation easing');
    const direction=value.direction ?? 'normal';
    if (!['normal','reverse','alternate','alternate-reverse'].includes(direction)) throw new Error('Invalid animation direction');
    let lastOffset=-1;
    const keyframes=value.keyframes.map(frame=> {
      if (!frame || typeof frame!=='object' || Array.isArray(frame) || Object.keys(frame).some(key=>!['offset','styles'].includes(key))) throw new Error('Invalid animation keyframe');
      if (frame.offset!==undefined) {
        if (typeof frame.offset!=='number' || !Number.isFinite(frame.offset) || frame.offset<0 || frame.offset>1 || frame.offset<lastOffset) throw new Error('Keyframe offsets must be ordered between 0 and 1');
        lastOffset=frame.offset;
      }
      return {...(frame.offset===undefined ? {} : {offset:frame.offset}),styles:validateStyles(frame.styles,true)};
    });
    return {keyframes,duration:value.duration,iterations,easing:easing.trim(),direction};
  }
  const clone = value => value===null ? null : JSON.parse(JSON.stringify(value));
  function animationSnapshot(record) {
    if (!record) return null;
    return {token:record.token,config:clone(record.config),currentTime:record.player ? record.player.currentTime : record.currentTime,playState:record.player ? record.player.playState : record.playState,playbackRate:record.player ? record.player.playbackRate : record.playbackRate};
  }
  function prepareAnimation(el,config,snapshot,token={}) {
    const record={token,config:clone(config),player:null,effect:null,currentTime:snapshot?.currentTime ?? 0,playState:snapshot?.playState || (config ? 'running' : 'idle'),playbackRate:snapshot?.playbackRate ?? 1};
    if (config && !reducedMotion.matches) {
      const frames=config.keyframes.map(frame=> {
        const result={...(frame.offset===undefined ? {} : {offset:frame.offset})};
        for (const [name,value] of Object.entries(frame.styles)) result[name.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=value;
        return result;
      });
      record.effect=new KeyframeEffect(el,frames,{duration:config.duration,iterations:config.iterations==='infinite' ? Infinity : config.iterations,easing:config.easing,direction:config.direction,fill:'none'});
      record.player=new Animation(record.effect,document.timeline);
      record.player.id='workbench-preview:'+docId+':'+(++nextAnimationId);
      record.keyframesSignature=JSON.stringify(record.effect.getKeyframes());
      record.timingSignature=JSON.stringify(record.effect.getTiming());
    }
    return record;
  }
  function checkAnimation(record) {
    if (!record?.player) return;
    if (record.player.effect!==record.effect || JSON.stringify(record.effect.getKeyframes())!==record.keyframesSignature || JSON.stringify(record.effect.getTiming())!==record.timingSignature) throw new Error('Page animation changed after this edit; refusing to overwrite newer changes');
  }
  function applyAnimation(el,record) {
    ownedAnimations.get(el)?.player?.cancel();
    if (!record) { ownedAnimations.delete(el); return; }
    ownedAnimations.set(el,record);
    if (!record.player) return;
    record.player.playbackRate=record.playbackRate;
    if (record.playState==='running') record.player.play();
    else if (record.playState==='paused') record.player.pause();
    else if (record.playState==='finished') record.player.finish();
    if (record.playState!=='idle' && typeof record.currentTime==='number') record.player.currentTime=record.currentTime;
  }
  reducedMotion.addEventListener('change',()=> {
    for (const [el,record] of ownedAnimations) {
      if (!el.isConnected) { record.player?.cancel(); ownedAnimations.delete(el); continue; }
      if (!record.config) continue;
      const saved=animationSnapshot(record);
      applyAnimation(el,prepareAnimation(el,record.config,saved,record.token));
    }
  });
  function inspect(ref) {
    const el=resolve(ref);
    const attributes={};
    for (const attribute of el.attributes) if (attributeNames.has(attribute.name)) attributes[attribute.name]=sensitive(el) && !['type','role','disabled','readonly','tabindex'].includes(attribute.name) ? '[hidden]' : clean(attribute.value,512);
    const computed={};
    const style=getComputedStyle(el);
    for (const name of styleNames) computed[name]=clean(style.getPropertyValue(name),2000);
    const ancestors=[];
    for (let node=parent(el); node && ancestors.length<8; node=parent(node)) ancestors.push(describe(node));
    const textContent=sensitive(el) ? '[hidden]' : el.children.length || el.shadowRoot ? safeText(el,textLimit) : clean(leafText(el),textLimit);
    const animation=ownedAnimations.get(el);
    return {...describe(el),semantics:semantics(el),textContent,...textEditState(el),attributes,computed,ancestors,animation:animation?.config ? clone(animation.config) : null,animationState:animation?.config ? reducedMotion.matches && !animation.player ? 'reduced-motion' : animation.player?.playState || 'idle' : 'idle'};
  }
  document.addEventListener('click', event=> {
    if (!event.isTrusted && source!=='agent') return;
    const target=describe(eventTarget(event));
    if (target) {send({kind:'click',target});if(source==='agent') feedback(target.ref,'applied');}
  },true);
  document.addEventListener('input', event=> {
    if (!event.isTrusted && source!=='agent') return;
    const el=eventTarget(event);
    if (!el) return;
    const target=describe(el);
    send({kind:el.tagName==='SELECT' ? 'select' : 'fill',target,value:target.value || ''});
    if(source==='agent') feedback(target.ref,'applied');
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
    setInspect(value) { inspecting=!!value;hoverPoint=null;hoverElement=null;refreshOverlays(); },
    leave() { hoverPoint=null;hoverElement=null;refreshOverlays(); },
    feedback,
    clearOverlays() {
      inspecting=false;hoverPoint=null;hoverElement=null;selectedElement=null;feedbackElement=null;feedbackPhase=null;clearTimeout(feedbackTimer);
      cancelAnimationFrame(overlayFrame);overlayFrame=0;overlayHost?.remove();
    },
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
    node(ref) { return resolve(ref); },
    previewStyles(request) {
      const el=resolve(request.ref);
      // Direct manipulation must show the real color, without a previous success wash.
      if(feedbackElement===el) { clearTimeout(feedbackTimer);feedbackElement=null;feedbackPhase=null;refreshOverlays(); }
      if (sensitive(el) || blockedEditTags.has(el.localName.toUpperCase())) throw new Error('Sensitive or executable elements cannot be edited');
      const styles=validateStyles(request.styles);
      let patch=request.editId ? patches.get(request.editId) : undefined;
      if (request.editId && (!patch || !patch.transient || patch.el!==el || patch.ref!==request.ref || editOrder.at(-1)!==request.editId)) throw new Error('The preview gesture is stale');
      if (patch && el.style.cssText!==patch.afterCssText) throw new Error('Page styles changed during this gesture; refusing to overwrite newer changes');
      const editId=request.editId || docId+':edit:'+(++nextEditId);
      if (!patch) {
        patch={ref:request.ref,el,hasStyles:true,beforeCssText:el.style.cssText,transient:true,styles:{}};
        patches.set(editId,patch);editOrder.push(editId);
      }
      for (const [name,value] of Object.entries(styles)) value==='' ? el.style.removeProperty(name) : el.style.setProperty(name,value);
      Object.assign(patch.styles,styles);patch.afterCssText=el.style.cssText;
      return {editId};
    },
    commitStyles(editId) {
      const patch=patches.get(editId);
      if (!patch || !patch.transient) throw new Error('No active preview gesture');
      const el=resolve(patch.ref);
      if (el!==patch.el || el.style.cssText!==patch.afterCssText) throw new Error('Page styles changed during this gesture; refusing to overwrite newer changes');
      patch.transient=false;
      send({kind:'edit',target:describe(el),editId,value:JSON.stringify({styles:patch.styles})});
      return {editId,element:inspect(patch.ref)};
    },
    edit(request) {
      if (!request || typeof request!=='object' || Array.isArray(request) || Object.keys(request).some(key=>!['ref','text','styles','animation'].includes(key))) throw new Error('Only text, supported styles and a preview animation can be edited');
      const el=resolve(request.ref);
      if (sensitive(el) || blockedEditTags.has(el.localName.toUpperCase())) throw new Error('Sensitive or executable elements cannot be edited');
      const hasText=Object.hasOwn(request,'text');
      if (hasText && (typeof request.text!=='string' || request.text.length>textLimit || clean(request.text,textLimit+1)!==request.text)) throw new Error('Invalid or sensitive replacement text');
      if (hasText) { const state=textEditState(el); if (!state.editableText) throw new Error(state.editReason); }
      const styles=request.styles===undefined ? {} : validateStyles(request.styles);
      const entries=Object.entries(styles);
      const hasAnimation=Object.hasOwn(request,'animation');
      if (!hasText && !entries.length && !hasAnimation) throw new Error('No preview changes were provided');
      const animation=hasAnimation ? normalizeAnimation(request.animation) : undefined;
      if (hasAnimation) checkAnimation(ownedAnimations.get(el));
      const beforeAnimation=hasAnimation ? animationSnapshot(ownedAnimations.get(el)) : undefined;
      const prepared=hasAnimation ? prepareAnimation(el,animation) : undefined;
      const textNodes=hasText ? [...el.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE) : [];
      const beforeText=textNodes.map(node=>node.nodeValue);
      const created=hasText && textNodes.length===0;
      const beforeCssText=el.style.cssText;
      if (created) { const node=document.createTextNode(''); el.appendChild(node); textNodes.push(node); }
      if (hasText) textNodes.forEach((node,index)=> { node.nodeValue=index===0 ? request.text : ''; });
      for (const [name,value] of entries) value==='' ? el.style.removeProperty(name) : el.style.setProperty(name,value);
      if (hasAnimation) applyAnimation(el,prepared);
      const editId=docId+':edit:'+(++nextEditId);
      patches.set(editId,{ref:request.ref,el,textNodes,beforeText,created,hasText,afterText:textNodes.map(node=>node.nodeValue),hasStyles:entries.length>0,beforeCssText,afterCssText:el.style.cssText,hasAnimation,beforeAnimation,afterAnimationToken:prepared?.token});
      editOrder.push(editId);
      send({kind:'edit',target:describe(el),editId,value:JSON.stringify({...(hasText ? {text:request.text} : {}),...(entries.length ? {styles} : {}),...(hasAnimation ? {animation} : {})})});
      feedback(request.ref,'applied');
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
      let restoredAnimation;
      if (patch.hasAnimation) {
        const current=ownedAnimations.get(el);
        if (current?.token!==patch.afterAnimationToken) throw new Error('Preview animation changed after this edit; undo the newer animation first');
        checkAnimation(current);
        restoredAnimation=patch.beforeAnimation ? prepareAnimation(el,patch.beforeAnimation.config,patch.beforeAnimation,patch.beforeAnimation.token) : null;
      }
      if (patch.hasText) {
        if (patch.created) patch.textNodes[0].remove();
        else patch.textNodes.forEach((node,index)=> { node.nodeValue=patch.beforeText[index]; });
      }
      if (patch.hasStyles) el.style.cssText=patch.beforeCssText;
      if (patch.hasAnimation) applyAnimation(el,restoredAnimation);
      patches.delete(id);
      editOrder.splice(editOrder.indexOf(id),1);
      send({kind:'undo',target:describe(el),editId:id,value:JSON.stringify({editId:id})});
      feedback(patch.ref,'applied');
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
      selectedElement=ref ? resolve(ref) : null;refreshOverlays();
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
