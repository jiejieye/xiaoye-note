const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');
const readline = require('node:readline');
const { decryptCredential } = require('./profile.cjs');
const root = path.resolve(__dirname, '..');
const testDataDir = process.env.XIAOYE_TEST_DATA_DIR && fs.realpathSync(process.env.XIAOYE_TEST_DATA_DIR);
if(testDataDir && !testDataDir.toLowerCase().startsWith((fs.realpathSync(path.join(root,'validation'))+path.sep).toLowerCase()))throw new Error('验证数据必须放在隔离版 validation 目录内');
const production = process.env.XIAOYE_PRODUCTION === '1' && !testDataDir;
const checkMode = process.env.XIAOYE_SELF_CHECK === '1';
let dataDir = testDataDir || path.join(root, 'data');
const handlers = new Map(), wins = new Map(), pending = new Map(), menus = new Map(), protocols = new Map();
let sequence = 1, base, boot, readyResolve;
const ready = new Promise(resolve => readyResolve = resolve);
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
console.log = console.info = (...args) => console.error(...args);
function native(op, payload = {}) { write({op, ...payload}); }
function request(op, payload = {}) {
  return new Promise((resolve, reject) => { const requestId = sequence++; pending.set(requestId, {resolve,reject}); native(op, {...payload,requestId}); });
}
function sync(op, payload = {}) {
  const result = spawnSync(process.env.XIAOYE_HOST, ['--native'], { input: JSON.stringify({op,...payload}), encoding:'utf8', windowsHide:true, maxBuffer:64*1024*1024 });
  if (result.status !== 0) {
    const failure = { operation: op, status: result.status, signal: result.signal, code: result.error?.code, message: result.error?.message };
    fs.appendFileSync(path.join(root, 'validation/helper-errors.jsonl'), JSON.stringify(failure) + '\n');
    throw new Error(`本机接口 ${op} 执行失败（${result.error?.code || result.status}）`);
  }
  const response = JSON.parse(result.stdout);
  if(response.error) throw new Error(response.error);
  return response.value;
}
const ipcMain = new EventEmitter();
ipcMain.handle = (channel, callback) => handlers.set(channel, callback);
class BrowserWindow extends EventEmitter {
  constructor(options = {}) {
    super(); this.id=sequence++; this.options=options; this.bounds={x:0,y:0,width:800,height:600,...options};
    this.bounds=Object.fromEntries(['x','y','width','height'].map(k=>[k,this.bounds[k]]));
    this.visible=!!options.show; this.destroyed=false; this.minimized=false; this.loading=true;
    this.webContents=new EventEmitter(); this.webContents.id=this.id;
    this.webContents.send=(channel,...args)=>native('emit',{id:this.id,channel,args});
    this.webContents.isDestroyed=()=>this.destroyed;
    this.webContents.isLoading=()=>this.loading;
    this.webContents.setWindowOpenHandler=handler=>{this.openHandler=handler;};
    this.webContents.executeJavaScript=script=>request('eval',{id:this.id,script});
    wins.set(this.id,this);
    const {parent, webPreferences, ...nativeOptions}=options;
    native('create',{id:this.id,options:nativeOptions});
  }
  static getAllWindows(){return [...wins.values()].filter(w=>!w.destroyed);}
  static fromWebContents(contents){return wins.get(contents?.id);}
  getBounds(){return {...this.bounds};}
  setBounds(bounds){this.bounds={...this.bounds,...bounds};native('bounds',{id:this.id,bounds:this.bounds});}
  setMinimumSize(width,height){native('minimum',{id:this.id,width,height});}
  setResizable(value){native('resizable',{id:this.id,value});this.__reapplyOpacity();}
  setSkipTaskbar(value){native('taskbar',{id:this.id,value});}
  setAlwaysOnTop(value){native('topmost',{id:this.id,value});this.__reapplyOpacity();}
  setOpacity(value){this.__opacity=Number(value);native('opacity',{id:this.id,value});}
  // tao重算窗口样式时会清掉WS_EX_LAYERED，置顶/显示/调整大小/恢复后重新套用透明度
  __reapplyOpacity(){if(Number.isFinite(this.__opacity))native('opacity',{id:this.id,value:this.__opacity});}
  show(){this.visible=true;this.minimized=false;native('show',{id:this.id,surface:this.__surface});this.__reapplyOpacity();}
  hide(){this.visible=false;native('hide',{id:this.id});}
  focus(){native('focus',{id:this.id});}
  moveTop(){this.focus();}
  minimize(){this.minimized=true;native('minimize',{id:this.id});}
  restore(){this.minimized=false;native('restore',{id:this.id});this.__reapplyOpacity();}
  isVisible(){return this.visible;}
  isMinimized(){return this.minimized;}
  isFocused(){return !!this.focused;}
  isDestroyed(){return this.destroyed;}
  removeMenu(){}
  hookWindowMessage(message,callback){this.on('native:'+message,callback);}
  close(){const event={defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};this.emit('close',event);if(!event.defaultPrevented){this.destroyed=true;wins.delete(this.id);native('destroy',{id:this.id});this.emit('closed');}}
  loadFile(file,options={}){
    const relative=path.relative(path.join(root,'app'),file).split(path.sep).join('/');
    const query=new URLSearchParams(options.query||{});
    return this.loadURL(`${base}/app/${relative}?${query}`);
  }
  loadURL(url){
    this.url=url.replaceAll('xiaoye-asset://',`${base}/asset/`);
    const preload=this.options.webPreferences?.preload;
    const source=preload?fs.readFileSync(preload,'utf8'):'';
    native('load',{id:this.id,url:this.url,preload:source});
    return Promise.resolve();
  }
}
const app = new EventEmitter();
app.setName=()=>{}; app.setAppUserModelId=()=>{};app.requestSingleInstanceLock=()=>true;
app.getPath=name=>name==='userData'?dataDir:name==='temp'?require('node:os').tmpdir():root;
app.whenReady=()=>ready;
app.getVersion=()=> '1.0.0-webview2';
app.exit=code=>{native('exit',{code});process.exit(code);};
app.relaunch=()=>native('relaunch');
app.quit=()=>{const event={defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};app.emit('before-quit',event);if(!event.defaultPrevented){app.emit('will-quit');native('exit');process.exit(0);}};
app.setLoginItemSettings = options => {
  if (production && !checkMode) sync('startup', { enabled: !!options.openAtLogin });
  app.login = !!options.openAtLogin;
};
app.getLoginItemSettings = () => production && !checkMode ? sync('startupStatus') : { openAtLogin: !!app.login };
const screen = new EventEmitter();
screen.getPrimaryDisplay=()=>boot.displays[0];
screen.getAllDisplays=()=>boot.displays;
screen.getCursorScreenPoint=()=>boot.cursor;
screen.getDisplayNearestPoint=point=>screen.getDisplayMatching({...point,width:1,height:1});
screen.getDisplayMatching=bounds=>boot.displays.reduce((best,d)=>{
  const b=d.bounds;const area=Math.max(0,Math.min(bounds.x+bounds.width,b.x+b.width)-Math.max(bounds.x,b.x))*Math.max(0,Math.min(bounds.y+bounds.height,b.y+b.height)-Math.max(bounds.y,b.y));
  return area>best.area?{display:d,area}:best;
},{display:boot.displays[0],area:-1}).display;
class NativeImage {
  constructor(bytes){this.bytes=Buffer.from(bytes||[]);}
  isEmpty(){return !this.bytes.length;}
  operation(action,options={}){return sync('image',{action,bytes:this.bytes.toString('base64'),...options});}
  toPNG(){return Buffer.from(this.operation('png').bytes,'base64');}
  toDataURL(){return 'data:image/png;base64,'+this.toPNG().toString('base64');}
  getSize(){const value=this.operation('size');return {width:value.width,height:value.height};}
  resize(options){return new NativeImage(Buffer.from(this.operation('resize',options).bytes,'base64'));}
}
const nativeImage={createFromPath:file=>new NativeImage(fs.readFileSync(file)),createFromBuffer:bytes=>new NativeImage(bytes),createFromDataURL:url=>new NativeImage(Buffer.from(url.split(',')[1]||'','base64'))};
const clipboard={readText:()=>sync('clipboard',{action:'text'}),readImage:()=>new NativeImage(Buffer.from(sync('clipboard',{action:'image'})||'','base64')),writeText:text=>sync('clipboard',{action:'writeText',text}),writeImage:image=>sync('clipboard',{action:'writeImage',bytes:image.toPNG().toString('base64')})};
let menuSequence=1;
function buildMenu(template){return template.map(item=>{const id='menu-'+menuSequence++;if(item.click)menus.set(id,item.click);return {id,label:item.label||'',type:item.type,enabled:item.enabled!==false,checked:!!item.checked,submenu:item.submenu?buildMenu(item.submenu):undefined};});}
const Menu={buildFromTemplate:template=>{const items=buildMenu(template);return {items,popup:({window}={})=>native('popup',{id:window?.id,items})};}};
class Tray extends EventEmitter {
  constructor(image){super();Tray.current=this;native('tray',{bytes:image.bytes.toString('base64')});}
  setToolTip(value){native('tooltip',{value});}
  setContextMenu(menu){native('menu',{items:menu.items});}
}
const dialog={
  showSaveDialog:(...args)=>request('dialog',{kind:'save',options:args.at(-1)}),
  showOpenDialog:(...args)=>request('dialog',{kind:'open',options:args.at(-1)}),
  showErrorBox:(title,message)=>native('error',{title,message})
};
const shell={openPath:file=>request('open',{value:file}),openExternal:url=>request('open',{value:url})};
class Notification {
  static isSupported(){return production && !checkMode || process.env.XIAOYE_NOTIFICATION_TEST === '1';}
  constructor(options){this.options=options;}
  show(){return request('notify',{options:this.options});}
}
const safeStorage={isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from(sync('encrypt',{text}),'base64'),decryptString:bytes=>decryptCredential(bytes,dataDir,sync)};
const globalShortcut={callbacks:new Map(),register(key,callback){this.callbacks.set(key,callback);native('hotkey',{key});return true;},unregisterAll(){native('unregisterHotkeys');}};
const protocol={handle:(scheme,handler)=>protocols.set(scheme,handler)};
const electron={app,BrowserWindow,ipcMain,screen,nativeImage,clipboard,Menu,Tray,dialog,shell,Notification,safeStorage,globalShortcut,protocol};
const originalLoad=Module._load;
Module._load=function(name,...args){return name==='electron'?electron:originalLoad.call(this,name,...args);};
const mainFile = path.join(root, 'app/src/electron/main.js');
const originalCompile = Module.prototype._compile;
Module.prototype._compile = function(source, filename) {
  if (path.resolve(filename) === mainFile) {
    // 原业务文件保持冻结，投递成功后才提交提醒去重记录。
    source = source.replaceAll('notification.show();', 'await notification.show();');
    source = source.replace('await notification.show(); delivered[entry.key] = now.getTime();',
      'await notification.show(); delivered[entry.key] = now.getTime(); await commitUiStatePatch({ reminderDeliveryKeys: { ...delivered } }); await commitDataSnapshot(dataCache, { staged: true });');
    source = source.replace('try { await noteSync.autoSync(); }',
      'try { await noteSync.autoSync(); if (!noteSync.state.pendingScheduleUpload) noteSync.error = ""; }');
    if (process.env.XIAOYE_NOTIFICATION_TEST === '1' && testDataDir) {
      source += '\nmodule.exports.checkBackgroundReminders = checkBackgroundReminders;';
    }
  }
  return originalCompile.call(this, source, filename);
};
const originalFetch=global.fetch;
global.fetch=(url,options)=>{if((!production||checkMode)&&!String(url).startsWith('http://127.0.0.1:'))return Promise.reject(new Error('隔离验证版已暂停联网同步，请保留使用原版的同步功能。'));return originalFetch(url,options);};
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.ico':'image/x-icon','.svg':'image/svg+xml'};
const token=crypto.randomBytes(24).toString('hex');
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    const prefix='/'+token;
    if(!url.pathname.startsWith(prefix+'/')){res.writeHead(403).end();return;}
    let route=decodeURIComponent(url.pathname.slice(prefix.length));
    if(route.startsWith('/asset/')){
      const handler=protocols.get('xiaoye-asset');if(!handler){res.writeHead(404).end();return;}
      const response=await handler({url:'xiaoye-asset://'+route.slice(7)});res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    if(!route.startsWith('/app/')){res.writeHead(404).end();return;}
    const file=path.resolve(root,route.slice(1));
    if(!file.startsWith(path.join(root,'app')+path.sep)){res.writeHead(403).end();return;}
    let bytes=await fs.promises.readFile(file);const ext=path.extname(file);
    if(['.js','.html'].includes(ext)){
      let source=bytes.toString('utf8').replaceAll('xiaoye-asset://',base+'/asset/');
      if(file===path.join(root,'app/src/renderer/app.js')){
        // 原文件保持冻结；仅在送入 WebView2 时增加只读的生命周期探针。
        source=source.replace(/  startApp\(\);\r?\n\}\)\(\);\s*$/,`  window.__xiaoyePrepareSleep = async () => {
    await persistQueue; await dataRefreshBarrier;
    if (!dataLoaded || dirtyDraftKeys.size || state.pendingNewImages?.length || state.showSettings || state.showReminderSettings || state.showTrash || state.searchOpen) return false;
    return !app.querySelector(draftPanelSelector + ',form,[role=dialog],details[open]');
  };
  startApp();
})();`);
      }
      bytes=Buffer.from(source);
    }
    res.writeHead(200,{'Content-Type':mime[ext]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});res.end(bytes);
  }catch{res.writeHead(404).end();}
});
async function message(msg){
  if (msg.op === 'audit') {
    await ready;
    try {
      const data = await handlers.get('data:load')();
      const syncStatus = await handlers.get('sync:status')();
      const report = {
        checkedAt: new Date().toISOString(), production, dataDir,
        counts: Object.fromEntries(['notes', 'todos', 'events', 'workTrees'].map(key => [key, data[key]?.length || 0])),
        startupExpected: !!data.settings?.launchAtStartup,
        startupActual: app.getLoginItemSettings().openAtLogin,
        remindersPaused: !!data.settings?.pauseReminders,
        sync: { connected: !!syncStatus.connected, running: !!syncStatus.running, error: syncStatus.error || '' }
      };
      if (msg.includeWechat) {
        report.wechat = await handlers.get('wechat-reminder:settings')(null, 'get');
        const rules = await handlers.get('wechat-reminder:settings')(null, 'rules-get');
        report.wechatRules = { count: rules.rules?.length || 0, error: rules.error || '' };
      }
      if (msg.testNotification) {
        report.notification = await handlers.get('reminder:notify')(null, { title: '小叶便签接管验证', body: '完整版后台提醒通道已接通。' });
      }
      fs.writeFileSync(path.join(root, 'validation/runtime-audit.json'), JSON.stringify(report, null, 2));
    } catch (error) {
      fs.writeFileSync(path.join(root, 'validation/runtime-audit.json'), JSON.stringify({ error: error.message }));
    }
    return;
  }
  if(msg.op==='boot'){
    boot=msg;
    if (production) {
      try {
        dataDir = path.join(root, 'user-data');
        fs.mkdirSync(dataDir, { recursive: true });
        if (!checkMode) {
          try { sync('registerNotifications'); }
          catch (error) { console.error('无法注册小叶便签系统通知：', error.message); }
        }
      } catch (error) {
        fs.appendFileSync(path.join(root, 'validation/startup-errors.log'), error.stack + '\n');
        native('error', { title: '小叶便签完整版', message: error.message });
        native('exit', { code: 1 });
        return;
      }
    }
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}/${token}`;
    const main = require('../app/src/electron/main.js');
    if (process.env.XIAOYE_NOTIFICATION_TEST === '1' && testDataDir) {
      ipcMain.handle('test:checkReminders', () => main.checkBackgroundReminders());
    }
    readyResolve();return;
  }
  if(msg.op==='reply'){const task=pending.get(msg.requestId);if(task){pending.delete(msg.requestId);msg.error?task.reject(new Error(msg.error)):task.resolve(msg.value);}return;}
  if(msg.op==='cursor'){boot.cursor=msg.point;return;}
  if(msg.op==='menuClick'){menus.get(msg.id)?.();return;}
  if(msg.op==='trayClick'){Tray.current?.emit('click');return;}
  if(msg.op==='hotkey'){globalShortcut.callbacks.get(msg.key)?.();return;}
  if(msg.op==='quit'){app.quit();return;}
  if(msg.op==='activate'){app.emit('activate');return;}
  const win=wins.get(msg.id);if(!win)return;
  if(msg.op==='loaded'){win.loading=false;win.webContents.emit('did-finish-load');win.emit('ready-to-show');return;}
  if(msg.op==='boundsChanged'){const previous=win.bounds;win.bounds=msg.bounds;if(previous.x!==msg.bounds.x||previous.y!==msg.bounds.y)win.emit('move');if(previous.width!==msg.bounds.width||previous.height!==msg.bounds.height)win.emit('resize');return;}
  if(msg.op==='nativeMessage'){if(msg.bounds)win.bounds=msg.bounds;win.emit('native:'+msg.message);return;}
  if(msg.op==='close'){win.close();return;}
  if(msg.op==='focused'){win.focused=msg.value;return;}
  if(msg.op==='contextMenu'){win.webContents.emit('context-menu');return;}
  if(msg.op==='ipc'){
    const {requestId,channel,args=[],send}=msg;
    try{
      const event={sender:win.webContents};
      if(send){ipcMain.emit(channel,event,...args);return;}
      const handler=handlers.get(channel);if(!handler)throw new Error('未知接口：'+channel);
      let result=await handler(event,...args);
      if(result instanceof BrowserWindow)result=true;
      native('resolve',{id:win.id,requestId,value:result??null});
    }catch(error){native('resolve',{id:win.id,requestId,error:error.message});}
  }
}
readline.createInterface({input:process.stdin}).on('line',line=>{try{message(JSON.parse(line)).catch(e=>console.error(e.stack));}catch(e){console.error(e.message);}});
process.stdin.on('end',()=>process.exit(0));
process.on('unhandledRejection',error=>{console.error(error.stack||error);native('backendError',{message:error.message||String(error)});});
