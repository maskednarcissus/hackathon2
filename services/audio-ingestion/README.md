# Audio Ingestion Service

Receives, validates and stores raw audio uploads from classroom devices. Handles chunked uploads, integrity verification via SHA-256 checksums, and publishes events to downstream processing pipeline.

## Technology

Python · FastAPI · Google Cloud Storage · Pub/Sub
