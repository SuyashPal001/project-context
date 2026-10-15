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
