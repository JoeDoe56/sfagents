use crate::{model::*, setup, win::*};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    mem::{size_of, zeroed},
    path::{Path, PathBuf},
    ptr::{null, null_mut},
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::*;
use windows_sys::Win32::System::SystemServices::SE_GROUP_LOGON_ID;
use windows_sys::Win32::UI::WindowsAndMessaging::WINSTA_ALL_ACCESS;
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::{Console::*, Environment::*, JobObjects::*, StationsAndDesktops::*, Threading::*},
};

#[derive(Serialize, Deserialize)]
struct Journal {
    aces: Vec<Ace>,
    temp: String,
}
fn journal_file() -> Result<PathBuf> {
    Ok(setup::state_dir()?.join("run.json"))
}
fn write_journal(j: &Journal) -> Result<()> {
    let p = journal_file()?;
    let tmp = p.with_extension("tmp");
    fs::write(&tmp, serde_json::to_vec(j).unwrap()).map_err(|e| e.to_string())?;
    unsafe {
        check(
            MoveFileExW(
                wide(tmp.to_str().unwrap()).as_ptr(),
                wide(p.to_str().unwrap()).as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            ),
            "save run journal",
        )
    }
}
pub fn recover() -> Result<()> {
    let _lock = Lock::acquire()?;
    recover_locked()
}
pub fn recover_locked() -> Result<()> {
    let p = journal_file()?;
    if !p.exists() {
        return Ok(());
    }
    let j: Journal = serde_json::from_slice(&fs::read(&p).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut failures = vec![];
    let installed = setup::read_state().ok();
    let mut batches = BTreeMap::<String, Vec<Ace>>::new();
    for ace in j.aces.iter().rev() {
        let group = batches.entry(ace.path.to_lowercase()).or_default();
        if !group.iter().any(|a| a.sid == ace.sid) {
            group.push(ace.clone());
        }
    }
    for batch in batches.into_values().rev() {
        let ace = &batch[0];
        if !Path::new(&ace.path).exists()
            && !ace.path.starts_with("\\\\.\\pipe\\")
            && !is_namespace(&ace.path)
        {
            continue;
        }
        // A killed recursive ACL update may have removed the root entry but
        // left inherited copies on descendants. Replay every journaled path,
        // even when its explicit root entry is already gone.
        let applied = batch.clone();
        let baseline: Vec<Ace> = installed
            .as_ref()
            .map(|s| {
                s.aces
                    .iter()
                    .filter(|a| {
                        applied
                            .iter()
                            .any(|p| p.path.eq_ignore_ascii_case(&a.path) && p.sid == a.sid)
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        if let Err(e) = acl_batch_restoring(&applied, &baseline) {
            // A closed pipe no longer has a DACL to clean up.
            if !ace.path.starts_with("\\\\.\\pipe\\") {
                failures.push(e);
            }
        }
    }
    if !failures.is_empty() {
        return Err(format!(
            "permission cleanup incomplete (journal retained): {}",
            failures.join("; ")
        ));
    }
    // Refuse recursive cleanup of anything except a run directory we created.
    let root = setup::state_dir()?.join("runs");
    let temp = PathBuf::from(&j.temp);
    if temp.parent() != Some(root.as_path())
        || !temp
            .file_name()
            .is_some_and(|x| x.to_string_lossy().starts_with("run-"))
    {
        return Err("invalid cleanup directory in journal".into());
    }
    if temp.exists() {
        fs::remove_dir_all(&temp).map_err(|e| format!("remove run directory: {e}"))?;
    }
    fs::remove_file(p).map_err(|e| e.to_string())?;
    Ok(())
}

fn canonical(p: &str) -> Result<String> {
    if p.contains('\0') {
        return Err("NUL in policy path".into());
    }
    let c = fs::canonicalize(p)
        .map_err(|e| format!("resolve {p}: {e}"))?
        .to_string_lossy()
        .into_owned();
    let c = c.strip_prefix("\\\\?\\").unwrap_or(&c).to_string();
    if !c.to_ascii_lowercase().starts_with("c:\\") || c[3..].contains(':') {
        return Err(format!("sandbox policy paths must be ordinary paths on C:, not network/device/other-drive paths: {p}"));
    }
    Ok(c)
}
fn validate(policy: &mut Policy) -> Result<()> {
    if policy.version != 1 || policy.rules.is_empty() || policy.rules.len() > 1024 {
        return Err("invalid sandbox policy version or rules".into());
    }
    let mut rules = BTreeMap::new();
    for r in &policy.rules {
        let p = canonical(&r.path)?;
        if p.len() <= 3 {
            return Err("a drive root cannot be a workspace".into());
        }
        if within(&p, "C:\\Windows")
            || within(&p, "C:\\Program Files")
            || within(&p, "C:\\Program Files (x86)")
            || within("C:\\Users", &p)
        {
            return Err(format!(
                "system/profile collection cannot be a workspace: {p}"
            ));
        }
        if within(&p, "C:\\ProgramData") && !setup::PROGRAM_DATA_ALLOW.iter().any(|a| within(&p, a))
        {
            return Err("ProgramData is hidden from sandbox commands".into());
        }
        rules.insert(
            p.to_lowercase(),
            Rule {
                path: p,
                access: r.access.clone(),
            },
        );
    }
    policy.rules = rules.into_values().collect();
    policy.rules.sort_by_key(|r| r.path.matches('\\').count());
    policy.cwd = canonical(&policy.cwd)?;
    if access_at(&policy.rules, &policy.cwd) == Access::None {
        return Err("command directory is not in the sandbox policy".into());
    }
    if let Some(channel) = &policy.host_channel {
        if !channel.path.starts_with("\\\\.\\pipe\\sfagents-web-")
            || channel.path["\\\\.\\pipe\\sfagents-web-".len()..].contains(['\\', '/', ':'])
        {
            return Err("invalid host pipe".into());
        }
    }
    Ok(())
}

fn protect_helper(policy: &mut Policy, helper: &str) {
    // A source checkout can itself be the workspace. Never let a command
    // replace the trusted executable used by the host's next invocation.
    // The normal guard-ancestor logic also prevents renaming its parents.
    if access_at(&policy.rules, helper) == Access::Write {
        policy.rules.push(Rule {
            path: helper.into(),
            access: Access::Read,
        });
        policy.rules.sort_by_key(|r| r.path.matches('\\').count());
    }
}

struct Permissions {
    journal: Journal,
}
impl Permissions {
    fn add(&mut self, p: &str, sid: &str, mask: u32, deny: bool, inherit: bool) -> Result<()> {
        let ace = Ace {
            path: p.into(),
            sid: sid.into(),
            mode: if deny { "deny" } else { "allow" }.into(),
            mask,
            inherit,
        };
        self.add_batch(vec![ace])
    }
    fn add_batch(&mut self, aces: Vec<Ace>) -> Result<()> {
        // Journal before changing anything, including a partially applied DACL.
        self.journal.aces.extend(aces.iter().cloned());
        write_journal(&self.journal)?;
        acl_batch(&aces, false)
    }
}
impl Drop for Permissions {
    fn drop(&mut self) {
        if let Err(e) = recover_locked() {
            eprintln!("sfagents-sandbox cleanup: {e}");
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Payload {
    owner: String,
    account: String,
    restricted: String,
    policy: Policy,
    exe: String,
    args: Vec<String>,
    temp: String,
}

pub fn run(args: &[String]) -> Result<i32> {
    if elevated()? {
        return Err("run must be launched from an ordinary, unelevated terminal".into());
    }
    let parent = parent_process()?;
    if args.len() < 4 || args[0] != "--policy" || args[2] != "--" {
        return Err("usage: run --policy <file> -- <exe> [args...]".into());
    }
    let bytes = fs::read(&args[1]).map_err(|e| e.to_string())?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("policy is too large".into());
    }
    let mut policy: Policy =
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid policy: {e}"))?;
    validate(&mut policy)?;
    let helper = std::env::current_exe().map_err(|e| e.to_string())?;
    protect_helper(
        &mut policy,
        &canonical(helper.to_str().ok_or("non-Unicode helper path")?)?,
    );
    let _lock = Lock::acquire()?;
    recover_locked()?;
    let state = setup::read_state()?;
    if state.version != 1 || !state.ready || state.owner != current_sid()? || state.sids.len() != 2
    {
        return Err("sandbox setup is incomplete or belongs to another user".into());
    }
    setup::check_coverage(&state)?;
    let index = usize::from(policy.network);
    let sid = state.sids[index].clone();
    if sid_text(lookup(setup::ACCOUNTS[index])?.ptr())? != sid {
        return Err("sandbox account changed; run setup".into());
    }
    if !policy.network {
        crate::network::probe(&sid)?;
    }
    let nonce = random()?;
    let restricted = format!(
        "S-1-5-21-{}-{}-{}-{}",
        u32::from_str_radix(&nonce[0..8], 16).unwrap(),
        u32::from_str_radix(&nonce[8..16], 16).unwrap(),
        u32::from_str_radix(&nonce[16..24], 16).unwrap(),
        u32::from_str_radix(&nonce[24..32], 16).unwrap()
    );
    let temp = setup::state_dir()?
        .join("runs")
        .join(format!("run-{nonce}"));
    fs::create_dir_all(&temp).map_err(|e| e.to_string())?;
    let temp_text = temp
        .to_str()
        .ok_or("non-Unicode run directory")?
        .to_string();
    let mut perms = Permissions {
        journal: Journal {
            aces: vec![],
            temp: temp_text.clone(),
        },
    };
    write_journal(&perms.journal)?;
    let namespace = namespace_path()?;
    perms.add_batch(
        [&sid, &restricted]
            .iter()
            .map(|principal| Ace {
                path: namespace.clone(),
                sid: (*principal).clone(),
                mode: "allow".into(),
                mask: 0x0f,
                inherit: false,
            })
            .collect(),
    )?;
    for r in &policy.rules {
        let dir = Path::new(&r.path).is_dir();
        let mask = match r.access {
            Access::Write => MODIFY,
            Access::Read => READ,
            Access::None => FILE_ALL_ACCESS,
        };
        let mut batch = vec![Ace {
            path: r.path.clone(),
            sid: sid.clone(),
            mode: if r.access == Access::None {
                "deny"
            } else {
                "allow"
            }
            .into(),
            mask,
            inherit: dir,
        }];
        if r.access == Access::Write {
            batch.push(Ace {
                path: r.path.clone(),
                sid: restricted.clone(),
                mode: "allow".into(),
                mask: MODIFY,
                inherit: dir,
            });
        }
        if r.access != Access::Write {
            for principal in [&sid, &restricted] {
                batch.push(Ace {
                    path: r.path.clone(),
                    sid: principal.clone(),
                    mode: "deny".into(),
                    mask: WRITE_BITS,
                    inherit: dir,
                });
            }
        }
        perms.add_batch(batch)?;
    }
    // Anchor guards and their parents so rename/delete cannot remove a guard's
    // ACL and replace it with a newly writable path (e.g. rename .git).
    let mut anchors = BTreeMap::new();
    for r in &policy.rules {
        let mut p = Path::new(&r.path).parent();
        while let Some(parent) = p {
            let text = parent.to_string_lossy().into_owned();
            if access_at(&policy.rules, &text) == Access::None {
                break;
            }
            if parent.is_dir() {
                anchors.insert(text, ());
            }
            p = parent.parent();
        }
    }
    for (p, _) in anchors {
        perms.add(
            &p,
            &sid,
            DELETE | FILE_DELETE_CHILD | WRITE_DAC | WRITE_OWNER,
            true,
            false,
        )?;
    }
    // A per-command empty home/temp. Never inherit the host's profile or keys.
    perms.add(&temp_text, &sid, MODIFY, false, true)?;
    perms.add(&temp_text, &restricted, MODIFY, false, true)?;
    let tool_dir = temp.join("bin");
    fs::create_dir(&tool_dir).map_err(|e| e.to_string())?;
    for tool in &policy.tools {
        if tool.name != "sf-node" && tool.name != "sf-web" {
            return Err("unknown host helper tool".into());
        }
        let p = canonical(&tool.path)?;
        if tool.name == "sf-node"
            && ![
                "C:\\Windows",
                "C:\\Program Files",
                "C:\\Program Files (x86)",
            ]
            .iter()
            .any(|system| within(&p, system))
        {
            perms.add(&p, &sid, READ, false, false)?;
        }
    }
    let node = policy.tools.iter().find(|t| t.name == "sf-node");
    let web = policy.tools.iter().find(|t| t.name == "sf-web");
    if let (Some(node), Some(web)) = (node, web) {
        fs::copy(&web.path, tool_dir.join("sf-web.cjs")).map_err(|e| e.to_string())?;
        // Node's path is host-generated. Do not expose a shell-generated script
        // containing an unescaped percent sign or quote.
        if node.path.contains(['%', '"', '\r', '\n']) {
            return Err("unsupported Node path for sf-web".into());
        }
        fs::write(
            tool_dir.join("sf-web.cmd"),
            format!("@\"{}\" \"%~dp0sf-web.cjs\" %*\r\n", node.path),
        )
        .map_err(|e| e.to_string())?;
        fs::write(
            tool_dir.join("sf-node.cmd"),
            format!("@\"{}\" %*\r\n", node.path),
        )
        .map_err(|e| e.to_string())?;
    }
    perms.add(tool_dir.to_str().unwrap(), &sid, WRITE_BITS, true, true)?;
    if let Some(channel) = &policy.host_channel {
        // libuv requests GENERIC_READ|GENERIC_WRITE. This pipe name is a unique
        // per-command capability; the host never connects as a pipe client.
        perms.add(
            &channel.path,
            &sid,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            false,
            false,
        )?;
        perms.add(
            &channel.path,
            &restricted,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            false,
            false,
        )?;
    }
    let exe = resolve_exe(&args[3], &policy)?;
    let payload = Payload {
        owner: state.owner.clone(),
        account: sid.clone(),
        restricted,
        policy,
        exe,
        args: args[4..].to_vec(),
        temp: temp_text,
    };
    let payload_path = temp.join("worker.json");
    fs::write(&payload_path, serde_json::to_vec(&payload).unwrap()).map_err(|e| e.to_string())?;
    perms.add(
        payload_path.to_str().unwrap(),
        &sid,
        WRITE_BITS,
        true,
        false,
    )?;
    perms.add(helper.to_str().unwrap(), &sid, READ, false, false)?;
    let pass = setup::password(index)?;
    let mut account_token = null_mut();
    unsafe {
        check(
            LogonUserW(
                wide(setup::ACCOUNTS[index]).as_ptr(),
                wide(".").as_ptr(),
                pass.0.as_ptr(),
                LOGON32_LOGON_INTERACTIVE,
                LOGON32_PROVIDER_DEFAULT,
                &mut account_token,
            ),
            "log on for private desktop",
        )?;
    }
    let account_token = Handle::new(account_token, "desktop logon token")?;
    let desktop = Desktop::create(
        &state.owner,
        &sid,
        &payload.restricted,
        &nonce,
        account_token.0,
    )?;
    let job = job()?;
    let application = wide(helper.to_str().unwrap());
    let mut cmd = wide(&command_line(
        helper.to_str().unwrap(),
        &["worker".into(), payload_path.to_string_lossy().into()],
    )?);
    let mut si: STARTUPINFOW = unsafe { zeroed() };
    si.cb = size_of::<STARTUPINFOW>() as u32;
    si.lpDesktop = desktop.name.as_ptr() as *mut u16;
    si.dwFlags = STARTF_USESTDHANDLES;
    unsafe {
        si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    }
    let mut pi: PROCESS_INFORMATION = unsafe { zeroed() };
    unsafe {
        // NULL environment here means the *new account's* profile environment,
        // as documented for CreateProcessWithLogonW, never the caller's env.
        check(
            CreateProcessWithLogonW(
                wide(setup::ACCOUNTS[index]).as_ptr(),
                wide(".").as_ptr(),
                pass.0.as_ptr(),
                LOGON_WITH_PROFILE,
                application.as_ptr(),
                cmd.as_mut_ptr(),
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                null(),
                wide(&payload.policy.cwd).as_ptr(),
                &si,
                &mut pi,
            ),
            "start sandbox account worker (check Log on locally policy)",
        )?;
    }
    let process = Handle::new(pi.hProcess, "worker process")?;
    let thread = Handle::new(pi.hThread, "worker thread")?;
    unsafe {
        if let Err(e) = check(
            AssignProcessToJobObject(job.0, process.0),
            "assign sandbox job",
        ) {
            TerminateProcess(process.0, 125);
            return Err(e);
        }
        if ResumeThread(thread.0) == u32::MAX {
            TerminateProcess(process.0, 125);
            return Err(last("resume worker"));
        }
        let wait = WaitForMultipleObjects(2, [process.0, parent.0].as_ptr(), 0, INFINITE);
        if wait != WAIT_OBJECT_0 && wait != WAIT_OBJECT_0 + 1 {
            return Err(last("wait for command or SF Agents exit"));
        }
        let mut code = 125;
        if wait == WAIT_OBJECT_0 {
            check(GetExitCodeProcess(process.0, &mut code), "worker exit code")?;
        }
        // Kill background children before revoking any ACLs or returning stdout.
        check(
            TerminateJobObject(job.0, 125),
            "terminate sandbox descendants",
        )?;
        WaitForSingleObject(job.0, 10_000);
        drop(job);
        drop(desktop);
        drop(perms);
        Ok(code as i32)
    }
}

fn parent_process() -> Result<Handle> {
    unsafe {
        let snapshot = Handle::new(
            CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0),
            "snapshot parent process",
        )?;
        let mut entry: PROCESSENTRY32W = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut found = Process32FirstW(snapshot.0, &mut entry);
        while found != 0 {
            if entry.th32ProcessID == GetCurrentProcessId() {
                // Hold a handle, not just a PID, so PID reuse cannot keep a run alive.
                return Handle::new(
                    OpenProcess(SYNCHRONIZE, 0, entry.th32ParentProcessID),
                    "watch SF Agents process",
                );
            }
            found = Process32NextW(snapshot.0, &mut entry);
        }
        Err("could not identify the SF Agents parent process".into())
    }
}

fn resolve_exe(exe: &str, policy: &Policy) -> Result<String> {
    let p = if Path::new(exe).is_absolute() {
        PathBuf::from(exe)
    } else {
        // Search only known system tool folders and explicitly readable roots.
        let mut search = vec![
            PathBuf::from("C:\\Windows\\System32"),
            PathBuf::from("C:\\Windows"),
        ];
        if let Some(paths) = policy
            .env
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
            .map(|(_, v)| v)
        {
            search.extend(
                paths
                    .split(';')
                    .filter(|p| !p.is_empty())
                    .map(PathBuf::from),
            );
        }
        search
            .into_iter()
            .map(|p| p.join(exe))
            .find(|p| p.is_file())
            .ok_or_else(|| format!("shell executable not found: {exe}"))?
    };
    canonical(p.to_str().ok_or("non-Unicode executable")?)
}

fn job() -> Result<Handle> {
    unsafe {
        let job = Handle::new(CreateJobObjectW(null(), null()), "create sandbox job")?;
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        check(
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ),
            "configure sandbox job",
        )?;
        let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS {
            // The private desktop is created by the broker outside this job.
            // HANDLES would prevent user32 initialization on that desktop.
            UIRestrictionsClass: JOB_OBJECT_UILIMIT_READCLIPBOARD
                | JOB_OBJECT_UILIMIT_WRITECLIPBOARD
                | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS
                | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS
                | JOB_OBJECT_UILIMIT_EXITWINDOWS
                | JOB_OBJECT_UILIMIT_DESKTOP
                | JOB_OBJECT_UILIMIT_GLOBALATOMS,
        };
        check(
            SetInformationJobObject(
                job.0,
                JobObjectBasicUIRestrictions,
                (&ui as *const JOBOBJECT_BASIC_UI_RESTRICTIONS).cast(),
                size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32,
            ),
            "restrict sandbox UI",
        )?;
        Ok(job)
    }
}
unsafe fn check_wait(h: HANDLE) -> Result<()> {
    if WaitForSingleObject(h, INFINITE) != WAIT_OBJECT_0 {
        Err(last("wait for sandbox process"))
    } else {
        Ok(())
    }
}

struct Desktop {
    station: HWINSTA,
    desktop: HDESK,
    name: Vec<u16>,
}
impl Desktop {
    fn create(
        owner: &str,
        account: &str,
        restricted: &str,
        nonce: &str,
        token: HANDLE,
    ) -> Result<Self> {
        unsafe {
            let mut sd = null_mut();
            check(
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wide(&format!(
                        "D:P(A;;GA;;;{owner})(A;;GA;;;{account})(A;;GA;;;{restricted})(A;;GA;;;SY)"
                    ))
                    .as_ptr(),
                    1,
                    &mut sd,
                    null_mut(),
                ),
                "private desktop security",
            )?;
            let _sd = Local(sd);
            let sa = SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: sd,
                bInheritHandle: 0,
            };
            // Windows allows only administrators to choose a station name.
            // An unnamed station uses this logon session's system-generated
            // name. CREATE_ONLY prevents reusing somebody else's station.
            // The fresh logon's LUID gives the unnamed station a private name.
            // Explicit credentials allow this impersonation without granting
            // SeImpersonatePrivilege to the host user.
            check(
                ImpersonateLoggedOnUser(token),
                "select private desktop logon",
            )?;
            let station = CreateWindowStationW(null(), 1, WINSTA_ALL_ACCESS as u32, &sa);
            let station_error = last("create private window station");
            check(RevertToSelf(), "restore host identity")?;
            if station.is_null() {
                return Err(station_error);
            }
            let mut station_name = [0u16; 512];
            let mut needed = 0;
            if GetUserObjectInformationW(
                station,
                2,
                station_name.as_mut_ptr().cast(),
                (station_name.len() * 2) as u32,
                &mut needed,
            ) == 0
            {
                let error = last("get private window station name");
                CloseWindowStation(station);
                return Err(error);
            }
            let station_name = from_wide(station_name.as_ptr());
            let old = GetProcessWindowStation();
            if SetProcessWindowStation(station) == 0 {
                CloseWindowStation(station);
                return Err(last("select private window station"));
            }
            let desktop_name = format!("command-{nonce}");
            let desktop =
                CreateDesktopW(wide(&desktop_name).as_ptr(), null(), null(), 0, 0x01ff, &sa);
            let error = last("create private desktop");
            let restored = SetProcessWindowStation(old);
            if desktop.is_null() || restored == 0 {
                if !desktop.is_null() {
                    CloseDesktop(desktop);
                }
                CloseWindowStation(station);
                return Err(error);
            }
            Ok(Self {
                station,
                desktop,
                name: wide(&format!("{station_name}\\{desktop_name}")),
            })
        }
    }
}
impl Drop for Desktop {
    fn drop(&mut self) {
        unsafe {
            CloseDesktop(self.desktop);
            CloseWindowStation(self.station);
        }
    }
}

pub fn worker(args: &[String]) -> Result<i32> {
    if args.len() != 1 {
        return Err("worker requires a payload".into());
    }
    let payload: Payload = serde_json::from_slice(&fs::read(&args[0]).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if current_sid()? != payload.account || elevated()? {
        return Err("worker must run as the selected standard sandbox account".into());
    }
    let primary = token()?;
    let restricting = Sid::parse(&payload.restricted)?;
    let sid = SID_AND_ATTRIBUTES {
        Sid: restricting.ptr(),
        Attributes: 0,
    };
    // The logon SID is used on this logon's private kernel/UI objects. Keeping
    // it in the restricting set lets Windows initialize those objects without
    // granting writes through the account's general Users memberships.
    let mut group_size = 0;
    unsafe {
        GetTokenInformation(primary.0, TokenGroups, null_mut(), 0, &mut group_size);
    }
    let mut group_data = vec![0u64; (group_size as usize + 7) / 8];
    let mut restricting_sids = vec![sid];
    let runtime_sid = Sid::parse(setup::RUNTIME_SID)?;
    restricting_sids.push(SID_AND_ATTRIBUTES {
        Sid: runtime_sid.ptr(),
        Attributes: 0,
    });
    let restricted_code = Sid::parse("S-1-5-12")?;
    restricting_sids.push(SID_AND_ATTRIBUTES {
        Sid: restricted_code.ptr(),
        Attributes: 0,
    });
    unsafe {
        check(
            GetTokenInformation(
                primary.0,
                TokenGroups,
                group_data.as_mut_ptr().cast(),
                group_size,
                &mut group_size,
            ),
            "read sandbox logon SID",
        )?;
        let groups = &*(group_data.as_ptr() as *const TOKEN_GROUPS);
        for group in std::slice::from_raw_parts(groups.Groups.as_ptr(), groups.GroupCount as usize)
        {
            if group.Attributes & SE_GROUP_LOGON_ID as u32 == SE_GROUP_LOGON_ID as u32 {
                restricting_sids.push(SID_AND_ATTRIBUTES {
                    Sid: group.Sid,
                    Attributes: 0,
                });
            }
        }
    }
    let mut restricted = null_mut();
    unsafe {
        check(
            CreateRestrictedToken(
                primary.0,
                DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED,
                0,
                null(),
                0,
                null(),
                restricting_sids.len() as u32,
                restricting_sids.as_ptr(),
                &mut restricted,
            ),
            "create restricted command token",
        )?;
    }
    let restricted = Handle::new(restricted, "restricted token")?;
    unsafe {
        // Newly created process/thread/kernel objects must pass both token
        // checks. The account's original default DACL has no restricting SID.
        let mut sd = null_mut();
        check(
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(&format!(
                    "D:P(A;;GA;;;{})(A;;GA;;;{})(A;;GA;;;{})(A;;GA;;;SY)",
                    payload.account, payload.owner, payload.restricted
                ))
                .as_ptr(),
                1,
                &mut sd,
                null_mut(),
            ),
            "restricted object default DACL",
        )?;
        let _sd = Local(sd);
        let mut dacl = null_mut();
        let mut present = 0;
        let mut defaulted = 0;
        check(
            GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted),
            "read restricted object DACL",
        )?;
        let default_dacl = TOKEN_DEFAULT_DACL { DefaultDacl: dacl };
        check(
            SetTokenInformation(
                restricted.0,
                TokenDefaultDacl,
                (&default_dacl as *const TOKEN_DEFAULT_DACL).cast(),
                size_of::<TOKEN_DEFAULT_DACL>() as u32,
            ),
            "set restricted object default DACL",
        )?;
        status(
            SetSecurityInfo(
                restricted.0,
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                dacl,
                null(),
            ),
            "set restricted token object DACL",
        )?;
    }
    let mut block = null_mut();
    unsafe {
        check(
            CreateEnvironmentBlock(&mut block, primary.0, 0),
            "create sandbox account environment",
        )?;
    }
    let mut env = BTreeMap::new();
    unsafe {
        let mut p = block as *const u16;
        while *p != 0 {
            let s = from_wide(p);
            p = p.add(s.encode_utf16().count() + 1);
            if let Some((k, v)) = s.split_once('=') {
                let k = k.to_uppercase();
                if [
                    "SYSTEMROOT",
                    "WINDIR",
                    "COMSPEC",
                    "OS",
                    "PATHEXT",
                    "PSMODULEPATH",
                    "PROGRAMFILES",
                    "PROGRAMFILES(X86)",
                    "PROGRAMW6432",
                    "COMMONPROGRAMFILES",
                    "COMMONPROGRAMFILES(X86)",
                    "COMMONPROGRAMW6432",
                    "PROCESSOR_ARCHITECTURE",
                    "PROCESSOR_IDENTIFIER",
                    "PROCESSOR_LEVEL",
                    "PROCESSOR_REVISION",
                    "NUMBER_OF_PROCESSORS",
                    "COMPUTERNAME",
                    "USERNAME",
                    "USERDOMAIN",
                ]
                .contains(&k.as_str())
                {
                    env.insert(k, v.to_string());
                }
            }
        }
        DestroyEnvironmentBlock(block);
    }
    // Only locale and usable PATH directories cross from the host. Never
    // propagate NODE_OPTIONS, Git config, Python hooks, proxies or credentials.
    for (k, v) in &payload.policy.env {
        if ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM"].contains(&k.to_uppercase().as_str())
        {
            env.insert(k.to_uppercase(), v.clone());
        }
    }
    let mut path_dirs = vec![
        format!("{}\\bin", payload.temp),
        "C:\\Windows\\System32".into(),
        "C:\\Windows".into(),
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0".into(),
    ];
    if let Some(paths) = payload
        .policy
        .env
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
        .map(|(_, v)| v)
    {
        for p in paths.split(';') {
            if let Ok(p) = canonical(p) {
                if within(&p, "C:\\Program Files")
                    || within(&p, "C:\\Program Files (x86)")
                    || access_at(&payload.policy.rules, &p) != Access::None
                {
                    path_dirs.push(p);
                }
            }
        }
    }
    env.insert("PATH".into(), path_dirs.join(";"));
    for key in [
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
    ] {
        env.insert(key.into(), payload.temp.clone());
    }
    env.insert("HOMEDRIVE".into(), "C:".into());
    env.insert("HOMEPATH".into(), payload.temp[2..].into());
    env.insert("SFAGENTS_SANDBOX".into(), "windows".into());
    // Git's ownership check is expected with the dedicated user. Trust only the
    // granted roots through process environment, never global system config.
    let readable: Vec<_> = payload
        .policy
        .rules
        .iter()
        .filter(|r| r.access != Access::None)
        .collect();
    env.insert("GIT_CONFIG_COUNT".into(), readable.len().to_string());
    for (i, r) in readable.iter().enumerate() {
        env.insert(format!("GIT_CONFIG_KEY_{i}"), "safe.directory".into());
        env.insert(format!("GIT_CONFIG_VALUE_{i}"), r.path.replace('\\', "/"));
    }
    if let Some(channel) = &payload.policy.host_channel {
        env.insert("SFAGENTS_HOST".into(), channel.path.clone());
    }
    let mut environment: Vec<u16> = vec![];
    for (k, v) in env {
        environment.extend(wide(&format!("{k}={v}")));
    }
    environment.push(0);
    let mut command = wide(&command_line(&payload.exe, &payload.args)?);
    if command.len() > 32767 {
        return Err("command exceeds Windows command line limit".into());
    }
    let mut si: STARTUPINFOW = unsafe { zeroed() };
    si.cb = size_of::<STARTUPINFOW>() as u32;
    si.dwFlags = STARTF_USESTDHANDLES;
    unsafe {
        // CreateProcessAsUser does not select the caller's desktop when this
        // is NULL. Keep the explicit private desktop assigned to the worker.
        let mut startup: STARTUPINFOW = zeroed();
        GetStartupInfoW(&mut startup);
        si.lpDesktop = startup.lpDesktop;
        si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
        for h in [si.hStdInput, si.hStdOutput, si.hStdError] {
            if !h.is_null() && h != INVALID_HANDLE_VALUE {
                check(
                    SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT),
                    "inherit command stream",
                )?;
            }
        }
    }
    let mut pi: PROCESS_INFORMATION = unsafe { zeroed() };
    let mut child_sd = null_mut();
    unsafe {
        check(
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(&format!(
                    "D:P(A;;GA;;;{})(A;;GA;;;{})(A;;GA;;;{})(A;;GA;;;SY)",
                    payload.account, payload.owner, payload.restricted
                ))
                .as_ptr(),
                1,
                &mut child_sd,
                null_mut(),
            ),
            "command process security",
        )?;
    }
    let _child_sd = Local(child_sd);
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: child_sd,
        bInheritHandle: 0,
    };
    unsafe {
        check(
            CreateProcessAsUserW(
                restricted.0,
                wide(&payload.exe).as_ptr(),
                command.as_mut_ptr(),
                &attributes,
                &attributes,
                1,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                environment.as_ptr().cast(),
                wide(&payload.policy.cwd).as_ptr(),
                &si,
                &mut pi,
            ),
            "start restricted command (no unsandboxed fallback)",
        )?;
    }
    let process = Handle::new(pi.hProcess, "command process")?;
    let thread = Handle::new(pi.hThread, "command thread")?;
    unsafe {
        // Windows may duplicate the supplied token while assigning it as the
        // process primary token. Secure that actual token object as well.
        let mut child_token = null_mut();
        check(
            OpenProcessToken(process.0, TOKEN_ALL_ACCESS, &mut child_token),
            "open command primary token",
        )?;
        let child_token = Handle::new(child_token, "command primary token")?;
        let mut dacl = null_mut();
        let mut present = 0;
        let mut defaulted = 0;
        check(
            GetSecurityDescriptorDacl(child_sd, &mut present, &mut dacl, &mut defaulted),
            "command token DACL",
        )?;
        status(
            SetSecurityInfo(
                child_token.0,
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                dacl,
                null(),
            ),
            "secure command primary token",
        )?;
    }
    let protect = || -> Result<()> {
        protect_handle(
            primary.0,
            SE_KERNEL_OBJECT,
            &payload.owner,
            &payload.account,
        )?;
        protect_handle(
            unsafe { GetCurrentProcess() },
            SE_KERNEL_OBJECT,
            &payload.owner,
            &payload.account,
        )
    };
    if let Err(e) = protect() {
        unsafe {
            TerminateProcess(process.0, 125);
        }
        return Err(e);
    }
    unsafe {
        if ResumeThread(thread.0) == u32::MAX {
            TerminateProcess(process.0, 125);
            return Err(last("resume restricted command"));
        }
        check_wait(process.0)?;
        let mut code = 125;
        check(
            GetExitCodeProcess(process.0, &mut code),
            "command exit code",
        )?;
        Ok(code as i32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn policy(root: &Path) -> Policy {
        Policy {
            version: 1,
            rules: vec![Rule {
                path: root.to_string_lossy().into(),
                access: Access::Write,
            }],
            network: false,
            cwd: root.to_string_lossy().into(),
            env: BTreeMap::new(),
            host_channel: None,
            tools: vec![],
        }
    }
    #[test]
    fn validates_canonical_boundaries_and_duplicate_rules() {
        let root = std::env::temp_dir().join(format!("sfagents-policy-unit-{}", random().unwrap()));
        fs::create_dir_all(root.join("child")).unwrap();
        let mut p = policy(&root);
        p.rules.push(Rule {
            path: root.join("child").to_string_lossy().into(),
            access: Access::Read,
        });
        p.rules.push(Rule {
            path: root.join("child").to_string_lossy().into(),
            access: Access::None,
        });
        validate(&mut p).unwrap();
        assert_eq!(p.rules.len(), 2);
        assert_eq!(
            access_at(&p.rules, root.join("child").to_str().unwrap()),
            Access::None
        );
        p.cwd = root.join("child").to_string_lossy().into();
        assert!(validate(&mut p)
            .unwrap_err()
            .contains("not in the sandbox policy"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn refuses_system_roots_and_foreign_pipes() {
        let mut p = policy(Path::new("C:\\Windows"));
        assert!(validate(&mut p)
            .unwrap_err()
            .contains("cannot be a workspace"));
        p = policy(Path::new("C:\\"));
        assert!(validate(&mut p).unwrap_err().contains("drive root"));
        let root = std::env::temp_dir().join(format!("sfagents-policy-unit-{}", random().unwrap()));
        fs::create_dir_all(&root).unwrap();
        p = policy(&root);
        p.host_channel = Some(Channel {
            path: "\\\\.\\pipe\\another-program".into(),
        });
        assert!(validate(&mut p).unwrap_err().contains("invalid host pipe"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn helper_inside_a_workspace_is_immutable() {
        let mut p = policy(Path::new("C:\\project"));
        let exe = "C:\\project\\native\\bin\\helper.exe";
        protect_helper(&mut p, exe);
        assert_eq!(access_at(&p.rules, exe), Access::Read);
        assert_eq!(access_at(&p.rules, "C:\\project\\source.rs"), Access::Write);
        assert_eq!(
            access_at(&p.rules, "C:\\project\\native\\bin"),
            Access::Write
        );
        let count = p.rules.len();
        protect_helper(&mut p, exe);
        protect_helper(&mut p, "C:\\other\\helper.exe");
        assert_eq!(p.rules.len(), count);
    }
}
