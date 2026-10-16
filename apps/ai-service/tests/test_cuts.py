from conftest import ff

def test_finds_hard_cuts_and_not_noise(client, media_dir):
    p = media_dir / "cuts.mp4"
    # three solid-colour shots of 2s each: cuts at 2.0 and 4.0
    ff(["-f", "lavfi", "-i", "color=red:s=320x240:d=2:r=25", "-f", "lavfi", "-i", "color=blue:s=320x240:d=2:r=25",
        "-f", "lavfi", "-i", "testsrc=s=320x240:d=2:r=25", "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0", "-c:v", "libx264", str(p)])
    d = client.post("/media/cuts", json={"path": str(p)}, headers={"x-internal-service-key": "k"}).json()
    assert len(d["cuts"]) == 2
    assert abs(d["cuts"][0] - 2.0) < 0.1 and abs(d["cuts"][1] - 4.0) < 0.1
    assert abs(d["duration_s"] - 6.0) < 0.1


def test_fps_reads_a_rate_with_trailing_commas(monkeypatch):
    # ffprobe's csv printed "60/1,60/1," for a 60fps Instagram reel (both rate fields, trailing comma);
    # the parser crashed and the reel lost its cut times (local Snitch replay, 2026-10-16).
    import subprocess
    from media import cuts

    class R:
        stdout = "60/1,\n"
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: R())
    assert cuts._fps("x.mp4") == 60.0
