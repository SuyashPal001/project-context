from conftest import ff

def test_counts_a_sudden_flash(client, media_dir):
    p = media_dir / "flash.mp4"
    ff(["-f", "lavfi", "-i", "color=gray:s=180x320:d=1:r=25", "-f", "lavfi", "-i", "color=black:s=180x320:d=0.2:r=25",
        "-f", "lavfi", "-i", "color=gray:s=180x320:d=1:r=25", "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0", "-c:v", "libx264", str(p)])
    d = client.post("/media/brightness-jumps", json={"path": str(p)}, headers={"x-internal-service-key": "k"}).json()
    assert d["count"] == 2

def test_coverage_curve_tracks_a_brown_block(client, media_dir):
    p = media_dir / "cov.mp4"
    ff(["-f", "lavfi", "-i", "color=white:s=180x320:d=2:r=25", "-vf",
        "drawbox=x=0:y=0:w=180:h=160:color=0x6E4220:t=fill:enable='between(t,1,2)'", "-c:v", "libx264", str(p)])
    d = client.post("/media/coverage", json={"path": str(p), "hsv_lo": [0, 80, 25], "hsv_hi": [20, 255, 150], "step_s": 0.5}, headers={"x-internal-service-key": "k"}).json()
    assert d["curve"][0] < 0.05 and abs(d["curve"][-1] - 0.5) < 0.1

def test_coverage_rejects_bad_ranges_and_steps(client, media_dir):
    p = media_dir / "cov2.mp4"
    ff(["-f", "lavfi", "-i", "color=white:s=180x320:d=1:r=25", "-c:v", "libx264", str(p)])
    h = {"x-internal-service-key": "k"}
    assert client.post("/media/coverage", json={"path": str(p), "hsv_lo": [0, 80], "hsv_hi": [20, 255, 150]}, headers=h).status_code == 400
    assert client.post("/media/coverage", json={"path": str(p), "hsv_lo": [0, 80, 25], "hsv_hi": [20, 255, 150], "step_s": 0}, headers=h).status_code == 400

def test_coverage_rejects_hsv_values_out_of_range(client, media_dir):
    # review M3: values outside OpenCV's HSV range would silently wrap in uint8
    p = media_dir / "cov3.mp4"
    ff(["-f", "lavfi", "-i", "color=white:s=180x320:d=1:r=25", "-c:v", "libx264", str(p)])
    h = {"x-internal-service-key": "k"}
    for lo, hi in (([0, 80, 25], [200, 255, 150]), ([0, -1, 25], [20, 255, 150]), ([0, 80, 25], [20, 256, 150])):
        assert client.post("/media/coverage", json={"path": str(p), "hsv_lo": lo, "hsv_hi": hi}, headers=h).status_code == 400
