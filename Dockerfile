# Miruro API v3.1 — with Playwright for CF Turnstile bypass
FROM python:3.12-slim AS builder
WORKDIR /app
COPY requirements.txt ./
RUN apt-get update && apt-get install -y --no-install-recommends gcc libcurl4-openssl-dev && \
    pip install --no-cache-dir -r requirements.txt && \
    apt-get purge -y gcc && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

FROM python:3.12-slim
WORKDIR /app

# Install Playwright browser dependencies + runtime libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcurl4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libnspr4 libnss3 libxss1 \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# Install Playwright Chromium (headless, for CF bypass)
RUN playwright install chromium --with-deps

COPY main.py ./

# Coolify sets PORT env var — use it if available, fallback to 8000
ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers 2"]
