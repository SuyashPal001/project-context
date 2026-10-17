# The fan-blade wipe as a shared trick (fan runs 2026-10-14..17): one angle track, made from the original's
# MEASURED cut times at a steady speed like a real fan (an eased or model-timed sweep stopped and started, or
# missed the cut), drives both the blade and the outfit change along its edge.
import numpy as np
import cv2
from media import sweep


def test_track_rests_then_turns_steadily_and_covers_her_at_each_measured_cut():
    tr = sweep.angle_track([5.0, 9.2, 12.8], 14.9, fps=30)
    assert len(tr) == round(14.9 * 30)
    assert tr[0] == 0 and tr[30] == 0                      # at rest at first
    assert all(b >= a for a, b in zip(tr, tr[1:]))          # never turns back
    for k, p in enumerate([5.0, 9.2, 12.8]):
        assert abs(tr[round(p * 30)] - (sweep.COVER_DEG + 120 * k)) < 4   # a blade over her body at each cut
    speeds = np.diff(tr[round(5.5 * 30):round(12.0 * 30)]) * 30
    assert speeds.min() > 20 and speeds.max() < 45          # steady, like a real fan


def _solid(path, bgr, n, size=(72, 128)):
    w = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 30, size)
    for _ in range(n):
        w.write(np.full((size[1], size[0], 3), bgr, np.uint8))
    w.release()


def test_compose_without_measurement_swaps_along_a_steady_blade(tmp_path):
    a, b = tmp_path / "a.mp4", tmp_path / "b.mp4"
    _solid(a, (0, 0, 255), 60); _solid(b, (255, 0, 0), 60)
    out = tmp_path / "out.mp4"
    sweep.compose([str(a), str(b)], [60, 60], [2.0], str(out), (72, 128), fps=30)
    cap = cv2.VideoCapture(str(out)); frames = []
    while True:
        ok, f = cap.read()
        if not ok: break
        frames.append(f)
    assert len(frames) == 120
    mid = lambda f: f[100, 36].astype(int)                  # a point low in the frame, far from the hub
    assert mid(frames[5])[2] > 150 and mid(frames[5])[0] < 100     # the first look before the sweep
    assert mid(frames[-1])[0] > 150 and mid(frames[-1])[2] < 100   # the next look after it
    dark = lambda f: (f.max(axis=2) < 90).mean()
    assert max(dark(f) for f in frames[40:80]) > 0.1          # the blade crosses the frame around the cut


# Replaying the original's own blade (fan runs real23): a track from cut times swept late and steep; angles
# around a guessed hub drew blades too steep and too many; fitted lines broke when the blade met the frame
# edge. replay() takes the original's blade area itself, frame by frame (dark wood that moves; her dark hair
# lying still is left out), fills it with our wood, and shows the next look wherever the blade has passed.
def _rotating_bar(path, n=90, size=(72, 128), start=10, deg_per_frame=1.5, still=False):
    w, h = size
    out = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 30, size)
    hx, hy = -3, -3
    for i in range(n):
        f = np.full((h, w, 3), (160, 200, 220), np.uint8)      # a pale rug
        a = np.radians(5 + max(0, i - start) * deg_per_frame)
        p2 = (int(hx + 400 * np.cos(a)), int(hy + 400 * np.sin(a)))
        cv2.line(f, (hx, hy), p2, (6, 20, 66), 14)             # dark red-brown blade
        if still:
            cv2.circle(f, (60, 110), 6, (6, 20, 66), -1)       # dark hair the same colour, lying still
        out.write(f)
    out.release()


def _read(path):
    cap, frames = cv2.VideoCapture(str(path)), []
    while True:
        ok, f = cap.read()
        if not ok:
            return frames
        frames.append(f)


def test_replay_draws_the_originals_blade_and_swaps_where_it_has_passed(tmp_path):
    a, b, fan, out = tmp_path / "a.mp4", tmp_path / "b.mp4", tmp_path / "fan.mp4", tmp_path / "out.mp4"
    _solid(a, (0, 0, 255), 45); _solid(b, (255, 0, 0), 45)
    _rotating_bar(fan, n=90, start=10, deg_per_frame=1.5, still=True)
    r = sweep.replay(str(fan), [str(a), str(b)], [45, 45], [[1.0, 2.6]], str(out), (72, 128))
    b_, g_, r_ = r["color"]
    assert r_ > g_ > b_
    frames = _read(out)
    assert len(frames) == 90
    assert frames[5][100, 30][2] > 150                     # the first look before the blade comes
    assert frames[-1][100, 30][0] > 150                    # the next look once the blade has passed
    dark = lambda f: (f.max(axis=2) < 90).mean()
    assert max(dark(f) for f in frames[20:70]) > 0.05      # the blade is drawn
    assert frames[-1][110, 60].max() > 150                 # the still dark spot (her hair) is not drawn as blade


def test_replay_fills_the_whole_blade_with_wood_never_black(tmp_path):
    # fan run real23: the wood picture covered only part of the blade area, leaving black patches
    a, b, fan, out = tmp_path / "a.mp4", tmp_path / "b.mp4", tmp_path / "fan.mp4", tmp_path / "out.mp4"
    _solid(a, (0, 0, 255), 45); _solid(b, (255, 0, 0), 45)
    _rotating_bar(fan, n=90, start=10, deg_per_frame=1.5)
    sweep.replay(str(fan), [str(a), str(b)], [45, 45], [[1.0, 2.6]], str(out), (72, 128))
    for f in _read(out)[20:70]:
        assert (f.max(axis=2) < 8).mean() < 0.005


def test_small_dark_patches_are_not_the_blade(tmp_path):
    # fan run real23: dark folds of the original's crimson trousers counted as blade and showed the next look early
    fan = tmp_path / "fan.mp4"
    w_ = cv2.VideoWriter(str(fan), cv2.VideoWriter_fourcc(*"mp4v"), 30, (72, 128))
    for i in range(30):
        f = np.full((128, 72, 3), (160, 200, 220), np.uint8)
        cv2.circle(f, (20 + i, 100), 3, (6, 20, 66), -1)        # a small moving dark fold
        w_.write(f)
    w_.release()
    masks, _, _ = sweep._dark_masks(str(fan), *sweep.BLADE_HSV)
    assert max(m.mean() for m in masks) == 0
