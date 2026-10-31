use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    Read,
    /// Read and write, without deleting (or renaming) anything.
    Edit,
    Write,
    None,
}

impl Access {
    /// Write or Edit: commands may change files.
    pub fn writable(&self) -> bool {
        matches!(self, Access::Write | Access::Edit)
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Rule {
    pub path: String,
    pub access: Access,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Tool {
    pub path: String,
    pub name: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Channel {
    pub path: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub version: u32,
    pub rules: Vec<Rule>,
    pub network: bool,
    pub cwd: String,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub host_channel: Option<Channel>,
    #[serde(default)]
    pub tools: Vec<Tool>,
}
/// CRT quoting, including empty arguments, embedded quotes and trailing slashes.
pub fn quote(arg: &str) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for c in arg.chars() {
        if c == '\\' {
            slashes += 1;
            continue;
        }
        if c == '"' {
            result.push_str(&"\\".repeat(slashes * 2 + 1));
        } else {
            result.push_str(&"\\".repeat(slashes));
        }
        slashes = 0;
        result.push(c);
    }
    result.push_str(&"\\".repeat(slashes * 2));
    result.push('"');
    result
}
pub fn command_line(exe: &str, args: &[String]) -> Result<String, String> {
    if exe.contains('\0') || args.iter().any(|a| a.contains('\0')) {
        return Err("NUL in command".into());
    }
    // cmd parses everything after /c itself; CRT escaping changes the program.
    let cmd =
        exe.to_ascii_lowercase().ends_with("\\cmd.exe") || exe.eq_ignore_ascii_case("cmd.exe");
    if cmd && args.len() == 4 && args[..3] == ["/d", "/s", "/c"] {
        return Ok(format!("{} /d /s /c \"{}\"", quote(exe), args[3]));
    }
    Ok(std::iter::once(quote(exe))
        .chain(args.iter().map(|s| quote(s)))
        .collect::<Vec<_>>()
        .join(" "))
}
pub fn within(child: &str, parent: &str) -> bool {
    let c = child.trim_end_matches('\\').to_lowercase();
    let p = parent.trim_end_matches('\\').to_lowercase();
    c == p || c.starts_with(&(p + "\\"))
}
/// Longest prefix wins; a later duplicate replaces an earlier rule.
pub fn access_at(rules: &[Rule], path: &str) -> Access {
    rules
        .iter()
        .filter(|r| within(path, &r.path))
        .enumerate()
        .max_by_key(|(i, r)| (r.path.len(), *i))
        .map(|(_, r)| r.access.clone())
        .unwrap_or(Access::None)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quotes_arguments() {
        assert_eq!(quote(""), "\"\"");
        assert_eq!(quote("a b\\"), "\"a b\\\\\"");
        assert_eq!(quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(
            command_line(
                "C:\\Windows\\System32\\cmd.exe",
                &[
                    "/d".into(),
                    "/s".into(),
                    "/c".into(),
                    "echo \"a b\" > x".into()
                ]
            )
            .unwrap(),
            "\"C:\\Windows\\System32\\cmd.exe\" /d /s /c \"echo \"a b\" > x\""
        );
    }
    #[test]
    fn path_boundaries_and_overrides() {
        let rules = vec![
            Rule {
                path: "C:\\work".into(),
                access: Access::Write,
            },
            Rule {
                path: "C:\\work\\private".into(),
                access: Access::None,
            },
            Rule {
                path: "c:\\WORK\\private\\shared".into(),
                access: Access::Read,
            },
        ];
        assert_eq!(
            access_at(&rules, "C:\\work\\private\\shared\\x"),
            Access::Read
        );
        assert_eq!(access_at(&rules, "C:\\work\\private\\x"), Access::None);
        assert_eq!(access_at(&rules, "C:\\workspace"), Access::None);
    }
}
