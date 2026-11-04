"""Classroom Intelligence — Audio Processing Service (uvicorn entrypoint).

Run: ``uvicorn main:app --app-dir src --port 8002``
"""

from audio_processing.app import create_app

app = create_app()
