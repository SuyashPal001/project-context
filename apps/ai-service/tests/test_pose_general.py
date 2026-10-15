# General body reading (any reel): people count, framing, orientation, knees, arms, legs.
import numpy as np
from conftest import ff
from media import pose

def person(sh=(50, 20), hip=(50, 50), knee=(50, 70), ankle=(50, 90), wrist_l=(44, 48), wrist_r=(56, 48), hide=()):
    """17 COCO joints in a 100x100 frame, all confident unless hidden."""
    kp = np.zeros((17, 2)); sc = np.full(17, 0.9)
    kp[0] = (sh[0], sh[1] - 10); kp[1:5] = kp[0]
    kp[5], kp[6] = (sh[0] - 6, sh[1]), (sh[0] + 6, sh[1])
    kp[7], kp[8] = (sh[0] - 7, sh[1] + 14), (sh[0] + 7, sh[1] + 14)
    kp[9], kp[10] = wrist_l, wrist_r
    kp[11], kp[12] = (hip[0] - 4, hip[1]), (hip[0] + 4, hip[1])
    kp[13], kp[14] = (knee[0] - 4, knee[1]), (knee[0] + 4, knee[1])
    kp[15], kp[16] = (ankle[0] - 4, ankle[1]), (ankle[0] + 4, ankle[1])
    for i in hide:
        sc[i] = 0.05
    return kp / 100.0, sc  # normalised

def test_standing_person_reads_upright_full_body_straight_knees_arms_down():
    r = pose.read_person(*person())
    assert r["framing"] == "full_body" and r["orientation"] == "vertical" and r["knees"] == "straight"
    assert r["arms"] == {"left": "down", "right": "down"} and r["legs_toward"] == "center"

def test_a_raised_arm_is_read_along_the_body_not_the_screen():
    r = pose.read_person(*person(wrist_r=(62, 5)))
    assert r["arms"]["right"] == "raised" and r["arms"]["left"] == "down"
    # same pose lying sideways in the frame: head image-left, feet image-right
    kp, sc = person(wrist_r=(62, 5))
    rot = np.column_stack([kp[:, 1], 1 - kp[:, 0]])   # rotate 90 degrees
    r2 = pose.read_person(rot, sc)
    assert r2["orientation"] == "horizontal" and r2["arms"]["right"] == "raised"

def test_bent_knees_and_legs_falling_to_one_side():
    r = pose.read_person(*person(knee=(62, 66), ankle=(54, 88)))
    assert r["knees"] == "bent" and r["legs_toward"] == "image-right"

def test_knees_and_feet_can_point_opposite_ways():
    r = pose.read_person(*person(knee=(64, 68), ankle=(42, 88)))
    assert r["knees_toward"] == "image-right" and r["feet_toward"] == "image-left" and r["legs_toward"] == "image-right"

def test_a_box_cut_by_the_bottom_edge_is_not_full_body():
    kp, sc = person()
    assert pose.read_person(kp, sc, 1.0, (0.3, 0.1, 0.7, 0.999))["framing"] == "knees_up"
    assert pose.read_person(kp, sc, 1.0, (0.3, 0.1, 0.7, 0.95))["framing"] == "full_body"

def test_joints_placed_outside_the_frame_count_as_not_seen():
    kp, sc = person()
    kp[15, 1] = kp[16, 1] = 1.01
    assert pose.read_person(kp, sc)["framing"] == "knees_up"

def test_framing_from_which_joints_are_visible():
    assert pose.read_person(*person(hide=(15, 16)))["framing"] == "knees_up"
    assert pose.read_person(*person(hide=(13, 14, 15, 16)))["framing"] == "waist_up"
    assert pose.read_person(*person(hide=(11, 12, 13, 14, 15, 16)))["framing"] == "chest_up"
    assert pose.read_person(*person(hide=(5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16)))["framing"] == "face"

def test_unreadable_parts_are_unknown_not_guessed():
    r = pose.read_person(*person(hide=(11, 12, 13, 14, 15, 16)))
    assert r["orientation"] == "unknown" and r["knees"] == "unknown" and r["legs_toward"] == "unknown"

def test_summary_reports_people_count_and_no_person():
    looks = [{"label": "empty", "start_s": 0, "end_s": 2}, {"label": "two", "start_s": 2, "end_s": 4}]
    p = person()
    frames = [(t, []) for t in np.arange(0, 2, 0.2)] + [(t, [(p[0], p[1], (0.3, 0.1, 0.7, 0.95)), (p[0], p[1], (0.1, 0.2, 0.3, 0.9))]) for t in np.arange(2, 4, 0.2)]
    r = pose.summarise_looks(looks, frames)
    assert r[0]["people"] == 0 and r[0]["no_person"] is True and r[0]["main_end"] is None
    assert r[1]["people"] == 2 and r[1]["no_person"] is False and r[1]["main_end"]["framing"] == "full_body"

def _texture(path, dx_per_s=0):
    # a detailed test pattern the camera pans across
    ff(["-f", "lavfi", "-i", "testsrc2=s=360x320:d=4:r=25", "-vf", f"crop=180:320:x='40+{dx_per_s}*t':y=0", "-c:v", "libx264", str(path)])

def test_camera_pan_is_reported_as_a_camera_move_not_a_body_move(client, media_dir):
    p = media_dir / "pan.mp4"; _texture(p, dx_per_s=30)
    m = pose.motion_summary(str(p), [])
    assert any(c["direction"] in ("pan-left", "pan-right") for c in m["camera_moves"])
    assert m["moves"] == []

def test_a_still_video_has_no_moves_at_all(client, media_dir):
    p = media_dir / "still.mp4"
    ff(["-f", "lavfi", "-i", "testsrc2=s=180x320:d=3:r=25", "-vf", "trim=end_frame=1,loop=74:1:0", "-c:v", "libx264", str(p)])
    m = pose.motion_summary(str(p), [])
    assert m["moves"] == [] and m["camera_moves"] == []
