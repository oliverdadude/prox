using System.Collections.Concurrent;
using System.Speech.AudioFormat;
using System.Speech.Synthesis;

namespace RadioRelay;

/// <summary>Turns typed text into speech (installed Windows voices) and plays it into the mix.</summary>
sealed class Announcer
{
    readonly ConcurrentQueue<float[]> _queue = new();
    float[]? _current;
    int _pos;

    public int Queued => _queue.Count + (_current != null ? 1 : 0);
    public bool Speaking => _current != null || !_queue.IsEmpty;

    public static List<string> Voices()
    {
        try
        {
            using var s = new SpeechSynthesizer();
            return s.GetInstalledVoices().Where(v => v.Enabled).Select(v => v.VoiceInfo.Name).ToList();
        }
        catch { return new(); }
    }

    public Task Say(string text, string voice, int rate) => Task.Run(() =>
    {
        using var synth = new SpeechSynthesizer();
        if (voice != "") { try { synth.SelectVoice(voice); } catch { /* fall back to default voice */ } }
        synth.Rate = Math.Clamp(rate, -10, 10);
        using var ms = new MemoryStream();
        synth.SetOutputToAudioStream(ms, new SpeechAudioFormatInfo(48000, AudioBitsPerSample.Sixteen, AudioChannel.Stereo));
        synth.Speak(text);
        var bytes = ms.ToArray();
        var samples = new float[bytes.Length / 2];
        for (int i = 0; i < samples.Length; i++) samples[i] = BitConverter.ToInt16(bytes, i * 2) / 32768f;
        // short lead-in so the music has time to duck
        var padded = new float[samples.Length + 48000 / 4 * 2];
        Array.Copy(samples, 0, padded, 48000 / 4 * 2, samples.Length);
        _queue.Enqueue(padded);
    });

    /// <summary>Reads interleaved stereo samples; returns how many were real speech (rest is silence).</summary>
    public void Read(float[] buf, int count)
    {
        int i = 0;
        while (i < count)
        {
            if (_current == null && !_queue.TryDequeue(out _current)) break;
            int n = Math.Min(count - i, _current!.Length - _pos);
            Array.Copy(_current, _pos, buf, i, n);
            i += n; _pos += n;
            if (_pos >= _current.Length) { _current = null; _pos = 0; }
        }
        if (i < count) Array.Clear(buf, i, count - i);
    }

    public void Clear() { _queue.Clear(); _current = null; _pos = 0; }
}
