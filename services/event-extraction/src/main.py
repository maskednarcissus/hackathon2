"""Classroom Intelligence — Event Extraction Service (uvicorn entrypoint, port 8007)."""

from event_extraction.app import create_app
from event_extraction.config import dependencies_from_env

app = create_app(dependencies_from_env())

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8007)
