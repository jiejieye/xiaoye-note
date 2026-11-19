#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod notifications;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
use serde_json::{json, Value};
use std::{collections::HashMap, io::{BufRead, Read, Write}, path::PathBuf, process::{Child, ChildStdin, Command, Stdio}, sync::{Arc, Mutex, OnceLock, LazyLock}, time::{Duration, Instant}};
use std::os::windows::process::CommandExt;
use tao::{dpi::{LogicalPosition, LogicalSize, PhysicalPosition}, event::{Event, WindowEvent}, event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy, EventLoopWindowTarget}, platform::windows::WindowExtWindows, window::{Window, WindowBuilder}};
use tray_icon::{menu::{CheckMenuItem, ContextMenu, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu}, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use windows_sys::Win32::{Foundation::{CloseHandle, GetLastError, POINT, RECT, ERROR_ALREADY_EXISTS}, UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSMICON, SM_CYSMICON, MINMAXINFO, GetClientRect, GetWindowRect, GetCursorPos, GetWindowLongW, SetWindowLongW, SetWindowPos, SetLayeredWindowAttributes, SWP_NOZORDER, SWP_NOACTIVATE, SWP_NOSIZE, GWL_EXSTYLE, WS_EX_LAYERED, LWA_ALPHA}, Graphics::Gdi::{MonitorFromPoint, GetMonitorInfoW, MONITORINFO, MONITOR_DEFAULTTONEAREST}, System::Threading::CreateMutexW};
use wry::WebViewExtWindows;

#[derive(Clone)]
enum UserEvent { Backend(Value), Ipc(u64,String), Loaded(u64), Captured(u64,bool), Tick, Menu(MenuEvent), Tray(TrayIconEvent), Hotkey(GlobalHotKeyEvent) }
struct View { window: Window, webview: Option<wry::WebView>, url: String, preload: String, hidden_at: Option<Instant>, visible: bool }
type Sender = Arc<Mutex<ChildStdin>>;
static MINIMUM_SIZES:LazyLock<Mutex<HashMap<usize,(f64,f64)>>>=LazyLock::new(||Mutex::new(HashMap::new()));
static NATIVE_OUTPUT:OnceLock<Sender>=OnceLock::new();
#[link(name="dwmapi")]
unsafe extern "system" { fn DwmSetWindowAttribute(hwnd:isize,attribute:u32,value:*const std::ffi::c_void,size:u32)->i32; }
#[link(name="user32")]
unsafe extern "system" { fn GetDpiForWindow(hwnd:isize)->u32; }
#[link(name="comctl32")]
unsafe extern "system" {
    fn SetWindowSubclass(hwnd:isize,callback:unsafe extern "system" fn(isize,u32,usize,isize,usize,usize)->isize,id:usize,data:usize)->i32;
    fn DefSubclassProc(hwnd:isize,message:u32,wparam:usize,lparam:isize)->isize;
}
unsafe extern "system" fn native_events(hwnd:isize,message:u32,wparam:usize,lparam:isize,_subclass:usize,id:usize)->isize {
    if message==0x0024{let result=DefSubclassProc(hwnd,message,wparam,lparam);if let Some(&(width,height))=MINIMUM_SIZES.lock().unwrap().get(&id){let scale=GetDpiForWindow(hwnd)as f64/96.0;let info=&mut *(lparam as *mut MINMAXINFO);info.ptMinTrackSize.x=(width*scale).round()as i32;info.ptMinTrackSize.y=(height*scale).round()as i32;}return result;}
    if matches!(message,0x0214|0x0216|0x0231|0x0232){if let Some(output)=NATIVE_OUTPUT.get(){let mut outer:RECT=std::mem::zeroed();let mut client:RECT=std::mem::zeroed();GetWindowRect(hwnd as _,&mut outer);GetClientRect(hwnd as _,&mut client);let scale=GetDpiForWindow(hwnd)as f64/96.0;send(output,json!({"op":"nativeMessage","id":id,"message":message,"bounds":{"x":(outer.left as f64/scale).round(),"y":(outer.top as f64/scale).round(),"width":((client.right-client.left)as f64/scale).round(),"height":((client.bottom-client.top)as f64/scale).round()}}));}}
    DefSubclassProc(hwnd,message,wparam,lparam)
}
fn send(output: &Sender, value: Value) { let mut stream=output.lock().unwrap(); let _=writeln!(stream,"{value}"); }
fn root() -> PathBuf { std::env::current_exe().unwrap().parent().unwrap().to_path_buf() }
fn native_helper() -> Result<Value,String> {
    let mut input=String::new();std::io::stdin().read_to_string(&mut input).map_err(|e|e.to_string())?;
    let mut request:Value=serde_json::from_str(&input).map_err(|e|e.to_string())?;
    if request["op"] == "registerNotifications" {
        unsafe { windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED).map_err(|error| error.to_string())?; }
        notifications::register()?;
        return Ok(json!(true));
    }
    if request["op"] == "notify" {
        unsafe { windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED).map_err(|error| error.to_string())?; }
        notifications::initialize_process()?;
        notifications::send(request["title"].as_str().unwrap_or("小叶便签提醒"), request["body"].as_str().unwrap_or(""), request["silent"].as_bool().unwrap_or(false))?;
        return Ok(json!({"shown": true}));
    }
    if request["op"] == "notificationHistoryCount" {
        unsafe { windows::Win32::System::WinRT::RoInitialize(windows::Win32::System::WinRT::RO_INIT_MULTITHREADED).map_err(|error| error.to_string())?; }
        return notifications::history_count().map(|count| json!(count));
    }
    if request["op"]=="image" {
        let bytes=B64.decode(request["bytes"].as_str().unwrap_or("")).map_err(|e|e.to_string())?;
        let mut image=image::load_from_memory(&bytes).map_err(|e|e.to_string())?;
        if request["action"]=="size" { return Ok(json!({"width":image.width(),"height":image.height()})); }
        if request["action"]=="resize" { image=image.resize_exact(request["width"].as_u64().unwrap_or(1) as u32,request["height"].as_u64().unwrap_or(1) as u32,image::imageops::FilterType::Triangle); }
        let mut bytes=std::io::Cursor::new(Vec::new());image.write_to(&mut bytes,image::ImageFormat::Png).map_err(|e|e.to_string())?;
        return Ok(json!({"bytes":B64.encode(bytes.into_inner())}));
    }
    let mut child=Command::new("powershell.exe").args(["-NoProfile","-NonInteractive","-STA","-ExecutionPolicy","Bypass","-File"]).arg(root().join("bridge/native.ps1")).creation_flags(0x08000000).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e|e.to_string())?;
    request["executable"] = json!(std::env::current_exe().unwrap().to_string_lossy());
    child.stdin.take().unwrap().write_all(request.to_string().as_bytes()).map_err(|e|e.to_string())?;
    let out=child.wait_with_output().map_err(|e|e.to_string())?;
    let bytes=out.stdout.strip_prefix(&[0xef,0xbb,0xbf]).unwrap_or(&out.stdout);
    let result:Value=serde_json::from_slice(bytes).map_err(|error|format!("本机操作未返回有效结果（退出码 {:?}，输出 {} 字节，{}）",out.status.code(),out.stdout.len(),error))?;
    if let Some(error)=result["error"].as_str(){return Err(error.into());}Ok(result["value"].clone())
}
fn bounds(window:&Window)->Value {
    let scale=window.scale_factor();let size=window.inner_size().to_logical::<f64>(scale);let position=window.outer_position().unwrap_or(PhysicalPosition::new(0,0)).to_logical::<f64>(scale);
    json!({"x":position.x.round(),"y":position.y.round(),"width":size.width.round(),"height":size.height.round()})
}
fn fill_menu(menu:&Menu, items:&[Value]) {
    for item in items {
        if item["type"]=="separator" {let _=menu.append(&PredefinedMenuItem::separator());}
        else if let Some(children)=item["submenu"].as_array(){let sub=Submenu::new(item["label"].as_str().unwrap_or(""),true);fill_submenu(&sub,children);let _=menu.append(&sub);}
        else if item["type"]=="radio"||item["type"]=="checkbox"{let entry=CheckMenuItem::with_id(item["id"].as_str().unwrap_or(""),item["label"].as_str().unwrap_or(""),item["enabled"].as_bool().unwrap_or(true),item["checked"].as_bool().unwrap_or(false),None);let _=menu.append(&entry);}
        else {let entry=MenuItem::with_id(item["id"].as_str().unwrap_or(""),item["label"].as_str().unwrap_or(""),item["enabled"].as_bool().unwrap_or(true),None);let _=menu.append(&entry);}
    }
}
fn fill_submenu(menu:&Submenu, items:&[Value]) {
    for item in items {
        if item["type"]=="separator"{let _=menu.append(&PredefinedMenuItem::separator());}
        else if let Some(children)=item["submenu"].as_array(){let sub=Submenu::new(item["label"].as_str().unwrap_or(""),true);fill_submenu(&sub,children);let _=menu.append(&sub);}
        else if item["type"]=="radio"||item["type"]=="checkbox"{let entry=CheckMenuItem::with_id(item["id"].as_str().unwrap_or(""),item["label"].as_str().unwrap_or(""),item["enabled"].as_bool().unwrap_or(true),item["checked"].as_bool().unwrap_or(false),None);let _=menu.append(&entry);}
        else {let entry=MenuItem::with_id(item["id"].as_str().unwrap_or(""),item["label"].as_str().unwrap_or(""),item["enabled"].as_bool().unwrap_or(true),None);let _=menu.append(&entry);}
    }
}
fn make_webview(view:&mut View, context:&mut Option<wry::WebContext>, proxy:&EventLoopProxy<UserEvent>, id:u64, profile:&PathBuf) -> Result<(),String> {
    if context.is_none(){*context=Some(wry::WebContext::new(Some(profile.clone())));}
    let ipc_proxy=proxy.clone();let load_proxy=proxy.clone();
    let script=format!("{}\n(function(require){{ {} }})(window.__xiaoyeRequire);",include_str!("../../bridge/renderer.js"),view.preload);
    let allowed=view.url.split("/app/").next().unwrap_or("").to_string();
    let webview=wry::WebViewBuilder::new_with_web_context(context.as_mut().unwrap())
        .with_url(&view.url).with_transparent(true).with_background_color((0,0,0,0))
        .with_initialization_script(&script)
        .with_ipc_handler(move|request|{let _=ipc_proxy.send_event(UserEvent::Ipc(id,request.body().clone()));})
        .with_on_page_load_handler(move|event,_|{if matches!(event,wry::PageLoadEvent::Finished){let _=load_proxy.send_event(UserEvent::Loaded(id));}})
        .with_navigation_handler(move|url|url.starts_with(&allowed)||url.starts_with("data:text/html"))
        .with_new_window_req_handler(|_,_|wry::NewWindowResponse::Deny)
        .with_devtools(false)
        .build(&view.window).map_err(|e|e.to_string())?;
    unsafe{if let Ok(settings)=webview.webview().Settings(){let _=settings.SetAreDefaultContextMenusEnabled(false);}}
    view.webview=Some(webview);Ok(())
}
fn create_view(target:&EventLoopWindowTarget<UserEvent>,id:u64,options:&Value,icon:&Option<tao::window::Icon>)->View {
    let number=|key:&str,fallback:f64|options[key].as_f64().unwrap_or(fallback);
    let window=WindowBuilder::new().with_title(options["title"].as_str().unwrap_or("小叶便签"))
        .with_visible(false).with_decorations(options["frame"].as_bool().unwrap_or(true)).with_transparent(true)
        .with_always_on_top(options["alwaysOnTop"].as_bool().unwrap_or(false))
        .with_resizable(options["resizable"].as_bool().unwrap_or(true))
        .with_inner_size(LogicalSize::new(number("width",800.0),number("height",600.0)))
        .with_position(LogicalPosition::new(number("x",80.0),number("y",80.0)))
        .with_window_icon(icon.clone()).build(target).unwrap();
    let _=window.set_skip_taskbar(options["skipTaskbar"].as_bool().unwrap_or(false));
    window.set_undecorated_shadow(false);
    unsafe{let no_border:u32=0xfffffffe;let no_rounding:u32=1;DwmSetWindowAttribute(window.hwnd(),34,&no_border as *const _ as _,4);DwmSetWindowAttribute(window.hwnd(),33,&no_rounding as *const _ as _,4);}
    unsafe{SetWindowSubclass(window.hwnd(),native_events,1,id as usize);}
    let scale=window.scale_factor();unsafe{SetWindowPos(window.hwnd()as _,std::ptr::null_mut(),(number("x",80.0)*scale).round()as i32,(number("y",80.0)*scale).round()as i32,(number("width",800.0)*scale).round()as i32,(number("height",600.0)*scale).round()as i32,SWP_NOZORDER|SWP_NOACTIVATE);}
    let _=id;
    View{window,webview:None,url:String::new(),preload:String::new(),hidden_at:None,visible:options["show"].as_bool().unwrap_or(false)}
}
fn spawn_backend(root:&PathBuf,proxy:&EventLoopProxy<UserEvent>,production:bool, check_mode:bool) -> (Child,Sender) {
    let mut child=Command::new(root.join("bridge/node.exe")).arg("--max-old-space-size=96").arg(root.join("bridge/backend.cjs")).env("XIAOYE_HOST",std::env::current_exe().unwrap()).env("XIAOYE_PRODUCTION",if production{"1"}else{"0"}).env("XIAOYE_SELF_CHECK",if check_mode{"1"}else{"0"}).creation_flags(0x08000000).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(std::fs::File::create(root.join("validation/backend.log")).unwrap()).spawn().expect("启动本地数据服务");
    let input=Arc::new(Mutex::new(child.stdin.take().unwrap()));let out=child.stdout.take().unwrap();let proxy=proxy.clone();
    std::thread::spawn(move||{for line in std::io::BufReader::new(out).lines().map_while(Result::ok){if let Ok(value)=serde_json::from_str(&line){let _=proxy.send_event(UserEvent::Backend(value));}}let _=proxy.send_event(UserEvent::Backend(json!({"op":"backendStopped"})));});
    (child,input)
}
fn main(){
    if std::env::args().any(|a|a=="--native") {let result=match native_helper(){Ok(value)=>json!({"value":value}),Err(error)=>json!({"error":error})};println!("{result}");return;}
    let args:Vec<String>=std::env::args().collect();
    let check=args.windows(2).find(|a|a[0]=="--check").map(|a|std::fs::read_to_string(&a[1]).expect("验证脚本"));
    let check_production = check.is_some() && args.iter().any(|arg| arg == "--check-production");
    let production = (check.is_none() || check_production) && std::fs::read(root().join("production.json")).ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|config| config["production"].as_bool()).unwrap_or(false);
    if production { let _ = notifications::initialize_process(); }
    let review_visible=args.iter().any(|a|a=="--desktop-review");
    let root=root();
    std::fs::create_dir_all(root.join("validation")).expect("创建运行日志目录");
    let profile=root.join(if check.is_some(){"cache/WebView2-check"}else{"cache/WebView2"});std::fs::create_dir_all(&profile).unwrap();
    let name:Vec<u16>=if check.is_some(){"Local\\XiaoyeNotePublicCheck-check"}else if production{"Local\\XiaoyeNotePublic"}else{"Local\\XiaoyeNotePublicCheck"}.encode_utf16().chain(Some(0)).collect();
    let mut _mutex=unsafe{CreateMutexW(std::ptr::null(),0,name.as_ptr())};
    let control_path=root.join(if production{"validation/production-control.json"}else{"validation/control.json"});
    let mut existing=unsafe{GetLastError()}==ERROR_ALREADY_EXISTS;
    if existing&&args.iter().any(|a|a=="--wait-relaunch"){for _ in 0..50{unsafe{CloseHandle(_mutex);}_mutex=std::ptr::null_mut();std::thread::sleep(Duration::from_millis(100));_mutex=unsafe{CreateMutexW(std::ptr::null(),0,name.as_ptr())};existing=unsafe{GetLastError()}==ERROR_ALREADY_EXISTS;if !existing{break;}}}
    if existing{let op=if args.iter().any(|a|a=="--quit"){"quit"}else{"activate"};let _=std::fs::write(&control_path,json!({"op":op,"stamp":format!("{:?}",std::time::SystemTime::now())}).to_string());return;}
    let event_loop=EventLoopBuilder::<UserEvent>::with_user_event().build();let proxy=event_loop.create_proxy();
    let (mut child,output)=spawn_backend(&root,&proxy,production,check.is_some());
    let _=NATIVE_OUTPUT.set(output.clone());
    let mut control_modified=std::fs::metadata(&control_path).and_then(|m|m.modified()).ok();
    let primary=event_loop.primary_monitor();let primary_name=primary.as_ref().and_then(|m|m.name());
    let mut monitors:Vec<_>=event_loop.available_monitors().collect();monitors.sort_by_key(|m|m.name()!=primary_name);
    let displays:Vec<_>=monitors.into_iter().map(|monitor|{
        let scale=monitor.scale_factor();let pos=monitor.position().to_logical::<f64>(scale);let size=monitor.size().to_logical::<f64>(scale);
        let rect=json!({"x":pos.x,"y":pos.y,"width":size.width,"height":size.height});
        let physical=monitor.position();let mut info:MONITORINFO=unsafe{std::mem::zeroed()};info.cbSize=std::mem::size_of::<MONITORINFO>()as u32;
        let handle=unsafe{MonitorFromPoint(POINT{x:physical.x+1,y:physical.y+1},MONITOR_DEFAULTTONEAREST)};
        let work=if unsafe{GetMonitorInfoW(handle,&mut info)}!=0{let r=info.rcWork;json!({"x":r.left as f64/scale,"y":r.top as f64/scale,"width":(r.right-r.left)as f64/scale,"height":(r.bottom-r.top)as f64/scale})}else{rect.clone()};
        json!({"id":monitor.name(),"bounds":rect,"workArea":work,"scaleFactor":scale})
    }).collect();
    send(&output,json!({"op":"boot","displays":displays,"cursor":{"x":0,"y":0}}));
    let p=proxy.clone();MenuEvent::set_event_handler(Some(move|event|{let _=p.send_event(UserEvent::Menu(event));}));
    let p=proxy.clone();TrayIconEvent::set_event_handler(Some(move|event|{let _=p.send_event(UserEvent::Tray(event));}));
    let p=proxy.clone();GlobalHotKeyEvent::set_event_handler(Some(move|event|{let _=p.send_event(UserEvent::Hotkey(event));}));
    let p=proxy.clone();std::thread::spawn(move||loop{std::thread::sleep(Duration::from_millis(80));if p.send_event(UserEvent::Tick).is_err(){break;}});
    let hk=if check.is_none(){GlobalHotKeyManager::new().ok()}else{None};let mut hotkeys:HashMap<u32,String>=HashMap::new();
    let mut views:HashMap<u64,View>=HashMap::new();let mut context=None;let mut tray:Option<TrayIcon>=None;let mut popup:Option<Menu>=None;
    let icon=image::open(root.join("app/assets/icon.png")).ok().and_then(|i|{let i=i.to_rgba8();tao::window::Icon::from_rgba(i.as_raw().clone(),i.width(),i.height()).ok()});
    let mut checked=false;let mut check_due:Option<(u64,Instant)>=None;let mut last_cursor=None;let mut relaunch=false;
    let mut cycle_due:Option<(u64,Instant,String)>=None;let mut cycle_script:Option<(u64,String)>=None;
    let start=Instant::now();
    event_loop.run(move|event,target,flow|{
      *flow=ControlFlow::Wait;
      match event {
        Event::UserEvent(UserEvent::Backend(message))=>{
          let id=message["id"].as_u64().unwrap_or(0);let op=message["op"].as_str().unwrap_or("");
          match op {
            "create"=>{views.insert(id,create_view(target,id,&message["options"],&icon));}
            "load"=>{if let Some(view)=views.get_mut(&id){view.url=message["url"].as_str().unwrap_or("").into();view.preload=message["preload"].as_str().unwrap_or("").into();view.webview=None;match make_webview(view,&mut context,&proxy,id,&profile){Ok(())=>view.window.set_visible(view.visible&&(check.is_none()||review_visible)),Err(e)=>{let _=std::fs::write(root.join("validation/native-error.txt"),e);send(&output,json!({"op":"quit"}));}}}}
            "show"=>{if let Some(view)=views.get_mut(&id){view.hidden_at=None;view.visible=true;if view.webview.is_none(){if let Some(surface)=message["surface"].as_str(){if let Some((base,_))=view.url.split_once('?'){view.url=format!("{base}?mode={surface}");}}let _=make_webview(view,&mut context,&proxy,id,&profile);}if check.is_none()||review_visible{view.window.set_visible(true);view.window.set_minimized(false);view.window.set_focus();}}}
            "hide"=>{if let Some(view)=views.get_mut(&id){view.visible=false;view.window.set_visible(false);view.hidden_at=Some(Instant::now());}}
            "destroy"=>{views.remove(&id);}
            "bounds"=>{if let Some(view)=views.get(&id){let b=&message["bounds"];let current=bounds(&view.window);let scale=view.window.scale_factor();let width=b["width"].as_f64().unwrap_or(600.0);let height=b["height"].as_f64().unwrap_or(400.0);let same_size=(width-current["width"].as_f64().unwrap_or(0.0)).abs()<0.01&&(height-current["height"].as_f64().unwrap_or(0.0)).abs()<0.01;let flags=SWP_NOZORDER|SWP_NOACTIVATE|if same_size{SWP_NOSIZE}else{0};unsafe{SetWindowPos(view.window.hwnd()as _,std::ptr::null_mut(),(b["x"].as_f64().unwrap_or(0.0)*scale).round()as i32,(b["y"].as_f64().unwrap_or(0.0)*scale).round()as i32,(width*scale).round()as i32,(height*scale).round()as i32,flags);}}}
            "minimum"=>{MINIMUM_SIZES.lock().unwrap().insert(id as usize,(message["width"].as_f64().unwrap_or(1.0),message["height"].as_f64().unwrap_or(1.0)));}
            "resizable"=>{if let Some(view)=views.get(&id){view.window.set_resizable(message["value"].as_bool().unwrap_or(true));}}
            "taskbar"=>{if let Some(view)=views.get(&id){let _=view.window.set_skip_taskbar(message["value"].as_bool().unwrap_or(false));}}
            "topmost"=>{if let Some(view)=views.get(&id){view.window.set_always_on_top(message["value"].as_bool().unwrap_or(false));}}
            "opacity"=>{if let Some(view)=views.get(&id){let hwnd=view.window.hwnd() as _;let alpha=(message["value"].as_f64().unwrap_or(1.0).clamp(0.05,1.0)*255.0)as u8;unsafe{let style=GetWindowLongW(hwnd,GWL_EXSTYLE);SetWindowLongW(hwnd,GWL_EXSTYLE,style|WS_EX_LAYERED as i32);SetLayeredWindowAttributes(hwnd,0,alpha,LWA_ALPHA);}}}
            "focus" if check.is_none() || review_visible=>{if let Some(view)=views.get(&id){view.window.set_focus();}}
            "minimize"=>{if let Some(view)=views.get_mut(&id){view.window.set_minimized(true);}}
            "restore"=>{if let Some(view)=views.get(&id){view.window.set_minimized(false);}}
            "emit"|"resolve"=>{if let Some(webview)=views.get(&id).and_then(|v|v.webview.as_ref()){let script=if op=="resolve"{format!("window.__xiaoyeResolve({message})")}else{format!("window.__xiaoyeEmit({},{})",message["channel"],message["args"])};let _=webview.evaluate_script(&script);}}
            "eval"=>{if let Some(webview)=views.get(&id).and_then(|v|v.webview.as_ref()){let script=format!("(async()=>{{try{{const value=await eval({});window.ipc.postMessage(JSON.stringify({{type:'evalReply',requestId:{},value}}));}}catch(e){{window.ipc.postMessage(JSON.stringify({{type:'evalReply',requestId:{},error:e.message}}));}}}})()",message["script"],message["requestId"],message["requestId"]);let _=webview.evaluate_script(&script);}}
            "tray" if check.is_none() || review_visible => {
                let size = unsafe {
                    (GetSystemMetrics(SM_CXSMICON) as u32, GetSystemMetrics(SM_CYSMICON) as u32)
                };
                if let Ok(icon) = tray_icon::Icon::from_path(root.join("app/assets/icon.ico"), Some(size)) {
                    tray = TrayIconBuilder::new()
                        .with_tooltip(if production { "小叶便签 · 完整版" } else { "小叶便签 · 轻量隔离版" })
                        .with_icon(icon)
                        .with_menu_on_left_click(false)
                        .build()
                        .ok();
                }
            }
            "tooltip" => {
                if let Some(tray) = tray.as_ref() {
                    let _ = tray.set_tooltip(Some(if production { "小叶便签 · 完整版" } else { "小叶便签 · 轻量隔离版" }));
                }
            }
            "menu"=>{let menu=Menu::new();fill_menu(&menu,message["items"].as_array().unwrap_or(&vec![]));if let Some(tray)=tray.as_ref(){tray.set_menu(Some(Box::new(menu)));}}
            "popup"=>{let menu=Menu::new();fill_menu(&menu,message["items"].as_array().unwrap_or(&vec![]));if let Some(view)=views.get(&id){unsafe{menu.show_context_menu_for_hwnd(view.window.hwnd(),None);}}popup=Some(menu);}
            "hotkey"=>{if let (Some(manager),Some(key))=(&hk,message["key"].as_str()){if let Ok(hotkey)=key.replace("CommandOrControl","Control").parse::<global_hotkey::hotkey::HotKey>(){if manager.register(hotkey).is_ok(){hotkeys.insert(hotkey.id(),key.into());}}}}
            "unregisterHotkeys"=>{if let Some(manager)=&hk{for key in hotkeys.values(){if let Ok(key)=key.parse(){let _=manager.unregister(key);}}}hotkeys.clear();}
            "dialog"=>{let output=output.clone();std::thread::spawn(move||{let options=&message["options"];let mut dialog=rfd::FileDialog::new().set_title(options["title"].as_str().unwrap_or("选择文件"));if let Some(file)=options["defaultPath"].as_str(){dialog=dialog.set_file_name(file);}if let Some(filters)=options["filters"].as_array(){for filter in filters{let extensions:Vec<_>=filter["extensions"].as_array().unwrap().iter().filter_map(Value::as_str).collect();dialog=dialog.add_filter(filter["name"].as_str().unwrap_or("文件"),&extensions);}}let result=if message["kind"]=="save"{let file=dialog.save_file();json!({"canceled":file.is_none(),"filePath":file.map(|p|p.to_string_lossy().into_owned())})}else{let properties=options["properties"].as_array();let folder=properties.map(|p|p.contains(&json!("openDirectory"))).unwrap_or(false);let multi=properties.map(|p|p.contains(&json!("multiSelections"))).unwrap_or(false);let files=if folder{dialog.pick_folder().map(|p|vec![p])}else if multi{dialog.pick_files()}else{dialog.pick_file().map(|p|vec![p])};json!({"canceled":files.is_none(),"filePaths":files.unwrap_or_default().iter().map(|p|p.to_string_lossy().into_owned()).collect::<Vec<_>>()})};send(&output,json!({"op":"reply","requestId":message["requestId"],"value":result}));});}
            "open"=>{let value=message["value"].as_str().unwrap_or("");let wide:Vec<u16>=value.encode_utf16().chain(Some(0)).collect();unsafe{#[link(name="shell32")]unsafe extern "system"{fn ShellExecuteW(hwnd:isize,op:*const u16,file:*const u16,params:*const u16,dir:*const u16,show:i32)->isize;}let result=ShellExecuteW(0,std::ptr::null(),wide.as_ptr(),std::ptr::null(),std::ptr::null(),1);send(&output,json!({"op":"reply","requestId":message["requestId"],"value":if result>32{""}else{"无法打开"}}));}}
            "error" if check.is_none() || review_visible=>{rfd::MessageDialog::new().set_title(message["title"].as_str().unwrap_or("小叶便签")).set_description(message["message"].as_str().unwrap_or("")).show();}
            "backendError"=>{let _=std::fs::write(root.join("validation/backend-error.txt"),message.to_string());}
            "notify" => {
                let result = if production && check.is_none() {
                    let options = &message["options"];
                    notifications::send(options["title"].as_str().unwrap_or("小叶便签提醒"), options["body"].as_str().unwrap_or(""), options["silent"].as_bool().unwrap_or(false))
                } else {
                    Err("隔离模式已暂停系统通知".into())
                };
                let reply = match result {
                    Ok(()) => json!({"op":"reply", "requestId":message["requestId"], "value":{"shown":true}}),
                    Err(error) => json!({"op":"reply", "requestId":message["requestId"], "error":error}),
                };
                send(&output, reply);
            }
            "relaunch"=>{relaunch=true;}
            "exit"|"backendStopped"=>{let _=child.kill();if relaunch{let _=Command::new(std::env::current_exe().unwrap()).arg("--wait-relaunch").creation_flags(0x08000000).spawn();}*flow=ControlFlow::Exit;}
            _=>{}
          }
        }
        Event::UserEvent(UserEvent::Ipc(id,body))=>{if let Ok(mut message)=serde_json::from_str::<Value>(&body){match message["type"].as_str().unwrap_or(""){
          "ipc"=>{message["op"]=json!("ipc");message["id"]=json!(id);send(&output,message);}
          "evalReply"=>{message["op"]=json!("reply");send(&output,message);}
          "drag"=>{if let Some(view)=views.get(&id){let _=view.window.drag_window();}}
          "resize"=>{if let Some(view)=views.get(&id){use tao::window::ResizeDirection;let direction=match message["direction"].as_str().unwrap_or(""){"n"=>ResizeDirection::North,"s"=>ResizeDirection::South,"w"=>ResizeDirection::West,"e"=>ResizeDirection::East,"nw"=>ResizeDirection::NorthWest,"ne"=>ResizeDirection::NorthEast,"sw"=>ResizeDirection::SouthWest,_=>ResizeDirection::SouthEast};let _=view.window.drag_resize_window(direction);}}
          "contextMenu"=>{send(&output,json!({"op":"contextMenu","id":id}));}
          "close"=>{send(&output,json!({"op":"close","id":id}));}
          "rendererError"=>{let log=root.join("validation/renderer-errors.log");if let Ok(mut file)=std::fs::OpenOptions::new().create(true).append(true).open(log){let _=writeln!(file,"{message}");}}
          "releaseReady"=>{if let Some(view)=views.get_mut(&id){if !view.visible&&view.hidden_at.is_none(){view.webview=None;}}}
          "checkCycle" if check.is_some()=>{if let Some(script)=message["continuation"].as_str(){cycle_due=Some((id,Instant::now()+Duration::from_secs(6),script.into()));send(&output,json!({"op":"ipc","id":id,"requestId":999999,"channel":"window:close","args":[]}));}}
          "capture" if check.is_some()=>{if let (Some(webview),Some(name))=(views.get(&id).and_then(|v|v.webview.as_ref()),message["name"].as_str()){if name.chars().all(|c|c.is_ascii_alphanumeric()||c=='-'){let folder=root.join("validation/screenshots");let _=std::fs::create_dir_all(&folder);let file=folder.join(format!("{name}.png"));let capture_proxy=proxy.clone();let callback=webview2_com::CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move|status,data|{let success=status.is_ok()&&serde_json::from_str::<Value>(&data).ok().and_then(|v|v["data"].as_str().map(str::to_string)).and_then(|bytes|B64.decode(bytes).ok()).map(|bytes|std::fs::write(file,bytes).is_ok()).unwrap_or(false);let _=capture_proxy.send_event(UserEvent::Captured(id,success));Ok(())}));unsafe{let _=webview.webview().CallDevToolsProtocolMethod(windows::core::w!("Page.captureScreenshot"),windows::core::w!("{\"format\":\"png\",\"captureBeyondViewport\":false}"),&callback);}}}}
          "reviewReady" if check.is_some()=>{if review_visible{if let Some(view)=views.get_mut(&id){let _=view.window.set_skip_taskbar(false);view.visible=true;view.window.set_visible(true);view.window.set_focus();}}let _=std::fs::write(root.join("validation/desktop-review-ready.json"),message["value"].to_string());}
          "checkResult"=>{let _=std::fs::write(root.join("validation/check-result.json"),message["value"].to_string());send(&output,json!({"op":"quit"}));}
          _=>{}
        }}}
        Event::UserEvent(UserEvent::Loaded(id))=>{send(&output,json!({"op":"loaded","id":id}));if check.is_some()&&!checked{check_due=Some((id,Instant::now()+Duration::from_secs(2)));}if cycle_script.as_ref().map(|(window,_)|*window==id).unwrap_or(false){if let Some((_,script))=cycle_script.take(){if let Some(webview)=views.get(&id).and_then(|v|v.webview.as_ref()){let _=webview.evaluate_script(&script);}}}}
        Event::UserEvent(UserEvent::Captured(id,success))=>{if let Some(webview)=views.get(&id).and_then(|v|v.webview.as_ref()){let _=webview.evaluate_script(&format!("window.__captureDone&&window.__captureDone({success})"));}}
        Event::UserEvent(UserEvent::Tick)=>{
          let modified=std::fs::metadata(&control_path).and_then(|m|m.modified()).ok();if modified!=control_modified{control_modified=modified;if let Ok(bytes)=std::fs::read(&control_path){if let Ok(command)=serde_json::from_slice::<Value>(&bytes){if command["op"]=="activate"||command["op"]=="quit"||command["op"]=="audit"{send(&output,command);}}}}
          let mut point=POINT{x:0,y:0};unsafe{GetCursorPos(&mut point);}
          if last_cursor!=Some((point.x,point.y)){last_cursor=Some((point.x,point.y));let scale=primary.as_ref().map(|m|m.scale_factor()).unwrap_or(1.0);send(&output,json!({"op":"cursor","point":{"x":point.x as f64/scale,"y":point.y as f64/scale}}));}
          for view in views.values_mut(){if view.hidden_at.map(|time|time.elapsed()>Duration::from_secs(3)).unwrap_or(false){view.hidden_at=None;if let Some(webview)=view.webview.as_ref(){let _=webview.evaluate_script("(async()=>{const ready=window.__xiaoyePrepareSleep?await window.__xiaoyePrepareSleep():![...document.querySelectorAll('form,input,textarea,select,[contenteditable=true],[role=dialog]')].some(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');if(ready)window.ipc.postMessage(JSON.stringify({type:'releaseReady'}));})()");}}}
          if views.values().all(|view|view.webview.is_none()){context=None;}
          if cycle_due.as_ref().map(|(_,time,_)|Instant::now()>*time).unwrap_or(false){if let Some((id,_,script))=cycle_due.take(){let released=views.get(&id).map(|v|v.webview.is_none()).unwrap_or(false);let continuation=format!("window.__cycleReleased={released};{script}");if released{cycle_script=Some((id,continuation));}else if let Some(webview)=views.get(&id).and_then(|v|v.webview.as_ref()){let _=webview.evaluate_script(&continuation);}send(&output,json!({"op":"activate"}));}}
          if let Some((id,time))=check_due{if Instant::now()>time&&!checked{if let Some(webview)=views.get(&id).and_then(|v|v.webview.as_ref()){checked=true;let _=webview.evaluate_script(check.as_ref().unwrap());}}}
          if check.is_some()&&start.elapsed()>Duration::from_secs(90){let _=std::fs::write(root.join("validation/check-timeout.txt"),"90 秒未收到检查结果");send(&output,json!({"op":"quit"}));}
        }
        Event::UserEvent(UserEvent::Menu(event))=>{send(&output,json!({"op":"menuClick","id":event.id.0}));}
        Event::UserEvent(UserEvent::Tray(TrayIconEvent::Click{button:MouseButton::Left,button_state:MouseButtonState::Up,..}))=>{send(&output,json!({"op":"trayClick"}));}
        Event::UserEvent(UserEvent::Hotkey(event))=>{if event.state==HotKeyState::Pressed{if let Some(key)=hotkeys.get(&event.id){send(&output,json!({"op":"hotkey","key":key}));}}}
        Event::WindowEvent{window_id,event,..}=>{if let Some((&id,view))=views.iter().find(|(_,v)|v.window.id()==window_id){match event{
          WindowEvent::CloseRequested=>send(&output,json!({"op":"close","id":id})),
          WindowEvent::Focused(value)=>send(&output,json!({"op":"focused","id":id,"value":value})),
          WindowEvent::Moved(_)|WindowEvent::Resized(_)=>send(&output,json!({"op":"boundsChanged","id":id,"bounds":bounds(&view.window)})),
          _=>{}
        }}}
        _=>{}
      }
      let _=&popup;
    });
}
