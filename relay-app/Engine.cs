using System.Diagnostics;
using NAudio.Wave;

namespace RadioRelay;

/// <summary>
/// Mixes PC audio (minus GMod), mic and announcements, applies volume/bass/soft clip,
/// and streams the result as MP3 to an Icecast-compatible station through ffmpeg.
/// </summary>
sealed class Engine : IDisposable
{
    const int Rate = 48000;
    public Config Cfg { get; }
    public readonly Announcer Announcer = new();

    readonly object _lock = new();
    ProcessLoopbackCapture? _loop;          // everything except GMod
    DeviceCapture? _wholePc;                // fallback: whole PC
    DeviceCapture? _mic;
    int? _excludedPid;
    ISampleProvider? _pcSamples;

    Process? _ffmpeg;
    Stream? _ffIn;
    DateTime _ffStarted;
    bool _wantLive;
    DateTime _nextRetry = DateTime.MinValue;
    bool _legacyIcecast;   // some stations only accept the old SOURCE method

    readonly LowShelf _bassL = new(), _bassR = new();
    float _duck = 1f;
    volatile float _peak;
    readonly Thread _mixThread;
    volatile bool _running = true;
    readonly DateTime _appStart = DateTime.UtcNow;
    DateTime? _liveSince;
    long _bytesSent;

    public string CaptureMode { get; private set; } = "Starting…";
    public string MicStatus { get; private set; } = "Off";
    public string LastError { get; private set; } = "";
    readonly Queue<string> _ffLog = new();

    public Engine(Config cfg)
    {
        Cfg = cfg;
        _mixThread = new Thread(MixLoop) { IsBackground = true, Name = "Mixer", Priority = ThreadPriority.AboveNormal };
        _mixThread.Start();
        new Thread(WatchLoop) { IsBackground = true, Name = "Watcher" }.Start();
        if (cfg.AutoStart && cfg.StationReady) GoLive();
    }

    // ---------------- sources ----------------

    void WatchLoop()
    {
        while (_running)
        {
            try { UpdateSources(); } catch (Exception e) { LastError = "Capture: " + e.Message; }
            try { SuperviseFfmpeg(); } catch (Exception e) { LastError = "Stream: " + e.Message; }
            Thread.Sleep(2000);
        }
    }

    void UpdateSources()
    {
        // PC audio: exclude GMod if running, otherwise exclude ourselves (= capture everything)
        if (Cfg.PcAudio)
        {
            int target = AudioUtil.FindGmodProcessId() ?? Environment.ProcessId;
            bool gmod = target != Environment.ProcessId;
            if (_wholePc == null && (_loop == null || _excludedPid != target))
            {
                try
                {
                    var cap = new ProcessLoopbackCapture(target);
                    lock (_lock)
                    {
                        _loop?.Dispose();
                        _loop = cap;
                        _excludedPid = target;
                        _pcSamples = cap.Buffer.ToSampleProvider();
                    }
                    CaptureMode = gmod ? "Everything except GMod" : "Everything (GMod isn't running)";
                }
                catch (Exception e)
                {
                    // Older Windows: no per-app exclusion. Fall back to whole-PC capture.
                    try
                    {
                        var whole = DeviceCapture.WholePc();
                        lock (_lock)
                        {
                            _loop?.Dispose(); _loop = null;
                            _wholePc = whole;
                            _pcSamples = whole.Samples;
                        }
                        CaptureMode = "Whole PC (this Windows can't leave GMod out — mute GMod or move it to another output)";
                        LastError = "Per-app capture unavailable: " + e.Message;
                    }
                    catch (Exception e2)
                    {
                        CaptureMode = "Can't capture PC audio";
                        LastError = "Capture failed: " + e2.Message;
                    }
                }
            }
            else if (_loop != null)
            {
                CaptureMode = gmod ? "Everything except GMod" : "Everything (GMod isn't running)";
            }
        }
        else if (_loop != null || _wholePc != null)
        {
            lock (_lock)
            {
                _loop?.Dispose(); _loop = null; _excludedPid = null;
                _wholePc?.Dispose(); _wholePc = null;
                _pcSamples = null;
            }
            CaptureMode = "PC audio off";
        }
        else CaptureMode = "PC audio off";

        // Microphone
        if (Cfg.Mic && _mic == null)
        {
            var mic = DeviceCapture.DefaultMic();
            lock (_lock) _mic = mic;
            MicStatus = mic == null ? "No microphone found" : "On: " + mic.MicName;
        }
        else if (!Cfg.Mic && _mic != null)
        {
            lock (_lock) { _mic.Dispose(); _mic = null; }
            MicStatus = "Off";
        }
        else if (!Cfg.Mic) MicStatus = "Off";
    }

    // ---------------- mixing ----------------

    void MixLoop()
    {
        var sw = Stopwatch.StartNew();
        long framesDone = 0;
        float[] pc = new float[Rate], mic = new float[Rate], tts = new float[Rate], mix = new float[Rate];
        byte[] pcm = new byte[Rate * 2];
        while (_running)
        {
            long due = (long)(sw.Elapsed.TotalSeconds * Rate) - framesDone;
            if (due < 960) { Thread.Sleep(5); continue; }          // 20 ms chunks
            if (due > Rate / 2) { framesDone += due - 960; due = 960; } // fell behind (sleep/suspend): skip ahead
            int frames = (int)Math.Min(due, Rate / 4);
            int n = frames * 2;

            lock (_lock)
            {
                ReadSource(_pcSamples, _loop?.Buffer ?? _wholePc?.Buffer, pc, n);
                ReadSource(_mic?.Samples, _mic?.Buffer, mic, n);
            }
            bool speaking = Announcer.Speaking;
            Announcer.Read(tts, n);

            float vol = (float)Cfg.Volume, micVol = (float)Cfg.MicVolume;
            float duckTarget = speaking ? (float)Cfg.DuckTo : 1f;
            _bassL.Set(Cfg.BassDb, Cfg.BassHz, Rate);
            _bassR.Set(Cfg.BassDb, Cfg.BassHz, Rate);
            bool clip = Cfg.SoftClip, bass = Cfg.BassDb > 0.01;
            float peak = 0;

            for (int i = 0; i < n; i += 2)
            {
                _duck += (duckTarget - _duck) * 0.0008f;           // ~25 ms smoothing
                for (int c = 0; c < 2; c++)
                {
                    float s = (pc[i + c] + mic[i + c] * micVol) * _duck;
                    if (bass) s = c == 0 ? _bassL.Process(s) : _bassR.Process(s);
                    s = s * vol + tts[i + c] * 1.6f;
                    s = clip ? SoftClip.Apply(s) : Math.Clamp(s, -1f, 1f);
                    mix[i + c] = s;
                    float a = Math.Abs(s);
                    if (a > peak) peak = a;
                }
            }
            _peak = Math.Max(peak, _peak * 0.9f);

            for (int i = 0; i < n; i++)
            {
                short v = (short)(mix[i] * 32767);
                pcm[i * 2] = (byte)v;
                pcm[i * 2 + 1] = (byte)(v >> 8);
            }
            WritePcm(pcm, n * 2);
            framesDone += frames;
        }
    }

    static void ReadSource(ISampleProvider? samples, BufferedWaveProvider? buffer, float[] dest, int count)
    {
        if (samples == null || buffer == null) { Array.Clear(dest, 0, count); return; }
        // keep latency low: if more than 300 ms has piled up, drop the oldest audio
        int max = buffer.WaveFormat.AverageBytesPerSecond * 3 / 10;
        if (buffer.BufferedBytes > max)
        {
            int drop = buffer.BufferedBytes - buffer.WaveFormat.AverageBytesPerSecond / 10;
            drop -= drop % buffer.WaveFormat.BlockAlign;
            buffer.Read(new byte[drop], 0, drop);
        }
        int got = samples.Read(dest, 0, count);
        if (got < count) Array.Clear(dest, got, count - got);
    }

    // ---------------- streaming ----------------

    public void GoLive() { _wantLive = true; _nextRetry = DateTime.MinValue; SuperviseFfmpeg(); }
    public void GoOffline() { _wantLive = false; StopFfmpeg(); _liveSince = null; }

    void SuperviseFfmpeg()
    {
        if (!_wantLive) return;
        if (_ffmpeg is { HasExited: false }) return;
        if (_ffmpeg != null)
        {
            if ((DateTime.UtcNow - _ffStarted).TotalSeconds < 15) _legacyIcecast = !_legacyIcecast;
            LastError = "Stream dropped: " + (string.Join(" ", _ffLog).Trim() is var log && log != "" ? log : "ffmpeg exited") + " — retrying";
            StopFfmpeg();
            _nextRetry = DateTime.UtcNow.AddSeconds(5);
        }
        if (DateTime.UtcNow < _nextRetry) return;
        if (!Cfg.StationReady) { LastError = "Fill in your station settings first."; _wantLive = false; return; }
        StartFfmpeg();
    }

    void StartFfmpeg()
    {
        var exe = Path.Combine(AppContext.BaseDirectory, "ffmpeg.exe");
        if (!File.Exists(exe)) { LastError = "ffmpeg.exe is missing — keep it in the same folder as RadioRelay.exe."; _wantLive = false; return; }
        var mount = Cfg.Mount.StartsWith('/') ? Cfg.Mount : "/" + Cfg.Mount;
        var url = $"icecast://{Uri.EscapeDataString(Cfg.User)}:{Uri.EscapeDataString(Cfg.Password)}@{Cfg.Host}:{Cfg.Port}{mount}";
        var psi = new ProcessStartInfo(exe)
        {
            UseShellExecute = false, RedirectStandardInput = true, RedirectStandardError = true, CreateNoWindow = true,
        };
        foreach (var a in new[]
        {
            "-hide_banner", "-loglevel", "error",
            "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0",
            "-c:a", "libmp3lame", "-b:a", $"{Math.Clamp(Cfg.Bitrate, 64, 320)}k",
            "-content_type", "audio/mpeg", "-ice_name", "Radio Relay",
            "-legacy_icecast", _legacyIcecast ? "1" : "0",
            "-f", "mp3", url,
        }) psi.ArgumentList.Add(a);


        _ffLog.Clear();
        var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
        p.ErrorDataReceived += (_, e) =>
        {
            if (string.IsNullOrWhiteSpace(e.Data)) return;
            lock (_ffLog) { _ffLog.Enqueue(e.Data.Replace(Cfg.Password, "***")); while (_ffLog.Count > 3) _ffLog.Dequeue(); }
        };
        p.Start();
        p.BeginErrorReadLine();
        _ffmpeg = p;
        _ffIn = p.StandardInput.BaseStream;
        _ffStarted = DateTime.UtcNow;
        _liveSince = DateTime.UtcNow;
        LastError = "";
    }

    void WritePcm(byte[] data, int count)
    {
        var s = _ffIn;
        if (s == null) return;
        try { s.Write(data, 0, count); s.Flush(); Interlocked.Add(ref _bytesSent, count); }
        catch { _ffIn = null; } // pipe broke; the watcher restarts ffmpeg
    }

    void StopFfmpeg()
    {
        var p = _ffmpeg;
        _ffIn = null; _ffmpeg = null;
        if (p == null) return;
        try { p.StandardInput.Close(); } catch { /* ignore */ }
        try { if (!p.WaitForExit(1500)) p.Kill(true); } catch { /* ignore */ }
        p.Dispose();
    }

    // ---------------- status ----------------

    public object Status()
    {
        bool live = _ffmpeg is { HasExited: false } && (DateTime.UtcNow - _ffStarted).TotalSeconds > 2;
        double peakDb = _peak <= 0.00001 ? -60 : Math.Max(-60, 20 * Math.Log10(_peak));
        return new
        {
            live,
            connecting = _wantLive && !live,
            wantLive = _wantLive,
            onAirSeconds = live && _liveSince.HasValue ? (int)(DateTime.UtcNow - _liveSince.Value).TotalSeconds : 0,
            peakDb = Math.Round(peakDb, 1),
            captureMode = CaptureMode,
            gmodRunning = AudioUtil.FindGmodProcessId() != null,
            micStatus = MicStatus,
            announcementsQueued = Announcer.Queued,
            lastError = LastError,
            ffmpegLog = string.Join(" | ", _ffLog),
            uptimeSeconds = (int)(DateTime.UtcNow - _appStart).TotalSeconds,
        };
    }

    public void Dispose()
    {
        _running = false;
        StopFfmpeg();
        _loop?.Dispose();
        _wholePc?.Dispose();
        _mic?.Dispose();
    }
}
