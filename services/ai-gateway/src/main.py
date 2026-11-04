"""Classroom Intelligence — AI Gateway Service (uvicorn entry point: ``main:app``)."""

from ai_gateway.app import create_app

app = create_app()
