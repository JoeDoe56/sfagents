using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Principal;
using System.Text.Json;
using LibreHardwareMonitor.Hardware;

// This executable only returns sensor snapshots. It has no command execution,
// HTTP listener, fan controls or access to the agent's credentials.
internal static class Program
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private sealed record Reading(string HardwareId, string Hardware, string Id, string Name, string Type, float? Value);

    public static async Task<int> Main(string[] args)
    {
        try
        {
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Windows sensor adapter only.");
            if (args.Length == 2 && args[0] == "--pipe-worker" && args[1].StartsWith("sfagents-sensors-"))
            {
                using var pipe = new NamedPipeClientStream(".", args[1], PipeDirection.InOut, PipeOptions.Asynchronous);
                await pipe.ConnectAsync(60_000);
                using var input = new StreamReader(pipe);
                using var output = new StreamWriter(pipe) { AutoFlush = true };
                await Serve(input, output);
            }
            else if (args.SequenceEqual(new[] { "--elevate" }) && !IsAdministrator())
            {
                await Broker();
            }
            else if (args.Length == 0 || args.SequenceEqual(new[] { "--elevate" }))
            {
                await Serve(Console.In, Console.Out);
            }
            else throw new ArgumentException("Unsupported sensor helper argument.");
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"Windows sensors: {e.Message}");
            return 1;
        }
    }

    private static bool IsAdministrator() => new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);

    // Only the optional sensor worker elevates; the broker and SF Agents stay
    // unprivileged. The pipe is restricted to this Windows account, including
    // its elevated token, and disappears when the broker exits.
    private static async Task Broker()
    {
        var name = "sfagents-sensors-" + Guid.NewGuid().ToString("N");
        using var pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        var info = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden };
        info.ArgumentList.Add("--pipe-worker");
        info.ArgumentList.Add(name);
        using var worker = Process.Start(info) ?? throw new IOException("Could not start the sensor worker.");
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        await pipe.WaitForConnectionAsync(timeout.Token);
        using var input = new StreamReader(pipe);
        using var output = new StreamWriter(pipe) { AutoFlush = true };
        while (await Console.In.ReadLineAsync() is { } request)
        {
            if (request != "read") throw new InvalidDataException("Unsupported sensor request.");
            await output.WriteLineAsync(request);
            var response = await input.ReadLineAsync() ?? throw new EndOfStreamException("Sensor worker stopped.");
            await Console.Out.WriteLineAsync(response);
            await Console.Out.FlushAsync();
        }
        // Disposing the pipe delivers EOF, so the elevated worker closes LHM.
    }

    private static async Task Serve(TextReader input, TextWriter output)
    {
        var computer = new Computer
        {
            IsCpuEnabled = true, IsGpuEnabled = true, IsMemoryEnabled = true,
            IsStorageEnabled = true, IsNetworkEnabled = true, IsPsuEnabled = true,
        };
        try
        {
            computer.Open();
            var warmed = false;
            while (await input.ReadLineAsync() is { } request)
            {
                if (request != "read") throw new InvalidDataException("Unsupported sensor request.");
                if (!warmed)
                {
                    foreach (var hardware in computer.Hardware) Update(hardware, new List<Reading>());
                    await Task.Delay(400);
                    warmed = true;
                }
                var readings = new List<Reading>();
                foreach (var hardware in computer.Hardware) Update(hardware, readings);
                var hasCpuTemperature = readings.Any(s => s.HardwareId.Contains("cpu/") && s.Type == "Temperature" && s.Value.HasValue);
                string? hint = hasCpuTemperature ? null : IsAdministrator()
                    ? "CPU temperature is unavailable. Install the signed PawnIO driver if it is missing; some hardware may not expose this sensor."
                    : "CPU temperatures need administrator access to the sensor helper. Start with --sensor-admin to show the Windows permission prompt.";
                await output.WriteLineAsync(JsonSerializer.Serialize(new { sensors = readings, processes = CountProcesses(), hint }, Json));
                await output.FlushAsync();
            }
        }
        finally { computer.Close(); }
    }

    private static int? CountProcesses()
    {
        try
        {
            var processes = Process.GetProcesses();
            var count = processes.Length;
            foreach (var process in processes) process.Dispose();
            return count;
        }
        catch { return null; }
    }

    private static void Update(IHardware hardware, List<Reading> readings)
    {
        hardware.Update();
        foreach (var sensor in hardware.Sensors)
        {
            var value = sensor.Value;
            if (value.HasValue && !float.IsFinite(value.Value)) value = null;
            // LHM 0.9.6 mixes units: RAM Data is GiB, GPU SmallData is MiB,
            // while storage/network Data counters are already bytes.
            var type = sensor.SensorType.ToString();
            if (type == "SmallData" && value.HasValue) value *= 1024 * 1024;
            else if (type == "Data" && value.HasValue && hardware.Identifier.ToString() is "/ram" or "/vram") value *= 1024 * 1024 * 1024;
            readings.Add(new(hardware.Identifier.ToString(), hardware.Name, sensor.Identifier.ToString(),
                sensor.Name, type == "SmallData" ? "Data" : type, value));
        }
        foreach (var subhardware in hardware.SubHardware) Update(subhardware, readings);
    }
}
