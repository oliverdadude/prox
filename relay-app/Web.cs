using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Text.Json;

namespace RadioRelay;

/// <summary>Tiny HTTP server on 127.0.0.1 for the control panel (no admin rights needed).</summary>
sealed class Web
{
    readonly Engine _engine;
    readonly TcpListener _listener;
    public int Port { get; }
    static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(15) };
    static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    List<string>? _voices;

    public Web(Engine engine)
    {
        _engine = engine;
        for (int port = 7070; port < 7090; port++)
        {
            try
            {
                var l = new TcpListener(IPAddress.Loopback, port);
                l.Start();
                _listener = l; Port = port;
                break;
            }
            catch (SocketException) { }
        }
        if (_listener == null) throw new Exception("No free port between 7070 and 7089 for the control panel.");
        _ = AcceptLoop();
    }

    async Task AcceptLoop()
    {
        while (true)
        {
            var client = await _listener.AcceptTcpClientAsync();
            _ = Task.Run(() => Handle(client));
        }
    }

    async Task Handle(TcpClient client)
    {
        using var _ = client;
        try
        {
            var stream = client.GetStream();
            var (method, path, headers, body) = await ReadRequest(stream);
            if (method == "") return;
            // Only answer requests addressed to this machine (blocks DNS-rebinding tricks).
            var host = headers.GetValueOrDefault("host", "");
            if (!host.StartsWith("localhost:") && !host.StartsWith("127.0.0.1:")) { await Send(stream, 403, "text/plain", "Forbidden"); return; }
            // Websites can't add custom headers to cross-site requests without permission, so this
            // stops other pages you visit from controlling the relay.
            if (method == "POST" && headers.GetValueOrDefault("x-relay") != "1") { await Send(stream, 403, "text/plain", "Forbidden"); return; }

            switch (method, path)
            {
                case ("GET", "/"):
                    await Send(stream, 200, "text/html; charset=utf-8", Panel());
                    break;
                case ("GET", "/api/status"):
                    await SendJson(stream, new { status = _engine.Status(), config = PublicConfig(), voices = _voices ??= Announcer.Voices(), port = Port });
                    break;
                case ("POST", "/api/config"):
                    ApplyConfig(body);
                    await SendJson(stream, new { ok = true, config = PublicConfig() });
                    break;
                case ("POST", "/api/live"):
                    var on = JsonDocument.Parse(body).RootElement.GetProperty("on").GetBoolean();
                    if (on) _engine.GoLive(); else _engine.GoOffline();
                    await SendJson(stream, new { ok = true });
                    break;
                case ("POST", "/api/announce"):
                    var text = JsonDocument.Parse(body).RootElement.GetProperty("text").GetString()?.Trim() ?? "";
                    if (text.Length is 0 or > 500) { await SendJson(stream, new { error = "Type 1–500 characters." }, 400); break; }
                    await _engine.Announcer.Say(text, _engine.Cfg.Voice, _engine.Cfg.VoiceRate);
                    await SendJson(stream, new { ok = true });
                    break;
                case ("POST", "/api/announce/stop"):
                    _engine.Announcer.Clear();
                    await SendJson(stream, new { ok = true });
                    break;
                case ("POST", "/api/radiolink"):
                    await MakeRadioLink(stream);
                    break;
                default:
                    await Send(stream, 404, "text/plain", "Not found");
                    break;
            }
        }
        catch (Exception e)
        {
            try { await Send(client.GetStream(), 500, "application/json", JsonSerializer.Serialize(new { error = e.Message })); } catch { /* ignore */ }
        }
    }

    async Task MakeRadioLink(NetworkStream stream)
    {
        var url = _engine.Cfg.ListenUrl.Trim();
        if (!url.StartsWith("http")) { await SendJson(stream, new { error = "Paste your station's public stream URL first." }, 400); return; }
        var res = await Http.GetAsync("https://gmod-radio-linker.vercel.app/api/short?url=" + Uri.EscapeDataString(url));
        var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync()).RootElement;
        if (!res.IsSuccessStatusCode || !doc.TryGetProperty("link", out var link))
        {
            await SendJson(stream, new { error = doc.TryGetProperty("error", out var e) ? e.GetString() : "Couldn't make a link" }, 400);
            return;
        }
        _engine.Cfg.RadioLink = link.GetString() ?? "";
        _engine.Cfg.Save();
        await SendJson(stream, new { link = _engine.Cfg.RadioLink });
    }

    object PublicConfig()
    {
        var c = _engine.Cfg;
        return new
        {
            c.Host, c.Port, c.Mount, c.User, hasPassword = c.Password != "", c.Bitrate, c.ListenUrl, c.RadioLink,
            c.PcAudio, c.Mic, c.Volume, c.MicVolume, c.BassDb, c.BassHz, c.SoftClip,
            c.Voice, c.VoiceRate, c.DuckTo, c.AutoStart,
        };
    }

    void ApplyConfig(string body)
    {
        var c = _engine.Cfg;
        foreach (var p in JsonDocument.Parse(body).RootElement.EnumerateObject())
        {
            var v = p.Value;
            switch (p.Name)
            {
                case "host": c.Host = (v.GetString() ?? "").Trim().Replace("http://", "").Replace("https://", "").TrimEnd('/'); break;
                case "port": c.Port = Math.Clamp(v.GetInt32(), 1, 65535); break;
                case "mount": c.Mount = (v.GetString() ?? "").Trim(); break;
                case "user": c.User = (v.GetString() ?? "").Trim(); break;
                case "password": if (!string.IsNullOrEmpty(v.GetString())) c.Password = v.GetString()!; break;
                case "bitrate": c.Bitrate = Math.Clamp(v.GetInt32(), 64, 320); break;
                case "listenUrl": c.ListenUrl = (v.GetString() ?? "").Trim(); c.RadioLink = ""; break;
                case "pcAudio": c.PcAudio = v.GetBoolean(); break;
                case "mic": c.Mic = v.GetBoolean(); break;
                case "volume": c.Volume = Math.Clamp(v.GetDouble(), 0, 5); break;
                case "micVolume": c.MicVolume = Math.Clamp(v.GetDouble(), 0, 5); break;
                case "bassDb": c.BassDb = Math.Clamp(v.GetDouble(), 0, 24); break;
                case "bassHz": c.BassHz = Math.Clamp(v.GetDouble(), 40, 250); break;
                case "softClip": c.SoftClip = v.GetBoolean(); break;
                case "voice": c.Voice = v.GetString() ?? ""; break;
                case "voiceRate": c.VoiceRate = Math.Clamp(v.GetInt32(), -10, 10); break;
                case "duckTo": c.DuckTo = Math.Clamp(v.GetDouble(), 0, 1); break;
                case "autoStart": c.AutoStart = v.GetBoolean(); break;
            }
        }
        c.Save();
    }

    static string? _panel;
    static string Panel()
    {
        if (_panel != null) return _panel;
        using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("panel.html")!;
        using var r = new StreamReader(s);
        return _panel = r.ReadToEnd();
    }

    static async Task<(string, string, Dictionary<string, string>, string)> ReadRequest(NetworkStream stream)
    {
        var buf = new byte[65536];
        int len = 0, headerEnd = -1;
        while (headerEnd < 0)
        {
            int n = await stream.ReadAsync(buf.AsMemory(len, buf.Length - len));
            if (n == 0) return ("", "", new(), "");
            len += n;
            headerEnd = IndexOf(buf, len, "\r\n\r\n"u8);
            if (len == buf.Length && headerEnd < 0) return ("", "", new(), "");
        }
        var head = Encoding.ASCII.GetString(buf, 0, headerEnd).Split("\r\n");
        var first = head[0].Split(' ');
        var headers = head.Skip(1).Select(h => h.Split(':', 2)).Where(h => h.Length == 2)
            .GroupBy(h => h[0].Trim().ToLowerInvariant()).ToDictionary(g => g.Key, g => g.First()[1].Trim());
        int contentLength = headers.TryGetValue("content-length", out var cl) && int.TryParse(cl, out var x) ? Math.Min(x, 60000) : 0;
        int bodyStart = headerEnd + 4;
        while (len - bodyStart < contentLength)
        {
            int n = await stream.ReadAsync(buf.AsMemory(len, buf.Length - len));
            if (n == 0) break;
            len += n;
        }
        var body = Encoding.UTF8.GetString(buf, bodyStart, Math.Max(0, Math.Min(contentLength, len - bodyStart)));
        var path = first.Length > 1 ? first[1].Split('?')[0] : "/";
        return (first[0], path, headers, body);
    }

    static int IndexOf(byte[] buf, int len, ReadOnlySpan<byte> pattern) => buf.AsSpan(0, len).IndexOf(pattern);

    static Task SendJson(NetworkStream s, object o, int code = 200) => Send(s, code, "application/json", JsonSerializer.Serialize(o, Json));

    static async Task Send(NetworkStream s, int code, string type, string body)
    {
        var bytes = Encoding.UTF8.GetBytes(body);
        var head = $"HTTP/1.1 {code} {(code == 200 ? "OK" : "Error")}\r\nContent-Type: {type}\r\nContent-Length: {bytes.Length}\r\n" +
                   "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nConnection: close\r\n\r\n";
        await s.WriteAsync(Encoding.ASCII.GetBytes(head));
        await s.WriteAsync(bytes);
    }
}
