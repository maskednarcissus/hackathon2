"""Classroom Intelligence — Speaker Diarization entrypoint (``uvicorn main:app --port 8004``)."""

from speaker_diarization.app import create_app
from speaker_diarization.config import deps_from_env

app = create_app(deps_from_env())

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8004)  # noqa: S104
