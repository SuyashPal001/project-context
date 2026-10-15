# Golden truth for the body reading, labelled by eye from frames (2026-10-15). Different
# kinds of reel on purpose: groups, empty shots, a throw, a split screen, a close-up, a still
# graphic, a lying-down reel. Needs GOLDEN_VIDEOS_DIR (fan_reel, x, fb, li, sony .mp4).
import os, pytest
from pathlib import Path

GOLD = os.environ.get("GOLDEN_VIDEOS_DIR")
pytestmark = pytest.mark.skipif(not GOLD, reason="set GOLDEN_VIDEOS_DIR to the folder holding the golden reels")
H = {"x-internal-service-key": "k"}

def _read(client, media_dir, name, times, half=0.3, **kw):
    src = Path(GOLD) / f"{name}.mp4"; dst = media_dir / f"{name}.mp4"
    if not dst.exists():
        dst.write_bytes(src.read_bytes())
    looks = [{"label": f"t{t}", "start_s": max(0, t - half), "end_s": t + half} for t in times]
    r = client.post("/media/pose", json={"path": str(dst), "looks": looks, **kw}, headers=H)
    assert r.status_code == 200, r.text
    return {l["label"]: l for l in r.json()["looks"]}, r.json()

def test_groups_and_empty_shots_on_the_disc_golf_reel(client, media_dir):
    L, _ = _read(client, media_dir, "x", [2, 10, 14, 22, 34, 50, 62])
    for t in (2, 14, 22):
        assert L[f"t{t}"]["people"] >= 4, (t, L[f"t{t}"]["people"])
    assert L["t34"]["people"] == 2
    for t in (10, 50, 62):
        assert L[f"t{t}"]["no_person"] is True, t

def test_single_person_readings_on_the_disc_golf_reel(client, media_dir):
    # labels checked on full-size frames: at 18s and 30s the shins are cut by the frame (no feet);
    # at 26s (mid-throw) the whole body is in frame
    L, _ = _read(client, media_dir, "x", [18, 26, 30])
    for t in (18, 30):
        m = L[f"t{t}"]["main_end"]
        assert m["framing"] == "knees_up" and m["orientation"] == "vertical", (t, m)
    m26 = L["t26"]["main_end"]
    # 26s: both feet touch the frame's bottom edge — full body or cut by a hair, either is fair
    assert m26["framing"] in ("full_body", "knees_up") and set(m26["arms"].values()) & {"raised"}

def test_split_screen_counts_both_people(client, media_dir):
    # both panels' people; background passers-by count too (26s has one on a scooter)
    L, _ = _read(client, media_dir, "fb", [8, 14, 20, 26])
    for t in (8, 14, 20):
        assert L[f"t{t}"]["people"] >= 2, (t, L[f"t{t}"]["people"])
    assert L["t26"]["people"] == 3

def test_close_up_and_empty_end_on_the_sony_ad(client, media_dir):
    L, _ = _read(client, media_dir, "sony", [21, 45])
    assert L["t21"]["people"] == 1 and L["t21"]["main_end"]["framing"] in ("chest_up", "face")
    assert L["t45"]["no_person"] is True

def test_a_still_graphic_has_one_person_and_no_movement(client, media_dir):
    L, d = _read(client, media_dir, "li", [9])
    assert L["t9"]["people"] == 1 and L["t9"]["main_end"]["framing"] != "full_body"
    src = Path(GOLD) / "li.mp4"
    whole = client.post("/media/pose", json={"path": str(media_dir / "li.mp4"), "looks": [{"label": "all", "start_s": 0, "end_s": 18.9}]}, headers=H).json()
    assert whole["moves"] == [] and whole["camera_moves"] == []

def test_lying_down_reel_leg_sides_and_slide(client, media_dir):
    src = Path(GOLD) / "fan_reel.mp4"; dst = media_dir / "fan_reel.mp4"; dst.write_bytes(src.read_bytes())
    looks = [{"label": "a", "start_s": 0, "end_s": 5.47}, {"label": "b", "start_s": 5.47, "end_s": 9.32},
             {"label": "c", "start_s": 9.32, "end_s": 12.82}, {"label": "d", "start_s": 12.82, "end_s": 14.9}]
    d = client.post("/media/pose", json={"path": str(dst), "looks": looks, "exclude": [[4.6, 6.2], [8.5, 9.9], [12.3, 13.5]]}, headers=H).json()
    assert [l["leg_side_end"] for l in d["looks"]] == ["image-right", "image-left", "image-right", "image-left"]
    assert d["looks"][0]["leg_side_start"] == "center"
    assert all(l["people"] == 1 and l["main_end"]["orientation"] == "vertical" for l in d["looks"])
    assert any(m["area"] == "lower" and "image-right" in m["direction"] and 2.75 <= m["t_s"] <= 3.75 for m in d["moves"])
    # the remote is raised at ~1.25s: the upper body moves up
    assert any(m["area"] == "upper" and "image-up" in m["direction"] and 0.9 <= m["t_s"] <= 1.6 for m in d["moves"])
    # feet are in shot (lying full length), and no move is reported right next to a blade pass
    assert all(l["main_end"]["framing"] == "full_body" for l in d["looks"])
    covered = [[4.6, 6.2], [8.5, 9.9], [12.3, 13.5]]
    assert not any(a - 0.5 <= m["t_s"] <= b + 0.5 for m in d["moves"] for a, b in covered)
    assert len(d["moves"]) <= 10
