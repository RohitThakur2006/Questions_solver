from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

def test_health_check():
    response = client.get("/")
    assert response.status_code == 200
    assert response.json()["status"] == "running"

def test_get_prompts():
    response = client.get("/prompts")
    assert response.status_code == 200
    data = response.json()
    assert "mcq_answer_only" in data
    assert "mcq_with_explanation" in data
    assert "code_explanation" in data
    assert "name" in data["mcq_answer_only"]
    assert "description" in data["mcq_answer_only"]

def test_capture_invalid_prompt():
    response = client.post("/capture", json={"prompt_key": "invalid_key"})
    assert response.status_code == 400
