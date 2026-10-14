import os, subprocess, pathlib, pytest
from fastapi.testclient import TestClient

@pytest.fixture()
def media_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("MEDIA_DIR", str(tmp_path))
    monkeypatch.setenv("INTERNAL_SERVICE_KEY", "k")
    return tmp_path

@pytest.fixture()
def client(media_dir):
    import importlib, main
    importlib.reload(main)
    return TestClient(main.app)

def ff(args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)
