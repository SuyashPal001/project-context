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

def test_framing_at_the_bottom_edge():
    kp, sc = person()
    # both ankles seen with room for the feet: full body even when the box reaches the edge
    assert pose.read_person(kp, sc, 1.0, (0.3, 0.1, 0.7, 0.999))["framing"] == "full_body"
    # ankles squeezed against the edge: the feet are cut
    kp_edge = kp.copy(); kp_edge[15, 1] = kp_edge[16, 1] = 0.975
    assert pose.read_person(kp_edge, sc, 1.0, (0.3, 0.1, 0.7, 0.999))["framing"] == "knees_up"
    # one ankle hidden and the box at the edge: the feet may be cut
    sc2 = sc.copy(); sc2[16] = 0.05
    assert pose.read_person(kp, sc2, 1.0, (0.3, 0.1, 0.7, 0.999))["framing"] == "knees_up"
    assert pose.read_person(kp, sc2, 1.0, (0.3, 0.1, 0.7, 0.95))["framing"] == "full_body"

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

def test_clean_moves_drops_weak_ones_and_ones_next_to_covered_spans_and_merges_same_moment():
    raw = [
        {"t_s": 1.23, "from_s": 1.03, "to_s": 1.57, "area": "upper", "direction": "image-up", "strength": 0.095},
        {"t_s": 1.23, "from_s": 0.93, "to_s": 1.47, "area": "upper", "direction": "image-right", "strength": 0.055},
        {"t_s": 2.93, "from_s": 2.93, "to_s": 3.0, "area": "upper", "direction": "image-right", "strength": 0.01},
        {"t_s": 8.23, "from_s": 7.63, "to_s": 8.4, "area": "upper", "direction": "image-right", "strength": 0.036},
        {"t_s": 3.23, "from_s": 2.93, "to_s": 3.87, "area": "lower", "direction": "image-right", "strength": 0.086},
    ]
    out = pose.clean_moves(raw, [[8.70, 10.03]])
    assert [(m["t_s"], m["area"], m["direction"]) for m in out] == [(1.23, "upper", "image-up + image-right"), (3.23, "lower", "image-right")]

def test_framing_on_a_tall_frame_uses_frame_position_not_scaled_distance():
    kp, sc = person(ankle=(50, 80))
    assert pose.read_person(kp, sc, 16 / 9, (0.3, 0.1, 0.7, 0.999))["framing"] == "full_body"



# Facing (2026-10-16): Snitch's back-to-camera frame read shoulders mirrored (-0.59 of the torso),
# front frames +0.64..+0.73 on two reels. The pose model "sees" a face on the back of a head too,
# so the shoulder order decides, not the face points.
def turned(l_sh_x, r_sh_x, hide=()):
    kp, sc = person(hide=hide)
    kp = kp.copy(); kp[5][0], kp[6][0] = l_sh_x / 100.0, r_sh_x / 100.0
    return kp, sc

def test_facing_front_back_and_side_from_the_shoulder_order():
    assert pose.read_person(*turned(60, 40))["facing"] == "front"   # the person's left shoulder on the image's right
    assert pose.read_person(*turned(40, 60))["facing"] == "back"
    assert pose.read_person(*turned(52, 48))["facing"] == "side"

def test_facing_unknown_without_both_shoulders():
    assert pose.read_person(*turned(60, 40, hide=(6,)))["facing"] == "unknown"

# The end frame of a look was taken while a fan blade covered most of her (fan run real12), so the edit had
# almost no pose to copy and the end photos came out like the starts. The look's key frames are its first
# and last frames where the person is well seen (head and body confident); the last frame only when none is.
def test_key_frames_skip_frames_where_the_person_is_covered():
    looks = [{"label": "a", "start_s": 0, "end_s": 3}]
    seen, covered = person(), person()
    covered[1][:5] = 0.53; covered[1][5:] = 0.5
    box = (0.2, 0.1, 0.8, 0.95)
    frames = [(t, [(seen[0], seen[1], box)]) for t in (0.0, 0.4, 0.8, 1.2, 1.6)] + [(t, [(covered[0], covered[1], box)]) for t in (2.0, 2.4, 2.8)]
    kf = pose.summarise_looks(looks, frames)[0]["key_frames"]
    assert [k["t_s"] for k in kf] == [0.0, 1.6]

def test_key_frames_fall_back_to_the_edges_when_never_well_seen():
    looks = [{"label": "a", "start_s": 0, "end_s": 3}]
    covered = person(); covered[1][:] = 0.5
    frames = [(t, [(covered[0], covered[1], (0.2, 0.1, 0.8, 0.95))]) for t in (0.0, 1.0, 2.0)]
    assert [k["t_s"] for k in pose.summarise_looks(looks, frames)[0]["key_frames"]] == [0.0, 2.0]
