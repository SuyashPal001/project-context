def test_rejects_missing_key(client, media_dir):
    r = client.post("/media/sound", json={"path": str(media_dir / "a.mp4")})
    assert r.status_code == 401

def test_rejects_path_outside_media_dir(client):
    r = client.post("/media/sound", json={"path": "/etc/passwd"}, headers={"x-internal-service-key": "k"})
    assert r.status_code == 400

def test_rejects_traversal(client, media_dir):
    r = client.post("/media/sound", json={"path": str(media_dir / ".." / "x.mp4")}, headers={"x-internal-service-key": "k"})
    assert r.status_code == 400
