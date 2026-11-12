using System.Text.Json;

namespace RadioRelay;

sealed class Config
{
    // Station (Icecast-compatible, e.g. Zeno.fm "encoder settings")
    public string Host { get; set; } = "";
    public int Port { get; set; } = 80;
    public string Mount { get; set; } = "";
    public string User { get; set; } = "source";
    public string Password { get; set; } = "";
    public int Bitrate { get; set; } = 128;
    public string ListenUrl { get; set; } = "";   // the station's public stream URL
    public string RadioLink { get; set; } = "";   // short .pls link from the website

    // Sound
    public bool PcAudio { get; set; } = true;
    public bool Mic { get; set; }
    public double Volume { get; set; } = 1.0;     // 1.0 = 100%, up to 5.0
    public double MicVolume { get; set; } = 1.0;
    public double BassDb { get; set; }
    public double BassHz { get; set; } = 100;
    public bool SoftClip { get; set; } = true;

    // Announcements
    public string Voice { get; set; } = "";
    public int VoiceRate { get; set; }            // -10..10
    public double DuckTo { get; set; } = 0.25;    // music level while speaking

    public bool AutoStart { get; set; }

    static string Dir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "RadioRelay");
    static string FilePath => Path.Combine(Dir, "config.json");
    static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    public static Config Load()
    {
        try { return JsonSerializer.Deserialize<Config>(File.ReadAllText(FilePath)) ?? new(); }
        catch { return new(); }
    }

    public void Save()
    {
        Directory.CreateDirectory(Dir);
        File.WriteAllText(FilePath, JsonSerializer.Serialize(this, Json));
    }

    public bool StationReady => Host != "" && Mount != "" && Password != "";
}
