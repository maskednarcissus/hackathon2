"""Classroom Intelligence — Lecture Intelligence Service (uvicorn entry point: ``main:app``)."""

from lecture_intelligence.app import create_app

app = create_app()
