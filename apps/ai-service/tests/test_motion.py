from conftest import ff

def _moving_square(path, start_s):
    # 5s grey video; a white square jumps left/right in the lower half from start_s for 0.4s
    on = f"between(t,{start_s},{start_s+0.4})"
    ff(["-f", "lavfi", "-i", "color=gray:s=160x288:d=5:r=25",
        "-vf", f"drawbox=x=40:y=200:w=40:h=40:color=white:t=fill:enable='{on}*eq(mod(n,2),0)',"
               f"drawbox=x=120:y=200:w=40:h=40:color=white:t=fill:enable='{on}*eq(mod(n,2),1)'",
        "-c:v", "libx264", str(path)])

def test_snaps_to_the_real_motion_near_the_hint(client, media_dir):
    p = media_dir / "move.mp4"; _moving_square(p, 2.3)
    body = {"path": str(p), "items": [{"id": "legs", "t_s": 3.0, "box": [0, 0.5, 1, 1]}], "exclude": [], "window_s": 1.5}
    d = client.post("/media/motion-peaks", json=body, headers={"x-internal-service-key": "k"}).json()
    it = d["items"][0]
    assert it["measured"] is True and abs(it["t_s"] - 2.4) < 0.35

def test_static_video_keeps_the_hint_unmeasured(client, media_dir):
    p = media_dir / "still.mp4"
    ff(["-f", "lavfi", "-i", "color=gray:s=160x288:d=4:r=25", "-c:v", "libx264", str(p)])
    body = {"path": str(p), "items": [{"id": "x", "t_s": 2.0, "box": [0, 0, 1, 1]}], "exclude": [], "window_s": 1.5}
    it = client.post("/media/motion-peaks", json=body, headers={"x-internal-service-key": "k"}).json()["items"][0]
    assert it == {"id": "x", "t_s_in": 2.0, "t_s": 2.0, "measured": False, "strength": 0.0}

def test_ignores_motion_inside_an_excluded_span(client, media_dir):
    p = media_dir / "excl.mp4"; _moving_square(p, 2.3)
    body = {"path": str(p), "items": [{"id": "legs", "t_s": 2.5, "box": [0, 0.5, 1, 1]}], "exclude": [[2.2, 2.8]], "window_s": 1.5}
    it = client.post("/media/motion-peaks", json=body, headers={"x-internal-service-key": "k"}).json()["items"][0]
    assert it["measured"] is False

def test_rejects_a_box_without_four_numbers(client, media_dir):
    p = media_dir / "still2.mp4"
    ff(["-f", "lavfi", "-i", "color=gray:s=160x288:d=1:r=25", "-c:v", "libx264", str(p)])
    body = {"path": str(p), "items": [{"id": "x", "t_s": 0.5, "box": [0, 0, 1]}]}
    assert client.post("/media/motion-peaks", json=body, headers={"x-internal-service-key": "k"}).status_code == 400
