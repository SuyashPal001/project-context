# Still body reading: the same general reading as video looks, for ONE image.
import numpy as np
import cv2
from media import pose
from test_pose_general import person

H = {"x-internal-service-key": "k"}

class FakeDet:
    def __init__(self, boxes): self.boxes = boxes
    def __call__(self, img): return np.asarray(self.boxes, dtype=float)

class FakePose:
    def __init__(self, people): self.people = people  # list of (kp fractions, scores)
    def __call__(self, img, bboxes):
        h, w = img.shape[:2]
        kps = np.stack([kp * np.array([w, h]) for kp, _ in self.people[: len(bboxes)]])
        scs = np.stack([sc for _, sc in self.people[: len(bboxes)]])
        return kps, scs

def _img(tmp_path, name="still.jpg"):
    p = tmp_path / name
    cv2.imwrite(str(p), np.full((200, 100, 3), 128, np.uint8))
    return p

def test_one_standing_person_reads_full_body_upright(tmp_path, monkeypatch):
    kp, sc = person()
    monkeypatch.setattr(pose, "_load", lambda: (FakeDet([[10, 10, 90, 190]]), FakePose([(kp, sc)])))
    d = pose.read_image(str(_img(tmp_path)))
    assert d["people"] == 1 and d["no_person"] is False
    assert d["main"]["orientation"] == "vertical" and d["main"]["knees"] == "straight"

def test_no_detection_is_no_person_not_unknown(tmp_path, monkeypatch):
    monkeypatch.setattr(pose, "_load", lambda: (FakeDet(np.zeros((0, 4))), FakePose([])))
    d = pose.read_image(str(_img(tmp_path)))
    assert d == {"model": pose.MODEL_NAME, "people": 0, "no_person": True, "main": None}

def test_main_person_is_the_largest(tmp_path, monkeypatch):
    big, sc = person(); small, sc2 = person(knee=(70, 70))
    monkeypatch.setattr(pose, "_load", lambda: (FakeDet([[40, 40, 60, 80], [5, 5, 95, 195]]), FakePose([(small, sc2), (big, sc)])))
    d = pose.read_image(str(_img(tmp_path)))
    assert d["people"] == 2 and d["main"]["knees_toward"] == "center"

def test_route_rejects_an_unreadable_image(client, media_dir):
    p = media_dir / "bad.jpg"; p.write_bytes(b"not an image")
    r = client.post("/media/pose-image", json={"path": str(p)}, headers=H)
    assert r.status_code == 400

# Framing check (2026-10-17): the camera came out closer or shifted on several runs and no check saw it.
# The still's reading carries where the main person sits in the frame, to compare with the original's.
def test_reading_carries_the_main_persons_box_in_frame_fractions(tmp_path, monkeypatch):
    kp, sc = person()
    monkeypatch.setattr(pose, "_load", lambda: (FakeDet([[10, 20, 90, 180]]), FakePose([(kp, sc)])))
    d = pose.read_image(str(_img(tmp_path)))
    assert d["box"] == [0.1, 0.1, 0.9, 0.9]

# A fan blade over her head in the original made her box start lower, and the framing check called the
# remake's camera "closer" (fan run real7, 2026-10-17). The reading says whether the head is seen, so the
# box's top edge is only trusted when it is.
def test_reading_says_whether_the_head_is_seen(tmp_path, monkeypatch):
    kp, sc = person()
    monkeypatch.setattr(pose, "_load", lambda: (FakeDet([[10, 20, 90, 180]]), FakePose([(kp, sc)])))
    assert pose.read_image(str(_img(tmp_path)))["head_seen"] is True
    kp, sc = person(hide=(0, 1, 2, 3, 4))
    monkeypatch.setattr(pose, "_load", lambda: (FakeDet([[10, 20, 90, 180]]), FakePose([(kp, sc)])))
    assert pose.read_image(str(_img(tmp_path)))["head_seen"] is False

# Under the blade the pose model still guesses a head, at about half confidence (fan run real8: 0.53 under
# the blade, 0.9 to 1.1 when seen); a guessed head is not a seen one.
def test_a_half_confident_head_is_a_guess_not_seen(tmp_path, monkeypatch):
    kp, sc = person()
    sc[:5] = 0.53
    monkeypatch.setattr(pose, "_load", lambda: (FakeDet([[10, 20, 90, 180]]), FakePose([(kp, sc)])))
    assert pose.read_image(str(_img(tmp_path)))["head_seen"] is False

# The original's frame is the pose reference for every remake photo, and its actress's face leaked into ours
# (fan run real15: our woman drifted from the approved sheet toward her). The reading gives the head's box so
# the face can be hidden before the frame is shown to an image model.
def test_reading_gives_the_head_box_when_the_head_is_seen(tmp_path, monkeypatch):
    kp, sc = person()
    monkeypatch.setattr(pose, "_load", lambda: (FakeDet([[10, 20, 90, 180]]), FakePose([(kp, sc)])))
    d = pose.read_image(str(_img(tmp_path)))
    x0, y0, x1, y1 = d["head"]
    nx, ny = kp[0]
    assert x0 < nx < x1 and y0 < ny < y1 and 0 <= x0 and x1 <= 1
    kp, sc = person(hide=(0, 1, 2, 3, 4))
    monkeypatch.setattr(pose, "_load", lambda: (FakeDet([[10, 20, 90, 180]]), FakePose([(kp, sc)])))
    assert pose.read_image(str(_img(tmp_path)))["head"] is None
