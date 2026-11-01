use std::{
    ffi::c_void,
    mem::{size_of, zeroed},
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, Cryptography::*, *},
    Storage::FileSystem::*,
    System::Threading::*,
};
pub type Result<T> = std::result::Result<T, String>;
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
pub fn last(context: &str) -> String {
    format!("{context}: {}", std::io::Error::last_os_error())
}
pub fn check(ok: i32, context: &str) -> Result<()> {
    if ok == 0 {
        Err(last(context))
    } else {
        Ok(())
    }
}
pub fn status(code: u32, context: &str) -> Result<()> {
    if code != 0 {
        Err(format!("{context}: Windows error {code}"))
    } else {
        Ok(())
    }
}
pub struct Handle(pub HANDLE);
impl Handle {
    pub fn new(h: HANDLE, ctx: &str) -> Result<Self> {
        if h.is_null() || h == INVALID_HANDLE_VALUE {
            Err(last(ctx))
        } else {
            Ok(Self(h))
        }
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
pub struct Local(pub *mut c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
pub struct Sid {
    pub mem: Local,
}
impl Sid {
    pub fn parse(s: &str) -> Result<Self> {
        let mut p = null_mut();
        unsafe {
            check(
                ConvertStringSidToSidW(wide(s).as_ptr(), &mut p),
                "parse SID",
            )?;
        }
        Ok(Self { mem: Local(p) })
    }
    pub fn ptr(&self) -> PSID {
        self.mem.0
    }
}
pub fn sid_text(sid: PSID) -> Result<String> {
    let mut p = null_mut();
    unsafe {
        check(ConvertSidToStringSidW(sid, &mut p), "format SID")?;
        let _mem = Local(p.cast());
        Ok(from_wide(p))
    }
}
pub unsafe fn from_wide(p: *const u16) -> String {
    if p.is_null() {
        return String::new();
    }
    let mut n = 0;
    while *p.add(n) != 0 {
        n += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(p, n))
}
pub fn token() -> Result<Handle> {
    let mut h = null_mut();
    unsafe {
        check(
            OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, &mut h),
            "open own token",
        )?;
    }
    Handle::new(h, "token")
}
pub fn current_sid() -> Result<String> {
    let t = token()?;
    let mut size = 0;
    unsafe {
        GetTokenInformation(t.0, TokenUser, null_mut(), 0, &mut size);
        let mut data = vec![0u64; (size as usize + 7) / 8];
        check(
            GetTokenInformation(t.0, TokenUser, data.as_mut_ptr().cast(), size, &mut size),
            "read token user",
        )?;
        sid_text((*(data.as_ptr() as *const TOKEN_USER)).User.Sid)
    }
}
pub fn elevated() -> Result<bool> {
    let t = token()?;
    let mut e: TOKEN_ELEVATION = unsafe { zeroed() };
    let mut n = 0;
    unsafe {
        check(
            GetTokenInformation(
                t.0,
                TokenElevation,
                (&mut e as *mut TOKEN_ELEVATION).cast(),
                size_of::<TOKEN_ELEVATION>() as u32,
                &mut n,
            ),
            "read elevation",
        )?;
    }
    Ok(e.TokenIsElevated != 0)
}
pub fn random() -> Result<String> {
    let mut bytes = [0u8; 24];
    unsafe {
        if BCryptGenRandom(
            null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        ) != 0
        {
            return Err("system random generator failed".into());
        }
    }
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
pub fn lookup(name: &str) -> Result<Sid> {
    let mut n = 0;
    let mut d = 0;
    let mut kind = 0;
    unsafe {
        LookupAccountNameW(
            null(),
            wide(name).as_ptr(),
            null_mut(),
            &mut n,
            null_mut(),
            &mut d,
            &mut kind,
        );
        let mut buf = vec![0u8; n as usize];
        let mut domain = vec![0u16; d as usize];
        check(
            LookupAccountNameW(
                null(),
                wide(name).as_ptr(),
                buf.as_mut_ptr().cast(),
                &mut n,
                domain.as_mut_ptr(),
                &mut d,
                &mut kind,
            ),
            "look up sandbox account",
        )?;
        Sid::parse(&sid_text(buf.as_mut_ptr().cast())?)
    }
}
// Modify excludes DELETE_CHILD: a parent must not be able to delete a guard.
pub const MODIFY: u32 = FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE;
// Edit is Modify without DELETE: files can be created and changed, not deleted or renamed.
pub const EDIT: u32 = FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE;
pub const WRITE_BITS: u32 = FILE_WRITE_DATA
    | FILE_APPEND_DATA
    | FILE_WRITE_EA
    | FILE_WRITE_ATTRIBUTES
    | FILE_DELETE_CHILD
    | DELETE
    | WRITE_DAC
    | WRITE_OWNER;
pub const READ: u32 = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
// Windows opens the session named-object directory with QUERY, TRAVERSE and
// CREATE rights during CLR/kernel initialization. Grant only that directory,
// never Everyone on the restricting token or inheritable filesystem rights.
pub fn namespace_path() -> Result<String> {
    let mut session = 0;
    unsafe {
        check(
            windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId(
                GetCurrentProcessId(),
                &mut session,
            ),
            "get command session",
        )?;
    }
    Ok(format!("\\Sessions\\{session}\\BaseNamedObjects"))
}
pub fn is_namespace(path: &str) -> bool {
    path.strip_prefix("\\Sessions\\")
        .and_then(|p| p.strip_suffix("\\BaseNamedObjects"))
        .is_some_and(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}
fn open_namespace(path: &str, access: u32) -> Result<Option<Handle>> {
    let mut text = wide(path);
    let mut name = UNICODE_STRING {
        Length: ((text.len() - 1) * 2) as u16,
        MaximumLength: (text.len() * 2) as u16,
        Buffer: text.as_mut_ptr(),
    };
    let attrs = windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES {
        Length: size_of::<windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: null_mut(),
        ObjectName: &mut name,
        Attributes: 0x40,
        SecurityDescriptor: null_mut(),
        SecurityQualityOfService: null_mut(),
    };
    let mut handle = null_mut();
    let code = unsafe {
        windows_sys::Wdk::Storage::FileSystem::NtOpenDirectoryObject(&mut handle, access, &attrs)
    };
    // A run journal can survive a reboot that removed the old session objects.
    if [0xc0000034, 0xc000003a].contains(&(code as u32)) {
        return Ok(None);
    }
    if code < 0 {
        return Err(format!(
            "open command kernel namespace: NTSTATUS {:08x}",
            code as u32
        ));
    }
    Ok(Some(Handle::new(handle, "command kernel namespace")?))
}
fn security_handle(path: &str, access: u32) -> Result<Option<Handle>> {
    if is_namespace(path) {
        return open_namespace(path, access);
    }
    if path.starts_with("\\\\.\\pipe") {
        return Ok(Some(Handle::new(
            unsafe {
                CreateFileW(
                    wide(path).as_ptr(),
                    access,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    null(),
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS,
                    null_mut(),
                )
            },
            "open host pipe permissions",
        )?));
    }
    Ok(None)
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Ace {
    pub path: String,
    pub sid: String,
    pub mode: String,
    pub mask: u32,
    pub inherit: bool,
}
/// Changes only our dedicated SID's entries, preserving other principals.
pub fn acl_batch(aces: &[Ace], remove: bool) -> Result<()> {
    change_acl(aces, remove, &[])
}
pub fn acl_batch_restoring(aces: &[Ace], baseline: &[Ace]) -> Result<()> {
    change_acl(aces, true, baseline)
}
fn change_acl(aces: &[Ace], remove: bool, baseline: &[Ace]) -> Result<()> {
    if aces.is_empty() {
        return Ok(());
    }
    let path = &aces[0].path;
    if aces.iter().any(|a| !a.path.eq_ignore_ascii_case(path)) {
        return Err("ACL batch contains different paths".into());
    }
    let sids: Vec<_> = aces
        .iter()
        .map(|a| Sid::parse(&a.sid))
        .collect::<Result<_>>()?;
    let mut old = null_mut();
    let mut sd = null_mut();
    let mut new_acl: *mut ACL = null_mut();
    let namespace = security_handle(path, READ_CONTROL | WRITE_DAC)?;
    if is_namespace(path) && namespace.is_none() {
        return if remove {
            Ok(())
        } else {
            Err("command session namespace is missing".into())
        };
    }
    let kind = if namespace.is_some() {
        SE_KERNEL_OBJECT
    } else {
        SE_FILE_OBJECT
    };
    unsafe {
        status(
            if let Some(handle) = &namespace {
                GetSecurityInfo(
                    handle.0,
                    kind,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    &mut old,
                    null_mut(),
                    &mut sd,
                )
            } else {
                GetNamedSecurityInfoW(
                    wide(path).as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    &mut old,
                    null_mut(),
                    &mut sd,
                )
            },
            &format!("read permissions on {path}"),
        )?;
        let _sd = Local(sd);
        if old.is_null() {
            return Err(format!("refusing null DACL on {path}"));
        }
        let entries: Vec<_> = aces
            .iter()
            .zip(&sids)
            .map(|(ace, sid)| {
                let mut entry: EXPLICIT_ACCESS_W = zeroed();
                entry.grfAccessPermissions = ace.mask;
                entry.grfAccessMode = if ace.mode == "deny" {
                    DENY_ACCESS
                } else {
                    GRANT_ACCESS
                };
                entry.grfInheritance = if ace.inherit {
                    SUB_CONTAINERS_AND_OBJECTS_INHERIT
                } else {
                    NO_INHERITANCE
                };
                entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
                entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
                entry.Trustee.ptstrName = sid.ptr().cast();
                entry
            })
            .collect();
        if remove {
            // REVOKE_ACCESS leaves deny ACEs behind on Windows. Copy every
            // unrelated/inherited ACE verbatim and omit only our explicit
            // allow/deny entries. SetNamedSecurityInfo then propagates removal.
            use windows_sys::Win32::System::Memory::{LocalAlloc, LMEM_FIXED};
            new_acl = LocalAlloc(LMEM_FIXED, (*old).AclSize as usize).cast();
            if new_acl.is_null() {
                return Err(last("allocate sandbox ACL"));
            }
            let build = (|| -> Result<()> {
                check(
                    InitializeAcl(new_acl, (*old).AclSize as u32, (*old).AclRevision as u32),
                    "initialize cleanup ACL",
                )?;
                for i in 0..(*old).AceCount {
                    let mut raw = null_mut();
                    check(GetAce(old, i as u32, &mut raw), "read cleanup ACE")?;
                    let header = &*(raw as *const ACE_HEADER);
                    let managed = [0, 1].contains(&header.AceType)
                        && header.AceFlags & INHERITED_ACE as u8 == 0
                        && sids.iter().any(|sid| {
                            let ace = &*(raw as *const ACCESS_ALLOWED_ACE);
                            EqualSid((&ace.SidStart as *const u32).cast_mut().cast(), sid.ptr())
                                != 0
                        });
                    if !managed {
                        check(
                            AddAce(
                                new_acl,
                                (*old).AclRevision as u32,
                                u32::MAX,
                                raw,
                                header.AceSize as u32,
                            ),
                            "preserve unrelated ACE",
                        )?;
                    }
                }
                Ok(())
            })();
            if let Err(e) = build {
                LocalFree(new_acl.cast());
                return Err(e);
            }
        } else {
            status(
                SetEntriesInAclW(entries.len() as u32, entries.as_ptr(), old, &mut new_acl),
                "build sandbox ACL",
            )?;
        }
        let _acl = Local(new_acl.cast());
        // Restore setup entries in memory, then publish one DACL. Recovery
        // must never revoke a persistent protection sharing this path/SID.
        let baseline_sids: Vec<_> = baseline
            .iter()
            .map(|a| Sid::parse(&a.sid))
            .collect::<Result<_>>()?;
        let baseline_entries: Vec<_> = baseline
            .iter()
            .zip(&baseline_sids)
            .map(|(ace, sid)| {
                let mut entry: EXPLICIT_ACCESS_W = zeroed();
                entry.grfAccessPermissions = ace.mask;
                entry.grfAccessMode = if ace.mode == "deny" {
                    DENY_ACCESS
                } else {
                    GRANT_ACCESS
                };
                entry.grfInheritance = if ace.inherit {
                    SUB_CONTAINERS_AND_OBJECTS_INHERIT
                } else {
                    NO_INHERITANCE
                };
                entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
                entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
                entry.Trustee.ptstrName = sid.ptr().cast();
                entry
            })
            .collect();
        let mut restored = null_mut();
        if !baseline_entries.is_empty() {
            status(
                SetEntriesInAclW(
                    baseline_entries.len() as u32,
                    baseline_entries.as_ptr(),
                    new_acl,
                    &mut restored,
                ),
                "restore permanent sandbox ACL",
            )?;
        }
        let _restored = Local(restored.cast());
        if !restored.is_null() {
            new_acl = restored;
        }
        status(
            if let Some(handle) = &namespace {
                SetSecurityInfo(
                    handle.0,
                    kind,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    new_acl,
                    null(),
                )
            } else {
                SetNamedSecurityInfoW(
                    wide(path).as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    new_acl,
                    null(),
                )
            },
            &format!("set permissions on {path}"),
        )
    }
}

/// One entry for set_explicit_here: deny or allow `mask`, with raw ACE `flags`
/// (0 for this object only; OBJECT|CONTAINER|INHERIT_ONLY for new children).
pub struct Entry {
    pub deny: bool,
    pub mask: u32,
    pub flags: u8,
}

/// Replaces the explicit (not inherited) allow/deny entries for @p sids on
/// @p path with @p entries, keeping every other entry, and writes the DACL
/// with SetFileSecurityW, which changes only this object: nothing is
/// propagated to (or re-walked through) its children. For folders whose trees
/// are large or not ours (C:\, C:\Users, a profile).
pub fn set_explicit_here(path: &str, sids: &[String], entries: &[Entry]) -> Result<()> {
    let parsed: Vec<Sid> = sids.iter().map(|s| Sid::parse(s)).collect::<Result<_>>()?;
    unsafe {
        let wpath = wide(path);
        let mut needed = 0u32;
        GetFileSecurityW(
            wpath.as_ptr(),
            DACL_SECURITY_INFORMATION,
            null_mut(),
            0,
            &mut needed,
        );
        if needed == 0 {
            return Err(last(&format!("read permissions on {path}")));
        }
        let mut old_sd = vec![0u64; (needed as usize + 7) / 8];
        check(
            GetFileSecurityW(
                wpath.as_ptr(),
                DACL_SECURITY_INFORMATION,
                old_sd.as_mut_ptr().cast(),
                needed,
                &mut needed,
            ),
            &format!("read permissions on {path}"),
        )?;
        let mut present = 0;
        let mut defaulted = 0;
        let mut old: *mut ACL = null_mut();
        check(
            GetSecurityDescriptorDacl(
                old_sd.as_mut_ptr().cast(),
                &mut present,
                &mut old,
                &mut defaulted,
            ),
            "read DACL",
        )?;
        if present == 0 || old.is_null() {
            return Err(format!("refusing null DACL on {path}"));
        }
        let mut control = 0u16;
        let mut revision = 0u32;
        check(
            GetSecurityDescriptorControl(old_sd.as_mut_ptr().cast(), &mut control, &mut revision),
            "read DACL control",
        )?;
        let ours = |raw: *mut c_void| -> bool {
            let header = &*(raw as *const ACE_HEADER);
            [0, 1].contains(&header.AceType)
                && header.AceFlags & INHERITED_ACE as u8 == 0
                && parsed.iter().any(|sid| {
                    let ace = &*(raw as *const ACCESS_ALLOWED_ACE);
                    EqualSid((&ace.SidStart as *const u32).cast_mut().cast(), sid.ptr()) != 0
                })
        };
        let extra: u32 = parsed
            .iter()
            .map(|s| {
                (size_of::<ACCESS_ALLOWED_ACE>() as u32 + GetLengthSid(s.ptr()))
                    * entries.len() as u32
            })
            .sum();
        let size = (*old).AclSize as u32 + extra + 64;
        let mut acl = vec![0u64; (size as usize + 7) / 8];
        let new: *mut ACL = acl.as_mut_ptr().cast();
        check(InitializeAcl(new, size, ACL_REVISION_DS), "initialize ACL")?;
        // Canonical order: explicit denies, explicit allows, then inherited.
        for e in entries.iter().filter(|e| e.deny) {
            for sid in &parsed {
                check(
                    AddAccessDeniedAceEx(new, ACL_REVISION_DS, e.flags as _, e.mask, sid.ptr()),
                    "add deny entry",
                )?;
            }
        }
        let copy = |inherited: bool| -> Result<()> {
            for i in 0..(*old).AceCount {
                let mut raw = null_mut();
                check(GetAce(old, i as u32, &mut raw), "read ACE")?;
                let header = &*(raw as *const ACE_HEADER);
                if (header.AceFlags & INHERITED_ACE as u8 != 0) != inherited || ours(raw) {
                    continue;
                }
                check(
                    AddAce(new, ACL_REVISION_DS, u32::MAX, raw, header.AceSize as u32),
                    "keep entry",
                )?;
            }
            Ok(())
        };
        copy(false)?;
        for e in entries.iter().filter(|e| !e.deny) {
            for sid in &parsed {
                check(
                    AddAccessAllowedAceEx(new, ACL_REVISION_DS, e.flags as _, e.mask, sid.ptr()),
                    "add allow entry",
                )?;
            }
        }
        copy(true)?;
        let mut sd: SECURITY_DESCRIPTOR = zeroed();
        check(
            InitializeSecurityDescriptor(
                (&mut sd as *mut SECURITY_DESCRIPTOR).cast(),
                windows_sys::Win32::System::SystemServices::SECURITY_DESCRIPTOR_REVISION,
            ),
            "initialize security descriptor",
        )?;
        check(
            SetSecurityDescriptorDacl((&mut sd as *mut SECURITY_DESCRIPTOR).cast(), 1, new, 0),
            "set DACL",
        )?;
        // Keep whether the DACL was protected from (or inherits) its parent.
        let keep = control & (SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED);
        check(
            SetSecurityDescriptorControl((&mut sd as *mut SECURITY_DESCRIPTOR).cast(), keep, keep),
            "keep DACL control",
        )?;
        check(
            SetFileSecurityW(
                wpath.as_ptr(),
                DACL_SECURITY_INFORMATION,
                (&mut sd as *mut SECURITY_DESCRIPTOR).cast(),
            ),
            &format!("set permissions on {path}"),
        )
    }
}

pub fn has_ace(ace: &Ace) -> Result<bool> {
    let sid = Sid::parse(&ace.sid)?;
    let mut dacl = null_mut();
    let mut sd = null_mut();
    let namespace = security_handle(&ace.path, READ_CONTROL)?;
    if is_namespace(&ace.path) && namespace.is_none() {
        return Ok(false);
    }
    let kind = if namespace.is_some() {
        SE_KERNEL_OBJECT
    } else {
        SE_FILE_OBJECT
    };
    unsafe {
        status(
            if let Some(handle) = &namespace {
                GetSecurityInfo(
                    handle.0,
                    kind,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    &mut dacl,
                    null_mut(),
                    &mut sd,
                )
            } else {
                GetNamedSecurityInfoW(
                    wide(&ace.path).as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    &mut dacl,
                    null_mut(),
                    &mut sd,
                )
            },
            &format!("inspect installed sandbox ACL on {}", ace.path),
        )?;
        let _sd = Local(sd);
        if dacl.is_null() {
            return Ok(false);
        }
        for i in 0..(*dacl).AceCount {
            let mut raw = null_mut();
            check(GetAce(dacl, i as u32, &mut raw), "inspect sandbox ACE")?;
            let a = &*(raw as *const ACCESS_ALLOWED_ACE);
            let mode = if ace.mode == "deny" { 1 } else { 0 };
            if (ace.mode != "any" && a.Header.AceType != mode)
                || ![0, 1].contains(&a.Header.AceType)
                || a.Header.AceFlags & INHERITED_ACE as u8 != 0
            {
                continue;
            }
            if a.Mask & ace.mask != ace.mask {
                continue;
            }
            if ace.inherit
                && std::path::Path::new(&ace.path).is_dir()
                && a.Header.AceFlags & (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) as u8
                    != (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) as u8
            {
                continue;
            }
            if EqualSid((&a.SidStart as *const u32).cast_mut().cast(), sid.ptr()) != 0 {
                return Ok(true);
            }
        }
        Ok(false)
    }
}
pub fn protect_handle(
    handle: HANDLE,
    kind: SE_OBJECT_TYPE,
    owner: &str,
    account: &str,
) -> Result<()> {
    // OWNER RIGHTS removes the owner's implicit WRITE_DAC as well: a command
    // with the same user SID must not rewrite its broker's process/token DACL.
    let text = format!("D:P(D;;GA;;;OW)(D;;GA;;;{account})(A;;GA;;;{owner})(A;;GA;;;SY)");
    let mut sd = null_mut();
    unsafe {
        check(
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(&text).as_ptr(),
                1,
                &mut sd,
                null_mut(),
            ),
            "build broker security",
        )?;
        let _sd = Local(sd);
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl = null_mut();
        check(
            GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted),
            "broker DACL",
        )?;
        status(
            SetSecurityInfo(
                handle,
                kind,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                dacl,
                null(),
            ),
            "protect broker handle",
        )
    }
}
pub struct Lock(Handle);
impl Lock {
    pub fn acquire() -> Result<Self> {
        unsafe {
            let h = Handle::new(
                CreateMutexW(null(), 0, wide("Global\\SF-Agents-Sandbox-v1").as_ptr()),
                "sandbox lock",
            )?;
            let wait = WaitForSingleObject(h.0, 25_000);
            if wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED {
                return Err(
                    "another sandbox command is still running; retry after it finishes".into(),
                );
            }
            Ok(Self(h))
        }
    }
}
impl Drop for Lock {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.0 .0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_entries_change_only_the_folder_itself() {
        let dir = std::env::temp_dir().join(format!("sfagents-here-test-{}", random().unwrap()));
        std::fs::create_dir_all(dir.join("child")).unwrap();
        let path = dir.to_string_lossy().into_owned();
        let child = dir.join("child").to_string_lossy().into_owned();
        let sid = format!("S-1-5-21-{}-1-1-9998", std::process::id());
        let probe = |p: &str, mode: &str, mask: u32| Ace {
            path: p.into(),
            sid: sid.clone(),
            mode: mode.into(),
            mask,
            inherit: false,
        };
        let entries = [
            Entry {
                deny: true,
                mask: FILE_WRITE_DATA,
                flags: 0,
            },
            Entry {
                deny: true,
                mask: FILE_ALL_ACCESS,
                flags: (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE | INHERIT_ONLY_ACE) as u8,
            },
            Entry {
                deny: false,
                mask: FILE_LIST_DIRECTORY,
                flags: 0,
            },
        ];
        set_explicit_here(&path, std::slice::from_ref(&sid), &entries).unwrap();
        assert!(has_ace(&probe(&path, "deny", FILE_WRITE_DATA)).unwrap());
        assert!(has_ace(&probe(&path, "allow", FILE_LIST_DIRECTORY)).unwrap());
        // Not propagated: the existing child has no entry for the SID.
        assert!(!has_ace(&probe(&child, "any", 0)).unwrap());
        // Replaced, not added to: a second call leaves one set.
        set_explicit_here(&path, std::slice::from_ref(&sid), &entries[..1]).unwrap();
        assert!(!has_ace(&probe(&path, "allow", FILE_LIST_DIRECTORY)).unwrap());
        set_explicit_here(&path, std::slice::from_ref(&sid), &[]).unwrap();
        assert!(!has_ace(&probe(&path, "any", 0)).unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn recovery_preserves_permanent_allow_and_deny_entries_on_the_same_sid() {
        let dir = std::env::temp_dir().join(format!("sfagents-acl-test-{}", random().unwrap()));
        std::fs::create_dir(&dir).unwrap();
        let sid = format!("S-1-5-21-{}-1-1-9999", std::process::id());
        let entry = |mode: &str, mask| Ace {
            path: dir.to_string_lossy().into(),
            sid: sid.clone(),
            mode: mode.into(),
            mask,
            inherit: true,
        };
        let baseline = [
            entry("deny", FILE_WRITE_DATA),
            entry("allow", FILE_READ_ATTRIBUTES),
        ];
        let temporary = [entry("allow", FILE_READ_DATA)];
        let result = (|| -> Result<()> {
            acl_batch(&baseline, false)?;
            acl_batch(&temporary, false)?;
            assert!(has_ace(&temporary[0])?);
            acl_batch_restoring(&temporary, &baseline)?;
            assert!(has_ace(&baseline[0])?);
            assert!(has_ace(&baseline[1])?);
            assert!(!has_ace(&temporary[0])?);
            Ok(())
        })();
        let cleanup = acl_batch(&baseline, true);
        if cleanup.is_ok() {
            assert!(
                !has_ace(&baseline[0]).unwrap(),
                "deny ACE must be removed too"
            );
            assert!(!has_ace(&baseline[1]).unwrap(), "allow ACE must be removed");
        }
        std::fs::remove_dir_all(&dir).unwrap();
        result.unwrap();
        cleanup.unwrap();
    }
}
