using System.Collections.Concurrent;
using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

// Push-to-talk's keyboard on Windows: it watches for the hotkey with a
// low-level keyboard hook and types transcripts into the focused window with
// SendInput. It records nothing and runs nothing; SF Agents does the
// recording and the speech to text (web/src/push-to-talk.ts).
//
// The protocol is one line each way:
//   in:  "hotkey <vk> <mods>"  (mods: 1 Ctrl, 2 Alt, 4 Shift, 8 Win; vk 0 = off)
//        "type <base64 UTF-8>"
//   out: "ready", "down", "up", "typed", "error <message>" (a "type" failed),
//        "warning <message>"
//
// Started by the administrator approval at startup (web/src/privileges.ts),
// it runs elevated so that its hook sees the hotkey and its typing reaches
// apps that run as administrator too (Windows keeps unelevated input out of
// them). Without the approval it runs at the user's level.
internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        try
        {
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Windows only.");
            if (args.Length == 2 && args[0] == "--pipe-worker" && IsPipeName(args[1]))
            {
                // As the sensor worker does (web/native/windows/Program.cs):
                // the pipe's owner must be this Windows account.
                using var pipe = new NamedPipeClientStream(".", args[1], PipeDirection.InOut, PipeOptions.Asynchronous);
                await pipe.ConnectAsync(120_000);
                var owner = pipe.GetAccessControl().GetOwner(typeof(SecurityIdentifier));
                if (owner is null || !owner.Equals(WindowsIdentity.GetCurrent().User))
                    throw new UnauthorizedAccessException("The input pipe belongs to another account.");
                using var input = new StreamReader(pipe);
                using var output = new StreamWriter(pipe) { AutoFlush = true };
                await Serve(input, output);
            }
            else if (args.Length == 2 && args[0] == "--broker" && IsPipeName(args[1]))
            {
                await Broker(args[1]);
            }
            else if (args.Length == 0)
            {
                await Serve(Console.In, Console.Out);
            }
            else throw new ArgumentException("Unsupported argument.");
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"Push-to-talk input: {e.Message}");
            return 1;
        }
    }

    private static bool IsPipeName(string name) =>
        name.StartsWith("sfagents-input-") && name.Length <= 64 && name.All(c => char.IsAsciiLetterOrDigit(c) || c == '-');

    // Unelevated: relays lines between SF Agents (stdin/stdout) and the
    // elevated worker, over a pipe restricted to this Windows account.
    private static async Task Broker(string name)
    {
        using var pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        await pipe.WaitForConnectionAsync();
        using var input = new StreamReader(pipe);
        using var output = new StreamWriter(pipe) { AutoFlush = true };
        var up = Task.Run(async () =>
        {
            while (await Console.In.ReadLineAsync() is { } line) await output.WriteLineAsync(line);
        });
        var down = Task.Run(async () =>
        {
            while (await input.ReadLineAsync() is { } line)
            {
                await Console.Out.WriteLineAsync(line);
                await Console.Out.FlushAsync();
            }
        });
        // Either side closing ends both: disposing the pipe tells the worker.
        await Task.WhenAny(up, down);
    }

    private static readonly BlockingCollection<string> Events = new();

    private static async Task Serve(TextReader input, TextWriter output)
    {
        var hook = new Thread(Keyboard.Run) { IsBackground = true, Name = "keyboard hook" };
        hook.Start();
        Keyboard.Ready.Wait();
        var writer = Task.Run(async () =>
        {
            foreach (var e in Events.GetConsumingEnumerable())
            {
                await output.WriteLineAsync(e);
                await output.FlushAsync();
            }
        });
        Events.Add("ready");
        while (await input.ReadLineAsync() is { } line)
        {
            var space = line.IndexOf(' ');
            var command = space < 0 ? line : line[..space];
            var rest = space < 0 ? "" : line[(space + 1)..];
            try
            {
                switch (command)
                {
                    case "hotkey":
                        var parts = rest.Split(' ');
                        if (parts.Length != 2 || !int.TryParse(parts[0], out var vk) || !int.TryParse(parts[1], out var mods) || vk < 0 || vk > 255 || mods < 0 || mods > 15)
                            throw new InvalidDataException("Bad hotkey.");
                        Keyboard.SetHotkey(vk, mods);
                        break;
                    case "type":
                        var text = Encoding.UTF8.GetString(Convert.FromBase64String(rest));
                        await Keyboard.WaitForModifiersUp(TimeSpan.FromSeconds(3));
                        Keyboard.Type(text);
                        Events.Add("typed");
                        break;
                    default:
                        throw new InvalidDataException("Unsupported request.");
                }
            }
            catch (Exception e)
            {
                Events.Add($"{(command == "type" ? "error" : "warning")} {e.Message.ReplaceLineEndings(" ")}");
            }
        }
        Events.CompleteAdding();
        await writer;
    }

    private static class Keyboard
    {
        public static readonly ManualResetEventSlim Ready = new();

        private const int WH_KEYBOARD_LL = 13;
        private const int WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_SYSKEYDOWN = 0x0104, WM_SYSKEYUP = 0x0105;
        private const uint LLKHF_INJECTED = 0x10;
        private const int VK_LSHIFT = 0xA0, VK_RSHIFT = 0xA1, VK_LCONTROL = 0xA2, VK_RCONTROL = 0xA3, VK_LMENU = 0xA4, VK_RMENU = 0xA5, VK_LWIN = 0x5B, VK_RWIN = 0x5C;
        private const int VK_RETURN = 0x0D, VK_TAB = 0x09;

        private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
        // Kept in a field: the hook calls it for as long as the program runs.
        private static readonly HookProc Proc = OnKey;
        private static volatile int hotVk;
        private static volatile int hotMods;
        private static bool active;
        // Keys that are down, as the hook saw them (the hook runs on one thread).
        private static readonly bool[] Down = new bool[256];

        public static void SetHotkey(int vk, int mods)
        {
            hotVk = vk;
            hotMods = mods;
        }

        public static void Run()
        {
            var hook = SetWindowsHookEx(WH_KEYBOARD_LL, Proc, GetModuleHandle(null), 0);
            Ready.Set();
            if (hook == IntPtr.Zero)
            {
                Events.Add($"warning The keyboard hook could not be installed ({new Win32Exception(Marshal.GetLastWin32Error()).Message}).");
                Thread.Sleep(500);
                Environment.Exit(1);
            }
            while (GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
        }

        // From Windows' own key state, not from what the hook saw: a key let go
        // on the secure desktop (Win+L, Ctrl+Alt+Del) never reaches the hook.
        private static int Modifiers()
        {
            static bool Held(int vk) => (GetAsyncKeyState(vk) & 0x8000) != 0;
            var m = 0;
            if (Held(VK_LCONTROL) || Held(VK_RCONTROL)) m |= 1;
            if (Held(VK_LMENU) || Held(VK_RMENU)) m |= 2;
            if (Held(VK_LSHIFT) || Held(VK_RSHIFT)) m |= 4;
            if (Held(VK_LWIN) || Held(VK_RWIN)) m |= 8;
            return m;
        }

        /** The modifier bit a key is, so that a hotkey of a right-hand modifier alone does not count itself. */
        private static int ModifierBit(int vk) => vk switch
        {
            VK_LCONTROL or VK_RCONTROL => 1,
            VK_LMENU or VK_RMENU => 2,
            VK_LSHIFT or VK_RSHIFT => 4,
            VK_LWIN or VK_RWIN => 8,
            _ => 0,
        };

        private static IntPtr OnKey(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0)
            {
                var info = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
                var vk = (int)(info.vkCode & 0xFF);
                var msg = (int)wParam;
                var isDown = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                var isUp = msg == WM_KEYUP || msg == WM_SYSKEYUP;
                // Our own typing is not the user's.
                if ((info.flags & LLKHF_INJECTED) == 0)
                {
                    var wasDown = Down[vk];
                    if (isDown) Down[vk] = true;
                    if (isUp) Down[vk] = false;
                    var hot = hotVk;
                    if (hot != 0 && vk == hot)
                    {
                        if (isDown && !wasDown && !active && (Modifiers() & ~ModifierBit(vk)) == hotMods)
                        {
                            active = true;
                            Events.Add("down");
                            return 1;
                        }
                        if (isDown && active) return 1; // auto-repeat while held
                        if (isUp && active)
                        {
                            active = false;
                            Events.Add("up");
                            return 1;
                        }
                    }
                }
            }
            return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
        }

        public static async Task WaitForModifiersUp(TimeSpan limit)
        {
            // Typed while Ctrl or Alt is still held, the letters would be shortcuts.
            var until = DateTime.UtcNow + limit;
            while (Modifiers() != 0 && DateTime.UtcNow < until) await Task.Delay(20);
        }

        public static void Type(string text)
        {
            var inputs = new List<INPUT>();
            foreach (var ch in text.Replace("\r\n", "\n"))
            {
                if (ch == '\n' || ch == '\r') AddVk(inputs, VK_RETURN);
                else if (ch == '\t') AddVk(inputs, VK_TAB);
                else
                {
                    inputs.Add(Unicode(ch, false));
                    inputs.Add(Unicode(ch, true));
                }
            }
            const int chunk = 256;
            for (var i = 0; i < inputs.Count; i += chunk)
            {
                var batch = inputs.Skip(i).Take(chunk).ToArray();
                var sent = SendInput((uint)batch.Length, batch, Marshal.SizeOf<INPUT>());
                if (sent != batch.Length)
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "The text could not be typed into that window");
            }
        }

        private static void AddVk(List<INPUT> inputs, int vk)
        {
            inputs.Add(new INPUT { type = 1, U = new InputUnion { ki = new KEYBDINPUT { wVk = (ushort)vk } } });
            inputs.Add(new INPUT { type = 1, U = new InputUnion { ki = new KEYBDINPUT { wVk = (ushort)vk, dwFlags = 0x0002 } } });
        }

        private static INPUT Unicode(char ch, bool up) =>
            new() { type = 1, U = new InputUnion { ki = new KEYBDINPUT { wScan = ch, dwFlags = 0x0004 | (up ? 0x0002u : 0) } } };

        [StructLayout(LayoutKind.Sequential)]
        private struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        private struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int ptX, ptY; }

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT { public uint type; public InputUnion U; }

        // The union's size is its largest member's (MOUSEINPUT), as SendInput expects.
        [StructLayout(LayoutKind.Explicit)]
        private struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll")]
        private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

        [DllImport("user32.dll")]
        private static extern bool TranslateMessage(ref MSG lpMsg);

        [DllImport("user32.dll")]
        private static extern IntPtr DispatchMessage(ref MSG lpMsg);

        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int vKey);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern IntPtr GetModuleHandle(string? lpModuleName);
    }
}
