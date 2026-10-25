use crate::win::*;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    mem::zeroed,
    path::PathBuf,
    process::Command,
    ptr::{null, null_mut},
};
use windows_sys::Win32::Security::Authentication::Identity::*;
use windows_sys::Win32::System::WindowsProgramming::{DRIVE_FIXED, DRIVE_REMOVABLE};
use windows_sys::Win32::{
    NetworkManagement::NetManagement::*,
    Security::{Credentials::*, *},
    Storage::FileSystem::*,
};

pub const ACCOUNTS: [&str; 2] = ["sfagents_sandbox", "sfagents_sandbox_net"];
pub const NULL_DEVICE: &str = "\\\\.\\NUL";
pub const RUNTIME_DEVICES: [&str; 2] = [NULL_DEVICE, "\\\\.\\pipe"];
// Grants read/write access only to the null and named-pipe devices, never to
// filesystem trees. Individual named pipes still enforce their own DACLs.
pub const RUNTIME_SID: &str = "S-1-5-21-3325558138-2469722210-2860911687-9000";
const COMMENT: &str = "SF Agents sandbox v1 (managed; remove with sfagents-sandbox uninstall)";
const TARGETS: [&str; 2] = ["sfagents/sandbox", "sfagents/sandbox-net"];
// The only readable ProgramData subtree. Keep tool exceptions in one place.
pub const PROGRAM_DATA_ALLOW: [&str; 1] = ["C:\\ProgramData\\Git"];
// Metadata and traversal let runtimes resolve granted paths without allowing
// directory listing or reading any personal file's contents.
const HIDDEN: u32 =
    FILE_ALL_ACCESS & !(FILE_READ_ATTRIBUTES | FILE_TRAVERSE | READ_CONTROL | SYNCHRONIZE);

#[derive(Serialize, Deserialize)]
pub struct State {
    pub version: u32,
    pub owner: String,
    pub sids: Vec<String>,
    pub aces: Vec<Ace>,
    pub ready: bool,
}
pub fn state_dir() -> Result<PathBuf> {
    let dir = std::env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA is missing")?;
    Ok(PathBuf::from(dir).join("SF Agents").join("sandbox"))
}
fn state_file() -> Result<PathBuf> {
    Ok(state_dir()?.join("setup.json"))
}
pub fn read_state() -> Result<State> {
    let mut state: State = serde_json::from_slice(
        &fs::read(state_file()?).map_err(|_| "sandbox is not set up; run sandbox:setup once")?,
    )
    .map_err(|e| format!("invalid setup state: {e}"))?;
    normalize_device_entries(&mut state);
    Ok(state)
}
fn normalize_device_entries(state: &mut State) {
    // An early setup attempt journaled the NPFS directory spelling, which
    // cannot expose a security descriptor through GetSecurityInfo. Revoke the
    // actual pipe-device SID entry on uninstall, including after a partial setup.
    for ace in &mut state.aces {
        if ace.path == "\\\\.\\pipe\\" {
            ace.path = "\\\\.\\pipe".into();
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    state.aces.retain(|a| {
        seen.insert((
            a.path.to_lowercase(),
            a.sid.clone(),
            a.mode.clone(),
            a.mask,
            a.inherit,
        ))
    });
}
fn save(s: &State) -> Result<()> {
    let file = state_file()?;
    let tmp = file.with_extension("tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(s).unwrap()).map_err(|e| e.to_string())?;
    // Windows rename cannot replace an existing file through std::fs.
    unsafe {
        check(
            MoveFileExW(
                wide(tmp.to_str().unwrap()).as_ptr(),
                wide(file.to_str().unwrap()).as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            ),
            "save setup journal",
        )
    }
}
pub fn powershell(script: &str) -> Result<String> {
    // No password or other credential is ever sent to PowerShell or argv.
    let exe = format!(
        "{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        std::env::var("SystemRoot").unwrap_or("C:\\Windows".into())
    );
    use std::os::windows::process::CommandExt;
    let out = Command::new(exe)
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(0x08000000)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "Windows setup/check failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
fn admin() -> Result<()> {
    if !elevated()? {
        Err("this command needs an administrator terminal; run/probe never elevate".into())
    } else {
        Ok(())
    }
}

pub struct Password(pub Vec<u16>);
impl Drop for Password {
    fn drop(&mut self) {
        for x in &mut self.0 {
            unsafe {
                std::ptr::write_volatile(x, 0);
            }
        }
    }
}
pub fn password(index: usize) -> Result<Password> {
    let mut cred = null_mut();
    unsafe {
        check(
            CredReadW(
                wide(TARGETS[index]).as_ptr(),
                CRED_TYPE_GENERIC,
                0,
                &mut cred,
            ),
            "read sandbox credential (run setup as this user)",
        )?;
        let c = &*cred;
        if c.CredentialBlobSize % 2 != 0 {
            CredFree(cred.cast());
            return Err("invalid sandbox credential".into());
        }
        let mut bytes = std::slice::from_raw_parts(
            c.CredentialBlob as *const u16,
            c.CredentialBlobSize as usize / 2,
        )
        .to_vec();
        bytes.push(0);
        CredFree(cred.cast());
        Ok(Password(bytes))
    }
}
fn create_account(index: usize, state: &mut State) -> Result<()> {
    let name = wide(ACCOUNTS[index]);
    let comment = wide(COMMENT);
    let password = Password(wide(&format!("Sf!{}aZ9", random()?)));
    unsafe {
        let mut buf = null_mut();
        let found = NetUserGetInfo(null(), name.as_ptr(), 1, &mut buf);
        if found == 0 {
            let info = &*(buf as *const USER_INFO_1);
            let managed = from_wide(info.usri1_comment) == COMMENT;
            NetApiBufferFree(buf.cast());
            if !managed {
                return Err(format!(
                    "{} already exists and is not managed by SF Agents",
                    ACCOUNTS[index]
                ));
            }
            let info = USER_INFO_1003 {
                usri1003_password: password.0.as_ptr() as *mut u16,
            };
            status(
                NetUserSetInfo(
                    null(),
                    name.as_ptr(),
                    1003,
                    (&info as *const USER_INFO_1003).cast(),
                    null_mut(),
                ),
                "refresh sandbox password",
            )?;
        } else if found == NERR_UserNotFound {
            let mut info: USER_INFO_1 = zeroed();
            info.usri1_name = name.as_ptr() as *mut u16;
            info.usri1_password = password.0.as_ptr() as *mut u16;
            info.usri1_priv = USER_PRIV_USER;
            info.usri1_comment = comment.as_ptr() as *mut u16;
            info.usri1_flags =
                UF_SCRIPT | UF_NORMAL_ACCOUNT | UF_DONT_EXPIRE_PASSWD | UF_PASSWD_CANT_CHANGE;
            status(
                NetUserAdd(null(), 1, (&info as *const USER_INFO_1).cast(), null_mut()),
                "create sandbox standard user",
            )?;
        } else {
            status(found, "inspect sandbox account")?;
        }
        let sid = sid_text(lookup(ACCOUNTS[index])?.ptr())?;
        if state.sids.len() <= index {
            state.sids.push(sid);
        } else if state.sids[index] != sid {
            return Err("sandbox account SID changed; uninstall before setup".into());
        }
        save(state)?;
        let mut cred: CREDENTIALW = zeroed();
        cred.Type = CRED_TYPE_GENERIC;
        // Keep all backing buffers alive through CredWriteW.
        let target = wide(TARGETS[index]);
        cred.TargetName = target.as_ptr() as *mut u16;
        cred.UserName = name.as_ptr() as *mut u16;
        cred.CredentialBlob = password.0.as_ptr() as *mut u8;
        cred.CredentialBlobSize = ((password.0.len() - 1) * 2) as u32;
        cred.Persist = CRED_PERSIST_LOCAL_MACHINE;
        check(
            CredWriteW(&cred, 0),
            "store sandbox password in Credential Manager",
        )?;
    }
    Ok(())
}

fn logon_rights(sid: &str, remove: bool) -> Result<()> {
    let sid = Sid::parse(sid)?;
    let mut policy: LSA_HANDLE = 0;
    let mut attrs: LSA_OBJECT_ATTRIBUTES = unsafe { zeroed() };
    attrs.Length = std::mem::size_of::<LSA_OBJECT_ATTRIBUTES>() as u32;
    unsafe {
        status(
            LsaNtStatusToWinError(LsaOpenPolicy(
                null(),
                &attrs,
                (POLICY_LOOKUP_NAMES | POLICY_CREATE_ACCOUNT) as u32,
                &mut policy,
            )),
            "open local logon policy",
        )?;
        let result = if remove {
            let code =
                LsaNtStatusToWinError(LsaRemoveAccountRights(policy, sid.ptr(), 1, null(), 0));
            if code == 2 {
                Ok(())
            } else {
                status(code, "remove sandbox logon rights")
            }
        } else {
            let names: Vec<_> = [
                "SeInteractiveLogonRight",
                "SeIncreaseQuotaPrivilege",
                "SeDenyRemoteInteractiveLogonRight",
                "SeDenyNetworkLogonRight",
                "SeDenyBatchLogonRight",
                "SeDenyServiceLogonRight",
            ]
            .iter()
            .map(|s| wide(s))
            .collect();
            let rights: Vec<_> = names
                .iter()
                .map(|n| LSA_UNICODE_STRING {
                    Length: ((n.len() - 1) * 2) as u16,
                    MaximumLength: (n.len() * 2) as u16,
                    Buffer: n.as_ptr() as *mut u16,
                })
                .collect();
            status(
                LsaNtStatusToWinError(LsaAddAccountRights(
                    policy,
                    sid.ptr(),
                    rights.as_ptr(),
                    rights.len() as u32,
                )),
                "grant dedicated-account logon rights",
            )
        };
        LsaClose(policy);
        result
    }
}

pub fn install() -> Result<()> {
    admin()?;
    let _lock = Lock::acquire()?;
    fs::create_dir_all(state_dir()?).map_err(|e| e.to_string())?;
    let mut state = if state_file()?.exists() {
        read_state()?
    } else {
        State {
            version: 1,
            owner: current_sid()?,
            sids: vec![],
            aces: vec![],
            ready: false,
        }
    };
    if state.owner != current_sid()? {
        return Err("setup belongs to a different Windows user".into());
    }
    state.ready = false;
    save(&state)?;
    for i in 0..2 {
        create_account(i, &mut state)?;
        logon_rights(&state.sids[i], false)?;
        // CLR and Windows known-folder APIs require a registered profile even
        // though command HOME/TEMP are redirected to a disposable directory.
        // Create it here as the administrator, before hiding the Default template.
        let mut profile = vec![0u16; 260]; // CreateProfile's RPC contract is MAX_PATH.
        let result = unsafe {
            windows_sys::Win32::UI::Shell::CreateProfile(
                wide(&state.sids[i]).as_ptr(),
                wide(ACCOUNTS[i]).as_ptr(),
                profile.as_mut_ptr(),
                profile.len() as u32,
            )
        };
        if result < 0 && result as u32 != 0x800700b7 {
            return Err(format!(
                "create managed sandbox profile: HRESULT {:08x}",
                result as u32
            ));
        }
        powershell(&format!("$ErrorActionPreference='Stop'; $g=Get-LocalGroup -SID 'S-1-5-32-545'; if (-not (Get-LocalGroupMember -Group $g | Where-Object {{ $_.SID -eq '{}' }})) {{ Add-LocalGroupMember -Group $g -Member '{}' }}", state.sids[i], ACCOUNTS[i]))?;
    }
    let offline = &state.sids[0];
    crate::network::install(offline)?;
    powershell(&format!("$ErrorActionPreference='Stop'; Get-NetFirewallRule -Name 'SF-Agents-Sandbox-Offline-*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule; foreach($d in @('Inbound','Outbound')) {{ New-NetFirewallRule -Name ('SF-Agents-Sandbox-Offline-'+$d) -DisplayName ('SF Agents sandbox offline '+$d) -Direction $d -Action Block -Profile Any -Enabled True -LocalUser 'D:(A;;CC;;;{offline})' | Out-Null }}"))?;
    let paths = hidden_paths()?;
    let mut batches: Vec<Vec<Ace>> = paths
        .iter()
        .map(|(p, mask, inherit)| {
            state
                .sids
                .iter()
                .map(|sid| Ace {
                    path: p.clone(),
                    sid: sid.clone(),
                    mode: "deny".into(),
                    mask: *mask,
                    inherit: *inherit,
                })
                .collect()
        })
        .collect();
    for device in RUNTIME_DEVICES {
        batches.push(vec![Ace {
            path: device.into(),
            sid: RUNTIME_SID.into(),
            mode: "allow".into(),
            mask: FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            inherit: false,
        }]);
    }
    for p in PROGRAM_DATA_ALLOW {
        if PathBuf::from(p).exists() {
            batches.push(
                state
                    .sids
                    .iter()
                    .map(|sid| Ace {
                        path: p.into(),
                        sid: sid.clone(),
                        mode: "allow".into(),
                        mask: READ,
                        inherit: true,
                    })
                    .collect(),
            );
        }
    }
    for batch in batches {
        let mut batch = batch;
        if batch[0].mode == "deny" && batch[0].mask == HIDDEN {
            batch.extend(
                state
                    .sids
                    .iter()
                    .map(|sid| Ace {
                        path: batch[0].path.clone(),
                        sid: sid.clone(),
                        mode: "allow".into(),
                        mask: FILE_READ_ATTRIBUTES | FILE_TRAVERSE | READ_CONTROL | SYNCHRONIZE,
                        inherit: true,
                    })
                    .collect::<Vec<_>>(),
            );
        }
        let changed = batch.iter().any(|ace| {
            state.aces.iter().any(|old| {
                old.path.eq_ignore_ascii_case(&ace.path)
                    && old.sid == ace.sid
                    && old.mode == ace.mode
                    && (old.mask != ace.mask || old.mode != ace.mode || old.inherit != ace.inherit)
            })
        });
        for ace in &batch {
            if let Some(old) = state.aces.iter_mut().find(|a| {
                a.path.eq_ignore_ascii_case(&ace.path) && a.sid == ace.sid && a.mode == ace.mode
            }) {
                *old = ace.clone();
            } else {
                state.aces.push(ace.clone());
            }
        }
        save(&state)?;
        if changed {
            acl_batch(&batch, true)?;
        }
        if batch
            .iter()
            .map(has_ace)
            .collect::<Result<Vec<_>>>()?
            .iter()
            .all(|present| *present)
        {
            continue;
        }
        println!("Protecting {}", batch[0].path);
        acl_batch(&batch, false)?;
    }
    state.ready = true;
    save(&state)?;
    println!("Windows sandbox setup complete. Undo: sfagents-sandbox uninstall");
    Ok(())
}

fn hidden_paths() -> Result<Vec<(String, u32, bool)>> {
    let mut paths = vec![
        ("C:\\".into(), FILE_LIST_DIRECTORY, false),
        ("C:\\Users".into(), FILE_LIST_DIRECTORY, false),
        ("C:\\ProgramData".into(), HIDDEN, true),
    ];
    for entry in fs::read_dir("C:\\Users").map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if ACCOUNTS
            .iter()
            .any(|a| entry.file_name().to_string_lossy().eq_ignore_ascii_case(a))
        {
            continue;
        }
        if entry.file_type().map_err(|e| e.to_string())?.is_symlink() {
            continue;
        }
        paths.push((entry.path().to_string_lossy().into(), HIDDEN, true));
    }
    for entry in fs::read_dir("C:\\").map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if [
            "windows",
            "program files",
            "program files (x86)",
            "users",
            "programdata",
        ]
        .contains(&name.as_str())
        {
            continue;
        }
        // Existing system-protected pagefiles/volume metadata are already inaccessible.
        if name.starts_with('$')
            || [
                "pagefile.sys",
                "swapfile.sys",
                "hiberfil.sys",
                "system volume information",
                "recovery",
                "config.msi",
                "dumpstack.log.tmp",
            ]
            .contains(&name.as_str())
        {
            continue;
        }
        if entry.file_type().map_err(|e| e.to_string())?.is_symlink() {
            continue;
        }
        paths.push((entry.path().to_string_lossy().into(), HIDDEN, true));
    }
    for drive in b'A'..=b'Z' {
        if drive == b'C' {
            continue;
        }
        let root = format!("{}:\\", drive as char);
        let kind = unsafe { GetDriveTypeW(wide(&root).as_ptr()) };
        if kind == DRIVE_FIXED || kind == DRIVE_REMOVABLE {
            paths.push((root, HIDDEN, true));
        }
    }
    Ok(paths)
}

/// Newly attached drives or newly created profile/root folders need the same
/// setup protection. Fail closed until setup is refreshed instead of silently
/// exposing a folder created after installation.
pub fn check_coverage(state: &State) -> Result<()> {
    for (p, mask, _) in hidden_paths()? {
        for sid in &state.sids {
            if !state.aces.iter().any(|a| {
                a.path.eq_ignore_ascii_case(&p)
                    && &a.sid == sid
                    && a.mode == "deny"
                    && a.mask & mask == mask
            }) {
                return Err(format!("a new drive or personal folder needs sandbox setup protection: {p}; run sandbox:setup again"));
            }
        }
    }
    // Device objects can be recreated across boots. Fail closed if that
    // runtime-only grant needs refreshing; profile DACLs may be unreadable
    // from the unelevated host and are tracked by the setup journal instead.
    for device in RUNTIME_DEVICES {
        let grant = state
            .aces
            .iter()
            .find(|a| a.path == device && a.sid == RUNTIME_SID)
            .ok_or("runtime device permissions are not installed; refresh sandbox:setup")?;
        if !has_ace(grant)? {
            return Err(format!(
                "runtime device permission needs refreshing on {device}; run sandbox:setup"
            ));
        }
    }
    Ok(())
}

pub fn probe() -> Result<()> {
    let state = read_state()?;
    if state.version != 1 || !state.ready || state.owner != current_sid()? || state.sids.len() != 2
    {
        return Err("sandbox setup is incomplete or belongs to another user".into());
    }
    check_coverage(&state)?;
    crate::network::probe(&state.sids[0])?;
    for i in 0..2 {
        if sid_text(lookup(ACCOUNTS[i])?.ptr())? != state.sids[i] {
            return Err("sandbox account changed; run setup".into());
        }
        let pass = password(i)?;
        let mut token = null_mut();
        unsafe {
            check(
                LogonUserW(
                    wide(ACCOUNTS[i]).as_ptr(),
                    wide(".").as_ptr(),
                    pass.0.as_ptr(),
                    LOGON32_LOGON_INTERACTIVE,
                    LOGON32_PROVIDER_DEFAULT,
                    &mut token,
                ),
                "sandbox logon (check 'Log on locally' group policy)",
            )?;
        }
        let _token = Handle::new(token, "sandbox logon")?;
    }
    powershell(&format!("$ErrorActionPreference='Stop'; if (@(Get-NetFirewallProfile | Where-Object {{ -not $_.Enabled }}).Count) {{ throw 'Windows Firewall must be enabled on every profile' }}; foreach($d in @('Inbound','Outbound')) {{ $r=Get-NetFirewallRule -PolicyStore ActiveStore -Name ('SF-Agents-Sandbox-Offline-'+$d); if($r.Enabled -ne 'True' -or $r.Action -ne 'Block' -or $r.Direction -ne $d) {{ throw 'Offline firewall rule is missing or disabled' }}; $u=($r | Get-NetFirewallSecurityFilter).LocalUser; if($u -notlike '*{}*') {{ throw 'Offline firewall rule targets another account' }} }}", state.sids[0]))?;
    Ok(())
}

pub fn uninstall() -> Result<()> {
    admin()?;
    let _lock = Lock::acquire()?;
    if !state_file()?.exists() {
        println!("No sandbox installation for this user.");
        return Ok(());
    }
    let mut state = read_state()?;
    crate::runner::recover_locked()?;
    state.ready = false;
    save(&state)?;
    let mut failures = vec![];
    let mut batches = std::collections::BTreeMap::<String, Vec<Ace>>::new();
    for ace in state.aces.iter().rev() {
        batches
            .entry(ace.path.to_lowercase())
            .or_default()
            .push(ace.clone());
    }
    for batch in batches.into_values() {
        if RUNTIME_DEVICES.contains(&batch[0].path.as_str())
            || PathBuf::from(&batch[0].path).exists()
        {
            println!("Removing sandbox permissions from {}", batch[0].path);
            if let Err(e) = acl_batch(&batch, true) {
                failures.push(e);
                continue;
            }
            let verified = batch.iter().try_for_each(|a| {
                let mut any = a.clone();
                any.mode = "any".into();
                any.mask = 0;
                any.inherit = false;
                if has_ace(&any)? {
                    Err(format!("managed ACL entry remains on {}", a.path))
                } else {
                    Ok(())
                }
            });
            if let Err(e) = verified {
                failures.push(e);
                continue;
            }
        }
        // A failed/partially propagated path stays journaled. Successful paths
        // need not propagate their completed removals again on a retry.
        state
            .aces
            .retain(|a| !a.path.eq_ignore_ascii_case(&batch[0].path));
        save(&state)?;
    }
    if !failures.is_empty() {
        return Err(format!(
            "uninstall retained its journal; fix permissions and retry: {}",
            failures.join("; ")
        ));
    }
    powershell("$ErrorActionPreference='Stop'; Get-NetFirewallRule -Name 'SF-Agents-Sandbox-Offline-*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule")?;
    crate::network::uninstall()?;
    for i in 0..state.sids.len() {
        let mut info = null_mut();
        let found = unsafe { NetUserGetInfo(null(), wide(ACCOUNTS[i]).as_ptr(), 1, &mut info) };
        if found == 0 {
            unsafe {
                NetApiBufferFree(info.cast());
            }
            if sid_text(lookup(ACCOUNTS[i])?.ptr())? != state.sids[i] {
                return Err("refusing to delete a replacement account with a different SID".into());
            }
        } else if found != NERR_UserNotFound {
            status(found, "inspect account during uninstall")?;
        }
        // DeleteProfile removes only the profile associated with this managed SID.
        powershell(&format!("$ErrorActionPreference='Stop'; Get-CimInstance Win32_UserProfile | Where-Object {{ $_.SID -eq '{}' }} | Remove-CimInstance", state.sids[i]))?;
        logon_rights(&state.sids[i], true)?;
        unsafe {
            if found == 0 {
                status(
                    NetUserDel(null(), wide(ACCOUNTS[i]).as_ptr()),
                    "delete managed sandbox user",
                )?;
            }
            if CredDeleteW(wide(TARGETS[i]).as_ptr(), CRED_TYPE_GENERIC, 0) == 0
                && windows_sys::Win32::Foundation::GetLastError()
                    != windows_sys::Win32::Foundation::ERROR_NOT_FOUND
            {
                return Err(last("delete sandbox credential"));
            }
        }
    }
    fs::remove_file(state_file()?).map_err(|e| e.to_string())?;
    println!("Sandbox accounts, credentials, firewall rules and managed ACL entries removed.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_setup_pipe_alias_is_revoked_as_the_actual_device() {
        let entry = |path: &str| Ace {
            path: path.into(),
            sid: RUNTIME_SID.into(),
            mode: "allow".into(),
            mask: FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            inherit: false,
        };
        let mut state = State {
            version: 1,
            owner: String::new(),
            sids: vec![],
            aces: vec![
                entry("\\\\.\\pipe\\"),
                entry("\\\\.\\pipe"),
                entry(NULL_DEVICE),
            ],
            ready: false,
        };
        normalize_device_entries(&mut state);
        assert_eq!(state.aces.len(), 2);
        assert_eq!(state.aces[0].path, "\\\\.\\pipe");
        assert_eq!(state.aces[1].path, NULL_DEVICE);
    }
}
