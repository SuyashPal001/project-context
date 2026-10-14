import subprocess, json, tempfile, os

STEP = 0.5

def has_audio(path: str) -> bool:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "json", path], capture_output=True, text=True, check=True).stdout
    return bool(json.loads(out).get("streams"))

def loudness_curve(path: str) -> list[float]:
    with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as t:
        out = t.name
    try:
        sr = 44100
        subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(sr), "-af",
                        f"asetnsamples={int(sr*STEP)},astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file={out}",
                        "-f", "null", "-"], check=True, timeout=300)
        vals = []
        for line in open(out):
            if "RMS_level" in line:
                v = line.strip().split("=")[1]
                vals.append(-100.0 if v in ("-inf", "inf", "nan") else max(-100.0, float(v)))
        return vals
    finally:
        os.unlink(out)

def summarize(vals: list[float]) -> dict:
    events, rhythm = [], []
    for i in range(1, len(vals)):
        d = vals[i] - vals[i - 1]
        if abs(d) >= 8 and max(vals[i], vals[i - 1]) > -60:
            events.append({"at_s": round(i * STEP, 2), "change_db": round(d), "kind": "drop" if d < 0 else "jump"})
    # group alternating jump/drop events spaced by one step into a rhythm entry (e.g. a ticking clock)
    i = 0
    while i < len(events):
        j = i
        while j + 1 < len(events) and events[j + 1]["at_s"] - events[j]["at_s"] <= 2 * STEP and events[j + 1]["kind"] != events[j]["kind"]:
            j += 1
        if j - i >= 3:
            rhythm.append({"from_s": events[i]["at_s"], "to_s": events[j]["at_s"], "every_s": round((events[j]["at_s"] - events[i]["at_s"]) / (j - i), 2)})
            del events[i:j + 1]
        else:
            i += 1
    silent_from = None
    for k in range(len(vals)):
        if all(v < -55 for v in vals[k:]) and k < len(vals):
            silent_from = round(k * STEP, 2)
            break
    return {"curve_db": [round(v) for v in vals], "events": events, "rhythm": rhythm, "silent_from_s": silent_from, "has_audio": True}

def tempo_and_beats(path: str) -> tuple[float | None, list[float]]:
    import librosa
    # librosa reads WAV reliably on every platform; decode the video's audio with ffmpeg first.
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as t:
        wav = t.name
    try:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-vn", "-ac", "1", "-ar", "22050", wav], check=True, timeout=300)
        y, sr = librosa.load(wav, sr=22050, mono=True)
    finally:
        os.unlink(wav)
    if y.size == 0 or float(abs(y).max()) < 1e-4:
        return None, []
    tempo, frames = librosa.beat.beat_track(y=y, sr=sr)
    beats = [round(float(t), 2) for t in librosa.frames_to_time(frames, sr=sr)]
    t = float(tempo[0] if hasattr(tempo, "__len__") else tempo)
    return (round(t, 1) if beats else None), beats

def sound_timeline(path: str) -> dict:
    if not has_audio(path):
        return {"curve_db": [], "events": [], "rhythm": [], "silent_from_s": None, "bpm": None, "beats_s": [], "has_audio": False}
    out = summarize(loudness_curve(path))
    out["bpm"], out["beats_s"] = tempo_and_beats(path)
    return out
