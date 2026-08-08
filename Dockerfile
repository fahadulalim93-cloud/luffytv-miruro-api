# Miruro API v3.1 — with Playwright for CF Turnstile bypass
FROM python:3.12-slim AS builder
WORKDIR /app
COPY requirements.txt ./
RUN apt-get update && apt-get install -y --no-install-recommends gcc libcurl4-openssl-dev && \
    pip install --no-cache-dir -r requirements.txt && \
    apt-get purge -y gcc && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

FROM python:3.12-slim
WORKDIR /app

# Install ALL system deps needed for both curl_cffi + Playwright Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcurl4 \
    # Playwright / Chromium browser deps
    libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libnspr4 libnss3 libxss1 \
    libdbus-1-3 libexpat1 libfontconfig1 libfreetype6 \
    libglib2.0-0 libharfbuzz0b libicu72 libjpeg62-turbo \
    liblcms2-2 libopenjp2-7 libpcre3 libpng16-16t64 \
    libsnappy1v5 libtiff6 libvpx9 libwebp7 libwebpdemux2 \
    libx11-6 libx11-xcb1 libxcb1 libxext6 libxml2 \
    libxslt1.1 fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# Install Playwright Chromium (no --with-deps since we installed deps above)
RUN playwright install chromium

COPY main.py ./

# Coolify sets PORT env var — use it if available, fallback to 8000
ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers 2"]
