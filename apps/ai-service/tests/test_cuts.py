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
