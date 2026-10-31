/**
 * "rw" without "d" on Linux. A bind mount is writable or not; it cannot
 * allow writing but not deleting. Landlock (Linux 5.13 and later) can: a
 * command started through this launcher may delete or move files only under
 * the paths it is given (the "rwd" folders and the sandbox's own temporary
 * folders), so in an "rw" folder it can create and change files but not
 * delete or rename them. Everything else is still bubblewrap's job: Landlock
 * here restricts only removing and moving.
 *
 * The launcher is a short Python script run with the system's python3 inside
 * the sandbox, so there is nothing to build: it enables Landlock with the
 * raw system calls (the same numbers on every architecture), then execs the
 * command. A Landlock domain is inherited and cannot be lifted, so nothing
 * the command runs can undo it.
 *
 * Landlock rules apply to a whole folder tree and only add rights, so an "rw"
 * folder inside an "rwd" one cannot be narrowed this way: the loader warns
 * about that layout on Linux.
 */

import fs from 'node:fs';
import path from 'node:path';

const LAUNCHER = String.raw`
import ctypes, json, os, sys
def fail(why):
    sys.stderr.write("sfagents: folders with \"rw\" (no delete) need Landlock to be enforced, and " + why + ". Give the folder \"rwd\" or \"r\" instead.\n")
    sys.exit(126)
libc = ctypes.CDLL(None, use_errno=True)
syscall = libc.syscall
syscall.restype = ctypes.c_long
abi = syscall(444, None, ctypes.c_size_t(0), ctypes.c_uint32(1))
if abi < 1:
    fail("this kernel does not provide it (Linux 5.13 or later, with Landlock enabled)")
REMOVE_DIR, REMOVE_FILE, REFER = 1 << 4, 1 << 5, 1 << 13
handled = REMOVE_DIR | REMOVE_FILE | (REFER if abi >= 2 else 0)
class Ruleset(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]
class PathBeneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]
ruleset = Ruleset(handled)
fd = syscall(444, ctypes.byref(ruleset), ctypes.c_size_t(ctypes.sizeof(ruleset)), ctypes.c_uint32(0))
if fd < 0:
    fail("creating the rules failed (error %d)" % ctypes.get_errno())
for p in json.loads(sys.argv[1]):
    try:
        if not os.path.isdir(p):
            continue
        dir_fd = os.open(p, os.O_PATH | os.O_CLOEXEC)
    except OSError:
        continue
    rule = PathBeneath(handled, dir_fd)
    if syscall(445, ctypes.c_int(fd), ctypes.c_int(1), ctypes.byref(rule), ctypes.c_uint32(0)) != 0:
        fail("adding the rule for %s failed (error %d)" % (p, ctypes.get_errno()))
    os.close(dir_fd)
if libc.prctl(38, 1, 0, 0, 0) != 0:
    fail("no_new_privs could not be set")
if syscall(446, ctypes.c_int(fd), ctypes.c_uint32(0)) != 0:
    fail("enforcing the rules failed (error %d)" % ctypes.get_errno())
os.close(fd)
try:
    os.execvp(sys.argv[2], sys.argv[2:])
except OSError as e:
    sys.stderr.write("sfagents: %s: %s\n" % (sys.argv[2], e.strerror))
    sys.exit(127)
`;

/** The system python3 (a path the sandbox binds read-only), or undefined. */
export function findPython(systemPaths: readonly string[]): string | undefined {
  for (const dir of ['/usr/bin', '/bin', '/usr/local/bin']) {
    const candidate = path.join(dir, 'python3');
    if (!systemPaths.some((s) => candidate === s || candidate.startsWith(`${s}/`))) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/**
 * The command line that runs `argv` with deleting and moving allowed only
 * under `removable` (canonical folders as the sandbox sees them).
 */
export function landlockCommand(python: string, removable: readonly string[], argv: readonly string[]): string[] {
  // -I: isolated (no environment variables, user site or script folder on the path).
  return [python, '-I', '-c', LAUNCHER, JSON.stringify(removable), ...argv];
}
