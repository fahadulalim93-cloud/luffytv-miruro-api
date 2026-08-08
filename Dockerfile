# Miruro API v3.1 — with Playwright for CF Turnstile bypass
# Use official Playwright image (Ubuntu-based, has Python + Chromium + all deps)
FROM mcr.microsoft.com/playwright/python:v1.53.0-noble
WORKDIR /app

# Install build deps + curl_cffi, then clean up
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libcurl4-openssl-dev && \
    pip install --no-cache-dir -r requirements.txt 2>/dev/null || true

# Copy requirements first for caching
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt && \
    apt-get purge -y gcc && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

COPY main.py ./

# Coolify sets PORT env var — use it if available, fallback to 8000
ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers 2"]
