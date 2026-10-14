import os, subprocess
import numpy as np

_MODEL = None

def _model():
    global _MODEL
    if _MODEL is None:
        import torch, transnetv2_pytorch as T
        from transnetv2_pytorch import TransNetV2
        m = TransNetV2(device="cpu")
        m.load_state_dict(torch.load(os.path.join(os.path.dirname(T.__file__), "transnetv2-pytorch-weights.pth"), map_location="cpu"))
        m.eval()
        _MODEL = m
    return _MODEL

def _fps(path: str) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", path], capture_output=True, text=True, check=True).stdout.strip()
    n, d = out.split("/")
    return float(n) / float(d)

def find_cuts(path: str, threshold: float = 0.5) -> dict:
    import torch
    m = _model()
    with torch.no_grad():
        _, single, allp = m.predict_video(path, quiet=True)
    single = np.asarray(single).ravel()
    allp = np.asarray(allp).ravel()
    fps = _fps(path)
    scenes = m.predictions_to_scenes(single, threshold=threshold)
    cuts = [round(float(s[0]) / fps, 2) for s in scenes[1:]]
    fades, i, on = [], 0, allp > 0.3
    while i < len(on):
        if on[i]:
            j = i
            while j < len(on) and on[j]:
                j += 1
            if j - i >= 4:  # multi-frame span = gradual transition
                fades.append([round(i / fps, 2), round((j - 1) / fps, 2)])
            i = j
        else:
            i += 1
    return {"cuts": cuts, "fades": fades, "duration_s": round(len(single) / fps, 2)}
