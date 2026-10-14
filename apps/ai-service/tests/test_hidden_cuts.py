from conftest import ff

def test_finds_change_behind_a_cover(client, media_dir):
    p = media_dir / "hidden.mp4"
    # look A (red) 0-2.4s, covered (black) 2.4-2.8s, look B (green) 2.8-5s. No hard cut between A and B.
    ff(["-f", "lavfi", "-i", "color=red:s=180x320:d=2.4:r=25", "-f", "lavfi", "-i", "color=black:s=180x320:d=0.4:r=25",
        "-f", "lavfi", "-i", "color=green:s=180x320:d=2.2:r=25", "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0", "-c:v", "libx264", str(p)])
    body = {"path": str(p), "looks": [{"label": "red", "approx_start_s": 0, "approx_end_s": 2.2}, {"label": "green", "approx_start_s": 3.0, "approx_end_s": 5.0}]}
    d = client.post("/media/hidden-cuts", json=body, headers={"x-internal-service-key": "k"}).json()
    assert len(d["hidden_cuts"]) == 1
    h = d["hidden_cuts"][0]
    assert h["from"] == "red" and h["to"] == "green"
    assert abs(h["at_s"] - 2.6) < 0.15

def test_ignores_a_one_frame_flash_of_another_look(client, media_dir):
    p = media_dir / "flash.mp4"
    ff(["-f", "lavfi", "-i", "color=red:s=180x320:d=2:r=25", "-f", "lavfi", "-i", "color=green:s=180x320:d=0.08:r=25",
        "-f", "lavfi", "-i", "color=red:s=180x320:d=2:r=25", "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0", "-c:v", "libx264", str(p)])
    body = {"path": str(p), "looks": [{"label": "red", "approx_start_s": 0, "approx_end_s": 1.5}, {"label": "green", "approx_start_s": 2.0, "approx_end_s": 2.05}]}
    d = client.post("/media/hidden-cuts", json=body, headers={"x-internal-service-key": "k"}).json()
    assert d["hidden_cuts"] == []
