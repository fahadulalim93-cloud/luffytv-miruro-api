FROM python:3.12-slim

WORKDIR /app

# Install dependencies first (cached layer)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy app code
COPY main.py .

# Environment
ENV PORT=8080
ENV WORKERS=1
EXPOSE 8080

# Run with uvicorn (single worker for VPS, set WORKERS=2-4 for higher load)
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers ${WORKERS} --no-access-log
