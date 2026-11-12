using System.Diagnostics;
using System.Text.RegularExpressions;

namespace RadioRelay;

/// <summary>
/// Runs a free Cloudflare "quick tunnel" (cloudflared.exe, no account) that gives the
/// local stream a public https://….trycloudflare.com address. The address changes on
/// every start, so the engine re-points the permanent /r/ link each time.
/// </summary>
sealed class Tunnel
{
    Process? _p;
    public string? PublicBase { get; private set; }
    public string Status { get; private set; } = "Off";
    public event Action<string>? UrlReady;
    static readonly Regex UrlRx = new(@"https://[a-z0-9-]+\.trycloudflare\.com", RegexOptions.Compiled);

    public bool Running => _p is { HasExited: false };

    public void Start(int localPort)
    {
        if (Running) return;
        var exe = Path.Combine(AppContext.BaseDirectory, "cloudflared.exe");
        if (!File.Exists(exe)) { Status = "cloudflared.exe is missing — keep it next to RadioRelay.exe"; return; }
        PublicBase = null;
        Status = "Connecting to Cloudflare…";
        var psi = new ProcessStartInfo(exe)
        {
            UseShellExecute = false, RedirectStandardError = true, RedirectStandardOutput = true, CreateNoWindow = true,
        };
        foreach (var a in new[] { "tunnel", "--no-autoupdate", "--url", $"http://127.0.0.1:{localPort}" }) psi.ArgumentList.Add(a);
        var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
        DataReceivedEventHandler onLine = (_, e) =>
        {
            if (e.Data == null || PublicBase != null) return;
            var m = UrlRx.Match(e.Data);
            if (!m.Success || m.Value.StartsWith("https://api.")) return;
            PublicBase = m.Value;
            Status = "Online";
            UrlReady?.Invoke(PublicBase);
        };
        p.ErrorDataReceived += onLine;
        p.OutputDataReceived += onLine;
        p.Exited += (_, _) => { Status = "Tunnel closed"; PublicBase = null; };
        p.Start();
        p.BeginErrorReadLine();
        p.BeginOutputReadLine();
        _p = p;
    }

    public void Stop()
    {
        var p = _p; _p = null; PublicBase = null; Status = "Off";
        if (p == null) return;
        try { if (!p.HasExited) p.Kill(true); } catch { /* ignore */ }
        p.Dispose();
    }
}
