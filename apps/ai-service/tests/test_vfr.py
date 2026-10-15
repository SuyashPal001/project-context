# Review M5: on variable-frame-rate reels, times must be the frames' real timestamps
# (what ffmpeg -ss seeks to), not frame index / average fps.
from conftest import ff

def _vfr(path, second_color, flash=False, square_at=None):
    # 0-2s at 5fps (grey), then 2-5s at 30fps; kept variable-rate in the output
    b = f"color={second_color}:s=160x288:d=3:r=30"
    vf = ""
    if square_at is not None:
        on = f"between(t,{square_at},{square_at + 0.3})"
        vf = (f",drawbox=x=20:y=200:w=40:h=40:color=white:t=fill:enable='{on}*eq(mod(n,2),0)'"
              f",drawbox=x=100:y=200:w=40:h=40:color=white:t=fill:enable='{on}*eq(mod(n,2),1)'")
    if flash:
        vf += ",drawbox=x=0:y=0:w=160:h=288:color=black:t=fill:enable='between(t,1.0,1.2)'"
    ff(["-f", "lavfi", "-i", "color=gray:s=160x288:d=2:r=5", "-f", "lavfi", "-i", b,
        "-filter_complex", f"[1]setpts=PTS-STARTPTS{vf}[b];[0][b]concat=n=2:v=1:a=0[v]", "-map", "[v]",
        "-fps_mode", "vfr", "-c:v", "libx264", str(path)])

H = {"x-internal-service-key": "k"}

def test_motion_time_is_the_real_timestamp(client, media_dir):
    p = media_dir / "vfr_move.mp4"; _vfr(p, "gray", square_at=1.0)  # square at 2+1.0 = 3.0s absolute
    it = client.post("/media/motion-peaks", json={"path": str(p), "items": [{"id": "x", "t_s": 3.3, "box": [0, 0.5, 1, 1]}], "exclude": []}, headers=H).json()["items"][0]
    assert it["measured"] is True and abs(it["t_s"] - 3.05) < 0.2

def test_brightness_jump_time_is_the_real_timestamp(client, media_dir):
    p = media_dir / "vfr_flash.mp4"; _vfr(p, "gray", flash=True)  # flash at 2+1.0 = 3.0s absolute
    d = client.post("/media/brightness-jumps", json={"path": str(p)}, headers=H).json()
    assert d["count"] == 2 and abs(d["jumps"][0]["at_s"] - 3.0) < 0.1

def test_cut_time_is_the_real_timestamp(client, media_dir):
    p = media_dir / "vfr_cut.mp4"; _vfr(p, "red")
    d = client.post("/media/cuts", json={"path": str(p)}, headers=H).json()
    assert len(d["cuts"]) == 1 and abs(d["cuts"][0] - 2.0) < 0.1
    assert abs(d["duration_s"] - 5.0) < 0.1
