# Classroom Intelligence

AI-powered classroom capture, academic intelligence and student coordination platform.

## Overview

Classroom Intelligence transforms ordinary lectures into structured, searchable and actionable academic information. It combines dedicated classroom audio hardware with AI-powered software to serve students, professors, academic coordinators, campus administrators and education group executives.

## Repository Structure

```
classroom-intelligence/
├── apps/           # Next.js web applications and API
├── services/       # Domain microservices
├── packages/       # Shared libraries and design system
├── hardware/       # Firmware and device protocol
├── infrastructure/ # Terraform, Docker and deployment
├── data/           # Database model, migrations and seed data
├── docs/           # Architecture, security and operations docs
└── tests/          # Evaluation, integration and e2e test suites
```

## Prerequisites

- Node.js 20+
- pnpm 9+
- Python 3.12+
- Docker

## Getting started

```bash
pnpm install
pnpm dev
```

## Documentation

See [`docs/`](./docs/) for architecture, hardware, integration and security documentation.

## Standards

See [`STANDARDS.md`](./STANDARDS.md) for mandatory engineering, AI, hardware, security and data standards.
