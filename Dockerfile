FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./

# Single worker only: the device-presence SSE registry (_devices) and the YouTube
# stream URL cache (_stream_cache) are in-memory and per-process. Running with
# --workers N would split requests across processes with separate state, breaking
# device handoff and stream caching.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
