use windows::{core::{HSTRING, Interface, PCWSTR, GUID}, Data::Xml::Dom::XmlDocument, UI::Notifications::{ToastNotification, ToastNotificationManager}};
use windows::Win32::{Foundation::PROPERTYKEY, System::{Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER, StructuredStorage::{PROPVARIANT, PropVariantChangeType, PVCHF_DEFAULT}}, Variant::VT_LPWSTR}, UI::Shell::{IShellLinkW, ShellLink, PropertiesSystem::IPropertyStore}};
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

const APP_ID: &str = "com.xiaoye.note.public";

pub fn initialize_process() -> Result<(), String> {
    unsafe { windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(APP_ID)) }.map_err(|error| error.to_string())
}

pub fn register() -> Result<(), String> {
    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = current_user.create_subkey(format!("Software\\Classes\\AppUserModelId\\{APP_ID}")).map_err(|error| error.to_string())?;
    key.set_value("DisplayName", &"小叶便签").map_err(|error| error.to_string())?;
    let icon = std::env::current_exe().map_err(|error| error.to_string())?.parent().unwrap().join("app/assets/icon.ico");
    key.set_value("IconUri", &icon.to_string_lossy().as_ref()).map_err(|error| error.to_string())?;
    let shortcut = std::path::PathBuf::from(std::env::var_os("APPDATA").ok_or("无法读取用户目录")?)
        .join("Microsoft/Windows/Start Menu/Programs/小叶便签.lnk");
    std::fs::create_dir_all(shortcut.parent().unwrap()).map_err(|error| error.to_string())?;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let executable_wide: Vec<u16> = executable.to_string_lossy().encode_utf16().chain(Some(0)).collect();
    let shortcut_wide: Vec<u16> = shortcut.to_string_lossy().encode_utf16().chain(Some(0)).collect();
    let result: windows::core::Result<()> = unsafe {
        (|| {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.SetPath(PCWSTR(executable_wide.as_ptr()))?;
            let store: IPropertyStore = link.cast()?;
            let app_id_key = PROPERTYKEY { fmtid: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3), pid: 5 };
            let app_id = PROPVARIANT::from(APP_ID);
            let mut value = PROPVARIANT::default();
            PropVariantChangeType(&mut value, &app_id, PVCHF_DEFAULT, VT_LPWSTR)?;
            store.SetValue(&app_id_key, &value)?;
            store.Commit()?;
            let file: IPersistFile = link.cast()?;
            file.Save(PCWSTR(shortcut_wide.as_ptr()), true)
        })()
    };
    result.map_err(|error| error.to_string())?;
    Ok(())
}

fn xml_text(value: &str) -> String {
    value.chars().filter(|character| *character >= ' ' || matches!(character, '\n' | '\r' | '\t')).collect::<String>()
        .replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

pub fn send(title: &str, body: &str, silent: bool) -> Result<(), String> {
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID)).map_err(|error| format!("通知通道初始化失败，{error}"))?;
    let audio = if silent { "<audio silent=\"true\"/>" } else { "<audio src=\"ms-winsoundevent:Notification.Default\"/>" };
    let xml = format!("<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual>{audio}</toast>", xml_text(title), xml_text(body));
    let document = XmlDocument::new().map_err(|error| error.to_string())?;
    document.LoadXml(&HSTRING::from(xml)).map_err(|error| error.to_string())?;
    let notification = ToastNotification::CreateToastNotification(&document).map_err(|error| error.to_string())?;
    notifier.Show(&notification).map_err(|error| format!("系统未接受通知，{error}"))
}

pub fn history_count() -> Result<u32, String> {
    ToastNotificationManager::History()
        .and_then(|history| history.GetHistoryWithId(&HSTRING::from(APP_ID)))
        .and_then(|items| items.Size())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn notification_text_is_safe_xml() {
        assert_eq!(super::xml_text("待办 <标题> & \"正文\"\n\0"), "待办 &lt;标题&gt; &amp; &quot;正文&quot;\n");
    }
}
