namespace RadioRelay;

/// <summary>RBJ low-shelf filter for bass boost, one per channel.</summary>
sealed class LowShelf
{
    double b0 = 1, b1, b2, a1, a2, x1, x2, y1, y2;
    double _db = double.NaN, _hz = double.NaN;

    public void Set(double db, double hz, double sampleRate)
    {
        if (db == _db && hz == _hz) return;
        _db = db; _hz = hz;
        double A = Math.Pow(10, db / 40), w0 = 2 * Math.PI * hz / sampleRate;
        double cos = Math.Cos(w0), alpha = Math.Sin(w0) / 2 * Math.Sqrt(2), sq = 2 * Math.Sqrt(A) * alpha;
        double a0 = (A + 1) + (A - 1) * cos + sq;
        b0 = A * ((A + 1) - (A - 1) * cos + sq) / a0;
        b1 = 2 * A * ((A - 1) - (A + 1) * cos) / a0;
        b2 = A * ((A + 1) - (A - 1) * cos - sq) / a0;
        a1 = -2 * ((A - 1) + (A + 1) * cos) / a0;
        a2 = ((A + 1) + (A - 1) * cos - sq) / a0;
    }

    public float Process(float x)
    {
        double y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        return (float)y;
    }
}

static class SoftClip
{
    const float Knee = 0.7f;
    /// <summary>Untouched below 0.7, then rounds peaks off smoothly towards 1.0.</summary>
    public static float Apply(float s)
    {
        float a = Math.Abs(s);
        if (a <= Knee) return s;
        float y = Knee + (1 - Knee) * MathF.Tanh((a - Knee) / (1 - Knee));
        return MathF.CopySign(y, s);
    }
}
