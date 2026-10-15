import os, pytest
from pathlib import Path

REAL = os.environ.get("REAL_VIDEOS_DIR")
pytestmark = pytest.mark.skipif(not REAL, reason="set REAL_VIDEOS_DIR to the folder holding the spike videos")

def _copy(media_dir, name):
    src = Path(REAL) / name
    dst = media_dir / name
    dst.write_bytes(src.read_bytes())
    return str(dst)

def test_sony_ad_cuts(client, media_dir):
    d = client.post("/media/cuts", json={"path": _copy(media_dir, "sony.mp4")}, headers={"x-internal-service-key": "k"}).json()
    assert 28 <= len(d["cuts"]) <= 36                    # spike: 32 at threshold 0.5
    assert any(54.8 <= f[0] <= 55.8 for f in d["fades"])   # end-card fade ~55.3s

def test_fan_reel_hidden_cuts(client, media_dir):
    looks = [{"label": "jacket", "approx_start_s": 0.5, "approx_end_s": 4.0}, {"label": "saree", "approx_start_s": 6.2, "approx_end_s": 8.2},
             {"label": "sharara", "approx_start_s": 9.9, "approx_end_s": 11.8}, {"label": "cape", "approx_start_s": 13.2, "approx_end_s": 14.6}]
    d = client.post("/media/hidden-cuts", json={"path": _copy(media_dir, "fan_reel.mp4"), "looks": looks}, headers={"x-internal-service-key": "k"}).json()
    ats = [h["at_s"] for h in d["hidden_cuts"]]
    assert len(ats) == 3                                       # no false 4.58s switch
    for got, want in zip(ats, [5.4, 9.2, 12.7]):
        assert abs(got - want) < 0.4

def test_fan_reel_has_a_tempo(client, media_dir):
    d = client.post("/media/sound", json={"path": _copy(media_dir, "fan_reel.mp4")}, headers={"x-internal-service-key": "k"}).json()
    assert d["bpm"] is not None and 60 <= d["bpm"] <= 200

def test_sony_sound_drop(client, media_dir):
    d = client.post("/media/sound", json={"path": _copy(media_dir, "sony.mp4")}, headers={"x-internal-service-key": "k"}).json()
    assert d["silent_from_s"] is not None and 54 <= d["silent_from_s"] <= 58

def test_fan_reel_leg_sides_and_slide_from_pose(client, media_dir):
    looks = [{"label": "jacket", "start_s": 0, "end_s": 5.47}, {"label": "saree", "start_s": 5.47, "end_s": 9.32},
             {"label": "sharara", "start_s": 9.32, "end_s": 12.82}, {"label": "cape", "start_s": 12.82, "end_s": 14.9}]
    covered = [[4.6, 6.2], [8.5, 9.9], [12.3, 13.5]]   # fan-blade spans
    d = client.post("/media/pose", json={"path": _copy(media_dir, "fan_reel.mp4"), "looks": looks, "subject_box": [0.1, 0.05, 0.9, 0.95], "exclude": covered}, headers={"x-internal-service-key": "k"}).json()
    assert [l["leg_side_end"] for l in d["looks"]] == ["image-right", "image-left", "image-right", "image-left"]
    assert d["looks"][0]["leg_side_start"] == "center"               # legs straight, then slide right
    assert any(m["direction"] == "image-right" and 2.75 <= m["t_s"] <= 3.75 for m in d["moves"])
