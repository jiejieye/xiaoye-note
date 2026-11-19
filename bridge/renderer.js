(() => {
  const callbacks = new Map(), listeners = new Map();
  let sequence = 1;
  const post = message => window.ipc.postMessage(JSON.stringify(message));
  window.__xiaoyeResolve = message => {
    const callback = callbacks.get(message.requestId);
    if (callback) { callbacks.delete(message.requestId); message.error ? callback.reject(new Error(message.error)) : callback.resolve(message.value); }
  };
  window.__xiaoyeEmit = (channel, args) => { for (const listener of listeners.get(channel) || []) listener({}, ...args); };
  window.__xiaoyeRequire = name => {
    if (name !== 'electron') throw new Error('Unsupported preload module');
    return {
      contextBridge: { exposeInMainWorld: (name, value) => { window[name] = value; } },
      ipcRenderer: {
        invoke: (channel, ...args) => new Promise((resolve, reject) => { const requestId=sequence++; callbacks.set(requestId,{resolve,reject}); post({type:'ipc',channel,args,requestId}); }),
        send: (channel, ...args) => {
          if(channel==='window:dragStart'){post({type:'drag'});return;}
          if(channel==='window:dragMove'||channel==='window:dragEnd')return;
          post({type:'ipc',channel,args,send:true});
        },
        on: (channel, listener) => { if(!listeners.has(channel))listeners.set(channel,new Set());listeners.get(channel).add(listener); },
        removeListener: (channel, listener) => listeners.get(channel)?.delete(listener)
      }
    };
  };
  document.addEventListener('contextmenu', event => { if(location.protocol==='data:'){event.preventDefault();post({type:'contextMenu'});} });
  document.addEventListener('pointerdown', event => {
    if(event.button===0){const edge=(event.clientY<5?'n':event.clientY>innerHeight-5?'s':'')+(event.clientX<5?'w':event.clientX>innerWidth-5?'e':'');if(edge){event.preventDefault();event.stopImmediatePropagation();post({type:'resize',direction:edge});return;}}
    if(event.button!==0 || event.target.closest('button,input,textarea,select,a,[contenteditable]'))return;
    const target=event.target.closest('*');
    if(target && getComputedStyle(target).getPropertyValue('-webkit-app-region').trim()==='drag')post({type:'drag'});
  },true);
  window.addEventListener('error', event => post({type:'rendererError',message:event.message}));
  window.addEventListener('unhandledrejection', event => post({type:'rendererError',message:String(event.reason?.stack||event.reason)}));
  window.close = () => post({type:'close'});
})();
