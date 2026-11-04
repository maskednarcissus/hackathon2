"""Classroom Intelligence — Transcription Service entrypoint (``uvicorn main:app --port 8003``)."""

from transcription.app import create_app
from transcription.config import deps_from_env

app = create_app(deps_from_env())

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8003)  # noqa: S104
