# syntax=docker/dockerfile:1
# Python analytics job (M04/M08–M11) and platform backup/verification (D-030).
#   default:  python -m futuregrow_analytics.scheduled  (analytics drain, then backup/verify when due)
#   backups:  python -m futuregrow_analytics.backup create | verify [--restore-into URL]
FROM python:3.13.16-slim-bookworm@sha256:f040863673aea2570c3ff6a5c3fb4c673a016cbc5375005ad145915922b6b78a
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY jobs/analytics/requirements.txt ./
RUN pip install --only-binary=:all: -r requirements.txt \
 && useradd --uid 10001 --create-home analytics
COPY jobs/analytics/futuregrow_analytics ./futuregrow_analytics
USER analytics
CMD ["python", "-m", "futuregrow_analytics.scheduled"]
