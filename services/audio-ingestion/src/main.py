"""Classroom Intelligence — Audio Ingestion Service (uvicorn entrypoint).

Run: ``uvicorn main:app --app-dir src --port 8001``
"""

from audio_ingestion.app import create_app

app = create_app()
