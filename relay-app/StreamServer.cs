using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading.Channels;

namespace RadioRelay;

/// <summary>
/// Fans the live MP3 out to every connected listener. A listener that falls more than
/// ~3 seconds behind (slow connection, hiccup) is skipped forward to live instead of
/// building up an ever-growing delay.
/// </summary>
sealed class StreamHub
{
    public sealed class Client
    {
        public readonly Channel<byte[]> Queue = Channel.CreateUnbounded<byte[]>(new UnboundedChannelOptions { SingleReader = true });
        public long QueuedBytes;
    }

    readonly object _lock = new();
    readonly List<Client> _clients = new();
    public int Peak { get; private set; }
    public int Listeners { get { lock (_lock) return _clients.Count; } }
    /// <summary>Max audio a listener may lag behind, in bytes (set from the bitrate).</summary>
    public long MaxLagBytes { get; set; } = 128_000 / 8 * 3;

    public Client Join()
    {
        var c = new Client();
        lock (_lock) { _clients.Add(c); Peak = Math.Max(Peak, _clients.Count); }
        return c;
    }

    public void Leave(Client c) { lock (_lock) _clients.Remove(c); }

    public void Publish(byte[] data)
    {
        lock (_lock)
        {
            foreach (var c in _clients)
            {
                if (Interlocked.Read(ref c.QueuedBytes) > MaxLagBytes)
                {
                    // too far behind: throw away the backlog so they jump back to live
                    while (c.Queue.Reader.TryRead(out var old)) Interlocked.Add(ref c.QueuedBytes, -old.Length);
                }
                if (c.Queue.Writer.TryWrite(data)) Interlocked.Add(ref c.QueuedBytes, data.Length);
            }
        }
    }
}

/// <summary>
/// Serves /stream.mp3 on 127.0.0.1 so the Cloudflare tunnel can pass it to listeners.
/// Separate from the control panel, which never leaves this PC.
/// </summary>
sealed class StreamServer
{
    readonly StreamHub _hub;
    readonly Func<bool> _isLive;
    readonly TcpListener _listener = null!;
    public int Port { get; }

    public StreamServer(StreamHub hub, Func<bool> isLive)
    {
        _hub = hub; _isLive = isLive;
        for (int port = 7090; port < 7110; port++)
        {
            try { var l = new TcpListener(IPAddress.Loopback, port); l.Start(); _listener = l; Port = port; break; }
            catch (SocketException) { }
        }
        if (Port == 0) throw new Exception("No free port between 7090 and 7109 for the stream.");
        _ = AcceptLoop();
    }

    async Task AcceptLoop()
    {
        while (true)
        {
            var c = await _listener.AcceptTcpClientAsync();
            _ = Task.Run(() => Serve(c));
        }
    }

    async Task Serve(TcpClient client)
    {
        using var _ = client;
        client.NoDelay = true;
        var s = client.GetStream();
        try
        {
            var buf = new byte[8192];
            int len = 0;
            while (len < buf.Length)
            {
                int n = await s.ReadAsync(buf.AsMemory(len));
                if (n == 0) return;
                len += n;
                if (buf.AsSpan(0, len).IndexOf("\r\n\r\n"u8) >= 0) break;
            }
            var first = Encoding.ASCII.GetString(buf, 0, len).Split("\r\n")[0].Split(' ');
            var method = first[0];
            var path = first.Length > 1 ? first[1].Split('?')[0] : "/";

            if ((method != "GET" && method != "HEAD") || path != "/stream.mp3")
            {
                await Write(s, "HTTP/1.0 404 Not Found\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nNot found");
                return;
            }
            if (!_isLive())
            {
                await Write(s, "HTTP/1.0 503 Service Unavailable\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nRadio is offline");
                return;
            }
            await Write(s, "HTTP/1.0 200 OK\r\nContent-Type: audio/mpeg\r\nCache-Control: no-cache, no-store\r\n" +
                           "icy-name: Radio Relay\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n");
            if (method == "HEAD") return;

            var listener = _hub.Join();
            try
            {
                await foreach (var chunk in listener.Queue.Reader.ReadAllAsync())
                {
                    Interlocked.Add(ref listener.QueuedBytes, -chunk.Length);
                    if (!_isLive()) break;
                    await s.WriteAsync(chunk);
                }
            }
            finally { _hub.Leave(listener); }
        }
        catch { /* listener went away */ }
    }

    static Task Write(NetworkStream s, string text) => s.WriteAsync(Encoding.ASCII.GetBytes(text)).AsTask();
}
