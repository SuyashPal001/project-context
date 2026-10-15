import numpy as np
from conftest import ff
from media import pose

H = {"x-internal-service-key": "k"}

def _kp(hip_x, knee_x, ankle_x, w=100.0):
    # 17 COCO keypoints in pixels; only shoulders, hips, knees and ankles matter here
    kp = np.zeros((17, 2)); sc = np.full(17, 0.9)
    kp[[5, 6]] = [[hip_x - 5, 10], [hip_x + 5, 10]]
    kp[[11, 12]] = [[hip_x - 5, 50], [hip_x + 5, 50]]
    kp[[13, 14]] = [[knee_x - 5, 70], [knee_x + 5, 70]]
    kp[[15, 16]] = [[ankle_x - 5, 90], [ankle_x + 5, 90]]
    return kp, sc

def test_leg_side_uses_knees_and_ankles_against_hips():
    kp, sc = _kp(50, 58, 54)
    assert pose.side(pose.leg_offset(kp, sc, 100)) == "image-right"
    kp, sc = _kp(50, 44, 47)
    assert pose.side(pose.leg_offset(kp, sc, 100)) == "image-left"
    kp, sc = _kp(50, 51, 50)
    assert pose.side(pose.leg_offset(kp, sc, 100)) == "center"

def test_low_confidence_joints_give_no_reading():
    kp, sc = _kp(50, 58, 54); sc[15] = 0.05
    assert pose.leg_offset(kp, sc, 100) is None

def test_look_start_and_end_sides_from_the_first_and_last_second():
    # look 0-4s: legs straight for 2s, then slide image-right
    frames = [(t, _kp(50, 50 if t < 2 else 58, 50 if t < 2 else 56)) for t in np.arange(0, 4, 0.1)]
    r = pose.summarise_looks([{"label": "a", "start_s": 0, "end_s": 4}], frames, width=100)
    assert r[0]["leg_side_start"] == "center" and r[0]["leg_side_end"] == "image-right"

def test_a_look_with_too_few_readable_frames_is_unknown_never_a_guess():
    frames = [(0.5, _kp(50, 58, 54))]
    r = pose.summarise_looks([{"label": "a", "start_s": 0, "end_s": 4}], frames, width=100)
    assert r[0]["leg_side_end"] == "unknown" and r[0]["leg_side_start"] == "unknown"

def _slide(p):
    # a white block that slides image-right between 2.0s and 2.8s in the lower half
    ff(["-f", "lavfi", "-i", "color=gray:s=180x320:d=4:r=25", "-f", "lavfi", "-i", "color=white:s=40x60:d=4:r=25",
        "-filter_complex", "[0][1]overlay=x='if(lt(t,2),20,if(lt(t,2.8),20+(t-2)*120,116))':y=220",
        "-c:v", "libx264", str(p)])

def test_flow_finds_a_sideways_move_and_its_direction(client, media_dir):
    p = media_dir / "slide.mp4"
    # a block that slides image-right between 2.0s and 2.8s in the lower half
    _slide(p)
    moves = pose.flow_moves(str(p), [0.1, 0.5, 0.9, 0.95], [])
    assert any(m["direction"] == "image-right" and 1.9 <= m["t_s"] <= 2.9 for m in moves)

def test_flow_ignores_motion_inside_excluded_spans(client, media_dir):
    p = media_dir / "slide2.mp4"
    _slide(p)
    assert pose.flow_moves(str(p), [0.1, 0.5, 0.9, 0.95], [[1.8, 3.0]]) == []

def test_route_rejects_a_bad_look(client, media_dir):
    p = media_dir / "s.mp4"
    ff(["-f", "lavfi", "-i", "color=gray:s=180x320:d=1:r=25", "-c:v", "libx264", str(p)])
    body = {"path": str(p), "looks": [{"label": "a", "start_s": 2, "end_s": 1}]}
    assert client.post("/media/pose", json=body, headers=H).status_code == 400
