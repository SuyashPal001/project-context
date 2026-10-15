import cv2

def read_frames(path: str):
    """Yield (t_s, frame) with each frame's real timestamp (what ffmpeg -ss seeks to).
    Index / fps drifts on variable-frame-rate reels (review M5)."""
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    i, last = 0, -1.0
    try:
        while True:
            ok, img = cap.read()
            if not ok:
                break
            t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            if t <= last:  # some backends report 0 / repeats; fall back to a steady step
                t = last + 1.0 / fps if last >= 0 else i / fps
            last = t
            yield t, img
            i += 1
    finally:
        cap.release()
