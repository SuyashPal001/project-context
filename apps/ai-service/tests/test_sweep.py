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


def test_shiny_spots_on_the_blade_are_still_blade(tmp_path):
    # fan run real23: light reflections on the original's blade fell outside the dark-wood colours and showed
    # as pale notches in our blade
    a, b, fan, out = tmp_path / "a.mp4", tmp_path / "b.mp4", tmp_path / "fan.mp4", tmp_path / "out.mp4"
    _solid(a, (0, 0, 255), 30); _solid(b, (255, 0, 0), 30)
    w_ = cv2.VideoWriter(str(fan), cv2.VideoWriter_fourcc(*"mp4v"), 30, (72, 128))
    for i in range(60):
        f = np.full((128, 72, 3), (160, 200, 220), np.uint8)
        cv2.rectangle(f, (0, i), (72, 30 + i), (6, 20, 66), -1)                  # a dark band moving down
        cv2.circle(f, (36, 15 + i), 3, (120, 160, 200), -1)                       # a shiny spot on it
        w_.write(f)
    w_.release()
    sweep.replay(str(fan), [str(a), str(b)], [30, 30], [[0.5, 1.5]], str(out), (72, 128))
    f = _read(out)[10]
    assert f[25, 36].max() < 120                    # drawn as wood, not the pale spot


def test_two_blades_meeting_at_the_hub_are_not_filled_as_one_wedge(tmp_path):
    # fan run real23: two blades joined at the hub corner were filled to one outline, showing wood between them
    a, b, fan, out = tmp_path / "a.mp4", tmp_path / "b.mp4", tmp_path / "fan.mp4", tmp_path / "out.mp4"
    _solid(a, (0, 0, 255), 30); _solid(b, (255, 0, 0), 30)
    w_ = cv2.VideoWriter(str(fan), cv2.VideoWriter_fourcc(*"mp4v"), 30, (72, 128))
    for i in range(60):
        f = np.full((128, 72, 3), (160, 200, 220), np.uint8)
        cv2.line(f, (0, 0), (72, 20 + i), (6, 20, 66), 10)       # one blade
        cv2.line(f, (0, 0), (10 + i // 3, 128), (6, 20, 66), 10)  # another, from the same corner
        w_.write(f)
    w_.release()
    sweep.replay(str(fan), [str(a), str(b)], [30, 30], [[0.5, 1.5]], str(out), (72, 128))
    f = _read(out)[10]
    assert f[70, 45].max() > 150          # between the two blades: no wood


def test_the_next_look_never_flips_back_during_a_sweep(tmp_path):
    # fan run real23: the outfit flipped back to the old look mid-sweep (the sweep's memory was reset)
    a, b, fan, out = tmp_path / "a.mp4", tmp_path / "b.mp4", tmp_path / "fan.mp4", tmp_path / "out.mp4"
    _solid(a, (0, 0, 255), 45); _solid(b, (255, 0, 0), 45)
    w_ = cv2.VideoWriter(str(fan), cv2.VideoWriter_fourcc(*"mp4v"), 30, (72, 128))
    for i in range(90):
        f = np.full((128, 72, 3), (160, 200, 220), np.uint8)
        cv2.line(f, (0, 0), (72, max(0, i - 10) * 3), (6, 20, 66), 16)           # one blade sweeping down
        cv2.line(f, (0, 0), (max(0, 60 - i), 128), (6, 20, 66), 12)              # a second from the same corner
        w_.write(f)
    w_.release()
    sweep.replay(str(fan), [str(a), str(b)], [45, 45], [[1.0, 2.6]], str(out), (72, 128))
    frames = _read(out)
    seen_new = False
    for f in frames:
        px = f[120, 70]
        if px[0] > 150 and px[2] < 100:
            seen_new = True
        elif seen_new and px.max() > 120:
            assert not (px[2] > 150 and px[0] < 100), "the old look came back"


def test_a_dark_cape_inside_the_frame_is_not_the_blade(tmp_path):
    # fan run real23: the original's burgundy velvet cape matched the blade colour and was drawn as wood on her
    # legs; a fan blade always reaches the frame edge from its hub
    fan = tmp_path / "fan.mp4"
    w_ = cv2.VideoWriter(str(fan), cv2.VideoWriter_fourcc(*"mp4v"), 30, (72, 128))
    for i in range(30):
        f = np.full((128, 72, 3), (160, 200, 220), np.uint8)
        cv2.rectangle(f, (20 + i // 3, 60), (50 + i // 3, 100), (6, 20, 66), -1)   # a big dark cape, moving a little
        w_.write(f)
    w_.release()
    masks, _, _ = sweep._dark_masks(str(fan), *sweep.BLADE_HSV)
    assert max(m.mean() for m in masks) == 0


# v12's fan (the one the user liked, 2026-10-14): our blade picture turning round a hub at a steady speed, a
# blade lying across her at each moment the original's blade covers her body. Those moments are measured: when
# the blade first covers most of her body (the middle of the hidden cut was ~0.4s late, fan run real23).
def test_cover_times_are_when_the_blade_first_covers_most_of_her_body(tmp_path):
    fan = tmp_path / "fan.mp4"
    w_ = cv2.VideoWriter(str(fan), cv2.VideoWriter_fourcc(*"mp4v"), 30, (72, 128))
    for i in range(90):
        f = np.full((128, 72, 3), (160, 200, 220), np.uint8)
        top = -128 + i * 4                                  # a dark band coming down over her
        cv2.rectangle(f, (0, top), (72, top + 128), (6, 20, 66), -1)
        w_.write(f)
    w_.release()
    t = sweep.cover_times(str(fan), [[0.5, 2.5]])
    assert len(t) == 1 and 0.6 < t[0] < 1.0              # the band covers 80% of her at ~0.8s, all of her at 0.9s


def test_the_v12_fan_draws_a_shadowed_blade_and_the_hub(tmp_path):
    a, b, out = tmp_path / "a.mp4", tmp_path / "b.mp4", tmp_path / "out.mp4"
    _solid(a, (200, 200, 200), 60); _solid(b, (200, 200, 200), 60)
    sweep.compose([str(a), str(b)], [60, 60], [2.0], str(out), (144, 256))
    f = _read(out)[60]
    assert f[2, 2].max() < 150                               # the hub in the top-left corner
    assert (f.max(axis=2) < 120).mean() > 0.1                # a dark blade across the frame


H = {"x-internal-service-key": "k"}


def test_route_joins_the_looks_with_the_fan(client, media_dir):
    a, b, fan, out = media_dir / "a.mp4", media_dir / "b.mp4", media_dir / "fan.mp4", media_dir / "out.mp4"
    _solid(a, (0, 0, 255), 45); _solid(b, (255, 0, 0), 45)
    w_ = cv2.VideoWriter(str(fan), cv2.VideoWriter_fourcc(*"mp4v"), 30, (72, 128))
    for i in range(90):
        f = np.full((128, 72, 3), (160, 200, 220), np.uint8)
        top = -128 + i * 4
        cv2.rectangle(f, (0, top), (72, top + 128), (6, 20, 66), -1)
        w_.write(f)
    w_.release()
    r = client.post("/media/fan-sweep", json={"original": str(fan), "segments": [str(a), str(b)], "counts": [45, 45], "covered": [[0.5, 2.5]], "out": str(out), "width": 72, "height": 128}, headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["path"] == str(out) and len(r.json()["cover_times"]) == 1
    assert len(_read(out)) == 90


def test_route_refuses_mismatched_looks_and_cuts(client, media_dir):
    r = client.post("/media/fan-sweep", json={"original": str(media_dir / "x.mp4"), "segments": ["a", "b", "c"], "counts": [1, 1], "covered": [[0, 1]], "out": str(media_dir / "o.mp4"), "width": 72, "height": 128}, headers=H)
    assert r.status_code == 400


def test_route_writes_only_inside_the_media_cache(client, media_dir, tmp_path_factory):
    outside = tmp_path_factory.mktemp("elsewhere") / "o.mp4"
    a = media_dir / "a.mp4"; _solid(a, (0, 0, 255), 5)
    r = client.post("/media/fan-sweep", json={"original": str(a), "segments": [str(a), str(a)], "counts": [5, 5], "covered": [[0, 0.1]], "out": str(outside), "width": 72, "height": 128}, headers=H)
    assert r.status_code == 400
