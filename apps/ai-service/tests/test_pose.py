from conftest import ff

H = {"x-internal-service-key": "k"}

def test_route_rejects_a_bad_look(client, media_dir):
    p = media_dir / "s.mp4"
    ff(["-f", "lavfi", "-i", "color=gray:s=180x320:d=1:r=25", "-c:v", "libx264", str(p)])
    body = {"path": str(p), "looks": [{"label": "a", "start_s": 2, "end_s": 1}]}
    assert client.post("/media/pose", json=body, headers=H).status_code == 400

def test_an_empty_video_reads_as_no_person_with_no_movement(client, media_dir):
    p = media_dir / "empty.mp4"
    ff(["-f", "lavfi", "-i", "color=gray:s=180x320:d=2:r=25", "-c:v", "libx264", str(p)])
    d = client.post("/media/pose", json={"path": str(p), "looks": [{"label": "a", "start_s": 0, "end_s": 2}]}, headers=H).json()
    assert d["looks"][0]["no_person"] is True and d["looks"][0]["people"] == 0
    assert d["moves"] == [] and d["camera_moves"] == []
