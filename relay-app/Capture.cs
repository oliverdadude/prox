using System.Diagnostics;
using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace RadioRelay;

/// <summary>
/// Records all PC audio except one process tree (GMod), as 48 kHz 16-bit stereo,
/// into a buffer the mixer reads from.
/// </summary>
sealed class ProcessLoopbackCapture : IDisposable
{
    public static readonly WaveFormat Format = new(48000, 16, 2);
    public readonly BufferedWaveProvider Buffer = new(Format)
    {
        BufferDuration = TimeSpan.FromSeconds(1), DiscardOnBufferOverflow = true, ReadFully = true,
    };

    readonly IAudioClient _client;
    readonly IAudioCaptureClient _capture;
    readonly AutoResetEvent _event = new(false);
    readonly Thread _thread;
    volatile bool _running = true;

    const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    const uint AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
    const uint AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000;
    const uint AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000;
    const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;

    public ProcessLoopbackCapture(int excludeProcessId)
    {
        // AUDIOCLIENT_ACTIVATION_PARAMS { ActivationType = PROCESS_LOOPBACK(1),
        //   TargetProcessId, ProcessLoopbackMode = EXCLUDE_TARGET_PROCESS_TREE(1) }
        IntPtr parms = Marshal.AllocHGlobal(12);
        IntPtr propVariant = Marshal.AllocHGlobal(24);
        try
        {
            Marshal.WriteInt32(parms, 0, 1);
            Marshal.WriteInt32(parms, 4, excludeProcessId);
            Marshal.WriteInt32(parms, 8, 1);
            // PROPVARIANT { vt = VT_BLOB(65), blob.cbSize = 12, blob.pBlobData = parms }
            for (int i = 0; i < 24; i += 4) Marshal.WriteInt32(propVariant, i, 0);
            Marshal.WriteInt16(propVariant, 0, 65);
            Marshal.WriteInt32(propVariant, 8, 12);
            Marshal.WriteIntPtr(propVariant, 16, parms);

            var handler = new ActivationHandler();
            NativeAudio.ActivateAudioInterfaceAsync(NativeAudio.ProcessLoopbackDevice, NativeAudio.IID_IAudioClient,
                propVariant, handler, out _);
            if (!handler.Done.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException("Audio activation timed out");
            if (handler.Result < 0 || handler.Client is null) Marshal.ThrowExceptionForHR(handler.Result);
            _client = (IAudioClient)handler.Client!;
        }
        finally
        {
            Marshal.FreeHGlobal(parms);
            Marshal.FreeHGlobal(propVariant);
        }

        var fmt = new WaveFormatEx
        {
            wFormatTag = 1, nChannels = 2, nSamplesPerSec = 48000, wBitsPerSample = 16,
            nBlockAlign = 4, nAvgBytesPerSec = 48000 * 4, cbSize = 0,
        };
        Check(_client.Initialize(0,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            2_000_000, 0, ref fmt, IntPtr.Zero), "Initialize");
        Check(_client.SetEventHandle(_event.SafeWaitHandle.DangerousGetHandle()), "SetEventHandle");
        Check(_client.GetService(NativeAudio.IID_IAudioCaptureClient, out var cap), "GetService");
        _capture = (IAudioCaptureClient)cap;
        Check(_client.Start(), "Start");

        _thread = new Thread(Loop) { IsBackground = true, Name = "ProcessLoopback", Priority = ThreadPriority.AboveNormal };
        _thread.Start();
    }

    static void Check(int hr, string what)
    {
        if (hr < 0) throw new COMException($"{what} failed (0x{hr:X8})", hr);
    }

    void Loop()
    {
        var scratch = new byte[48000 * 4];
        while (_running)
        {
            _event.WaitOne(100);
            while (_running && _capture.GetNextPacketSize(out uint frames) >= 0 && frames > 0)
            {
                if (_capture.GetBuffer(out IntPtr data, out uint n, out uint flags, out _, out _) < 0) break;
                int bytes = (int)n * 4;
                if (bytes > scratch.Length) scratch = new byte[bytes];
                if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) Array.Clear(scratch, 0, bytes);
                else Marshal.Copy(data, scratch, 0, bytes);
                _capture.ReleaseBuffer(n);
                Buffer.AddSamples(scratch, 0, bytes);
            }
        }
    }

    public void Dispose()
    {
        _running = false;
        _event.Set();
        _thread.Join(500);
        try { _client.Stop(); } catch { /* ignore */ }
        Marshal.ReleaseComObject(_capture);
        Marshal.ReleaseComObject(_client);
    }
}

/// <summary>Wraps a NAudio capture (whole-PC loopback or a microphone) as 48 kHz stereo float.</summary>
sealed class DeviceCapture : IDisposable
{
    public readonly BufferedWaveProvider Buffer;
    public readonly ISampleProvider Samples;
    readonly IWaveIn _capture;

    public DeviceCapture(IWaveIn capture)
    {
        _capture = capture;
        Buffer = new BufferedWaveProvider(capture.WaveFormat)
        {
            BufferDuration = TimeSpan.FromSeconds(1), DiscardOnBufferOverflow = true, ReadFully = true,
        };
        capture.DataAvailable += (_, e) => Buffer.AddSamples(e.Buffer, 0, e.BytesRecorded);
        Samples = AudioUtil.ToStereo48k(Buffer.ToSampleProvider());
        capture.StartRecording();
    }

    public static DeviceCapture WholePc() => new(new WasapiLoopbackCapture());

    public static DeviceCapture? DefaultMic()
    {
        using var en = new MMDeviceEnumerator();
        if (!en.HasDefaultAudioEndpoint(DataFlow.Capture, Role.Communications)) return null;
        var dev = en.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications);
        return new DeviceCapture(new WasapiCapture(dev, true, 20)) { MicName = dev.FriendlyName };
    }

    public string MicName { get; init; } = "";

    public void Dispose()
    {
        try { _capture.StopRecording(); } catch { /* ignore */ }
        _capture.Dispose();
    }
}

static class AudioUtil
{
    public static ISampleProvider ToStereo48k(ISampleProvider src)
    {
        if (src.WaveFormat.Channels == 1) src = new MonoToStereoSampleProvider(src);
        else if (src.WaveFormat.Channels > 2) src = new FirstTwoChannels(src);
        if (src.WaveFormat.SampleRate != 48000) src = new WdlResamplingSampleProvider(src, 48000);
        return src;
    }

    /// <summary>Keeps the front left/right of a multichannel (e.g. 5.1) stream.</summary>
    sealed class FirstTwoChannels : ISampleProvider
    {
        readonly ISampleProvider _src;
        readonly int _ch;
        float[] _buf = Array.Empty<float>();
        public FirstTwoChannels(ISampleProvider src)
        {
            _src = src; _ch = src.WaveFormat.Channels;
            WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(src.WaveFormat.SampleRate, 2);
        }
        public WaveFormat WaveFormat { get; }
        public int Read(float[] buffer, int offset, int count)
        {
            int frames = count / 2;
            if (_buf.Length < frames * _ch) _buf = new float[frames * _ch];
            int got = _src.Read(_buf, 0, frames * _ch) / _ch;
            for (int i = 0; i < got; i++)
            {
                buffer[offset + i * 2] = _buf[i * _ch];
                buffer[offset + i * 2 + 1] = _buf[i * _ch + 1];
            }
            return got * 2;
        }
    }

    public static int? FindGmodProcessId()
    {
        foreach (var name in new[] { "gmod", "hl2" })
        {
            var p = Process.GetProcessesByName(name).FirstOrDefault();
            if (p != null) return p.Id;
        }
        return null;
    }
}
