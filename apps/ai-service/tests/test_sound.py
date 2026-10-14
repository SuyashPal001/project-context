from conftest import ff

def test_tone_then_silence(client, media_dir):
    p = media_dir / "tone.mp4"
    # 3s of tone then 2s of silence, with a black video track
    ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
        "-f", "lavfi", "-i", "color=black:s=160x120:d=5",
        "-filter_complex", "[1]atrim=0:2[s];[0][s]concat=n=2:v=0:a=1[a]", "-map", "2:v", "-map", "[a]", "-shortest", str(p)])
    r = client.post("/media/sound", json={"path": str(p)}, headers={"x-internal-service-key": "k"})
    assert r.status_code == 200
    d = r.json()
    assert d["silent_from_s"] == 3.0
    assert any(e["kind"] == "drop" and 2.5 <= e["at_s"] <= 3.5 for e in d["events"])

def test_tempo_of_a_120_bpm_click(client, media_dir):
    p = media_dir / "click.mp4"
    # 8s of a short 1 kHz blip every 0.5s = 120 BPM
    ff(["-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t,0.5),0.03),sin(2*PI*1000*t),0)':s=44100:d=8",
        "-f", "lavfi", "-i", "color=black:s=160x120:d=8", "-map", "1:v", "-map", "0:a", "-shortest", str(p)])
    d = client.post("/media/sound", json={"path": str(p)}, headers={"x-internal-service-key": "k"}).json()
    assert d["bpm"] is not None and abs(d["bpm"] - 120) < 6
    assert len(d["beats_s"]) >= 12

def test_no_audio_track(client, media_dir):
    p = media_dir / "mute.mp4"
    ff(["-f", "lavfi", "-i", "color=black:s=160x120:d=2", str(p)])
    d = client.post("/media/sound", json={"path": str(p)}, headers={"x-internal-service-key": "k"}).json()
    assert d == {"curve_db": [], "events": [], "rhythm": [], "silent_from_s": None, "bpm": None, "beats_s": [], "has_audio": False}
