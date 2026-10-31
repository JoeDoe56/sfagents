//! WFP supplements the visible firewall rules, including loopback, IPv4/IPv6
//! and arbitrary executables. Only the offline user's SID matches these filters.
use crate::win::*;
use std::{
    mem::zeroed,
    ptr::{null, null_mut},
};
use windows_sys::{
    core::GUID,
    Win32::{
        Foundation::*,
        NetworkManagement::WindowsFilteringPlatform::*,
        Security::{Authorization::*, *},
    },
};
const SUBLAYER: GUID = GUID::from_u128(0xbb80ba17_698a_46ef_a670_8c204d893480);
const KEYS: [GUID; 4] = [
    GUID::from_u128(0xbb80ba17_698a_46ef_a670_8c204d893481),
    GUID::from_u128(0xbb80ba17_698a_46ef_a670_8c204d893482),
    GUID::from_u128(0xbb80ba17_698a_46ef_a670_8c204d893483),
    GUID::from_u128(0xbb80ba17_698a_46ef_a670_8c204d893484),
];
const LAYERS: [GUID; 4] = [
    FWPM_LAYER_ALE_AUTH_CONNECT_V4,
    FWPM_LAYER_ALE_AUTH_CONNECT_V6,
    FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4,
    FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6,
];
struct Engine(HANDLE);
impl Engine {
    fn open() -> Result<Self> {
        let mut h = null_mut();
        unsafe {
            status(
                FwpmEngineOpen0(null(), 10, null(), null(), &mut h),
                "open Windows Filtering Platform",
            )?;
        }
        Ok(Self(h))
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        unsafe {
            FwpmEngineClose0(self.0);
        }
    }
}
fn same(a: &GUID, b: &GUID) -> bool {
    (a.data1, a.data2, a.data3, a.data4) == (b.data1, b.data2, b.data3, b.data4)
}
fn absent(code: u32) -> bool {
    [0x80320003, 0x80320007, 0x80320008].contains(&code)
}
pub fn install(sid: &str) -> Result<()> {
    let e = Engine::open()?;
    unsafe {
        // The unelevated broker must be able to verify these filters without
        // receiving permission to change or delete them.
        let mut security = null_mut();
        check(
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(&format!(
                    "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x00020080;;;{})",
                    current_sid()?
                ))
                .as_ptr(),
                1,
                &mut security,
                null_mut(),
            ),
            "network filter read permissions",
        )?;
        let _security = Local(security);
        // Replace atomically: an interrupted setup never marks itself ready.
        status(
            FwpmTransactionBegin0(e.0, 0),
            "begin network filter transaction",
        )?;
        let result = (|| -> Result<()> {
            for key in KEYS {
                let code = FwpmFilterDeleteByKey0(e.0, &key);
                if !absent(code) {
                    status(code, "refresh offline network filter")?;
                }
            }
            let mut sub: FWPM_SUBLAYER0 = zeroed();
            sub.subLayerKey = SUBLAYER;
            let mut name = wide("SF Agents offline sandbox");
            sub.displayData.name = name.as_mut_ptr();
            sub.flags = FWPM_SUBLAYER_FLAG_PERSISTENT;
            sub.weight = u16::MAX;
            let code = FwpmSubLayerAdd0(e.0, &sub, security);
            if code != 0x80320009 {
                status(code, "create sandbox network sublayer")?;
            }
            let mut sd = null_mut();
            check(
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    wide(&format!("D:(A;;CC;;;{sid})")).as_ptr(),
                    1,
                    &mut sd,
                    null_mut(),
                ),
                "offline SID filter",
            )?;
            let _sd = Local(sd);
            let mut blob = FWP_BYTE_BLOB {
                size: GetSecurityDescriptorLength(sd),
                data: sd.cast(),
            };
            let mut condition: FWPM_FILTER_CONDITION0 = zeroed();
            condition.fieldKey = FWPM_CONDITION_ALE_USER_ID;
            condition.matchType = FWP_MATCH_EQUAL;
            condition.conditionValue.r#type = FWP_SECURITY_DESCRIPTOR_TYPE;
            condition.conditionValue.Anonymous.sd = &mut blob;
            // Connections the sandbox accepts over loopback stay allowed, so a
            // dev server it runs can be opened on this computer (SF Agents'
            // port artifacts, the user's browser). It still cannot connect
            // anywhere itself, loopback included, or accept from the network.
            let mut remote: FWPM_FILTER_CONDITION0 = zeroed();
            remote.fieldKey = FWPM_CONDITION_FLAGS;
            remote.matchType = FWP_MATCH_FLAGS_NONE_SET;
            remote.conditionValue.r#type = FWP_UINT32;
            remote.conditionValue.Anonymous.uint32 = FWP_CONDITION_FLAG_IS_LOOPBACK;
            let mut accept = [condition, remote];
            for i in 0..4 {
                let mut filter: FWPM_FILTER0 = zeroed();
                filter.filterKey = KEYS[i];
                filter.displayData.name = name.as_mut_ptr();
                filter.flags = FWPM_FILTER_FLAG_PERSISTENT;
                filter.layerKey = LAYERS[i];
                filter.subLayerKey = SUBLAYER;
                filter.weight.r#type = FWP_UINT8;
                filter.weight.Anonymous.uint8 = 15;
                if i < 2 {
                    filter.numFilterConditions = 1;
                    filter.filterCondition = &mut condition;
                } else {
                    filter.numFilterConditions = 2;
                    filter.filterCondition = accept.as_mut_ptr();
                }
                filter.action.r#type = FWP_ACTION_BLOCK;
                status(
                    FwpmFilterAdd0(e.0, &filter, security, null_mut()),
                    "add offline user network block",
                )?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => status(
                FwpmTransactionCommit0(e.0),
                "commit offline network filters",
            ),
            Err(err) => {
                FwpmTransactionAbort0(e.0);
                Err(err)
            }
        }
    }
}
pub fn probe(sid: &str) -> Result<()> {
    let e = Engine::open()?;
    let expected = Sid::parse(sid)?;
    unsafe {
        for i in 0..4 {
            let mut f = null_mut();
            status(
                FwpmFilterGetByKey0(e.0, &KEYS[i], &mut f),
                "offline network filter missing; run setup",
            )?;
            let result = (|| -> Result<()> {
                let filter = &*f;
                // Accept filters may also exempt loopback (older setups block it too).
                let loopback_exempt = |c: &FWPM_FILTER_CONDITION0| {
                    same(&c.fieldKey, &FWPM_CONDITION_FLAGS)
                        && c.matchType == FWP_MATCH_FLAGS_NONE_SET
                        && c.conditionValue.r#type == FWP_UINT32
                        && c.conditionValue.Anonymous.uint32 == FWP_CONDITION_FLAG_IS_LOOPBACK
                };
                let conditions_ok = filter.numFilterConditions == 1
                    || (i >= 2
                        && filter.numFilterConditions == 2
                        && loopback_exempt(&*filter.filterCondition.add(1)));
                if filter.action.r#type != FWP_ACTION_BLOCK
                    || !conditions_ok
                    || filter.flags & FWPM_FILTER_FLAG_PERSISTENT == 0
                {
                    return Err("invalid offline network filter".into());
                }
                let cond = &*filter.filterCondition;
                if !same(&cond.fieldKey, &FWPM_CONDITION_ALE_USER_ID) {
                    return Err("invalid offline SID filter".into());
                }
                if cond.conditionValue.r#type != FWP_SECURITY_DESCRIPTOR_TYPE {
                    return Err("invalid offline SID filter".into());
                }
                let blob = &*cond.conditionValue.Anonymous.sd;
                let mut dacl = null_mut();
                let mut present = 0;
                let mut defaulted = 0;
                check(
                    GetSecurityDescriptorDacl(
                        blob.data.cast(),
                        &mut present,
                        &mut dacl,
                        &mut defaulted,
                    ),
                    "read network SID filter",
                )?;
                if dacl.is_null() || (*dacl).AceCount != 1 {
                    return Err("offline network filter has a different SID".into());
                }
                let mut ace = null_mut();
                check(GetAce(dacl, 0, &mut ace), "read network SID")?;
                let allowed = ace as *const ACCESS_ALLOWED_ACE;
                if (*allowed).Header.AceType != 0
                    || EqualSid(
                        (&(*allowed).SidStart as *const u32).cast_mut().cast(),
                        expected.ptr(),
                    ) == 0
                {
                    return Err("offline network filter targets a different account".into());
                }
                Ok(())
            })();
            FwpmFreeMemory0((&mut f as *mut *mut FWPM_FILTER0).cast());
            result?;
        }
    }
    Ok(())
}
pub fn uninstall() -> Result<()> {
    let e = Engine::open()?;
    unsafe {
        for key in KEYS {
            let code = FwpmFilterDeleteByKey0(e.0, &key);
            if !absent(code) {
                status(code, "remove offline network filter")?;
            }
        }
        let code = FwpmSubLayerDeleteByKey0(e.0, &SUBLAYER);
        if !absent(code) {
            status(code, "remove offline network sublayer")?;
        }
    }
    Ok(())
}
