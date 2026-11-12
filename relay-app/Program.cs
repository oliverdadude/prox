using System.Diagnostics;

namespace RadioRelay;

static class Program
{
    static void Main()
    {
        Console.Title = "Radio Relay";
        Console.WriteLine("Radio Relay — streams your PC audio (minus GMod) to your station.");
        var cfg = Config.Load();
        using var engine = new Engine(cfg);
        var web = new Web(engine);
        var url = $"http://localhost:{web.Port}/";
        Console.WriteLine($"Control panel: {url}");
        Console.WriteLine("Keep this window open while you broadcast. Close it to stop.");
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { /* open it manually */ }

        var quit = new ManualResetEventSlim();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; quit.Set(); };
        AppDomain.CurrentDomain.ProcessExit += (_, _) => quit.Set();
        quit.Wait();
    }
}
