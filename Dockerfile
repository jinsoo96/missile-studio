# missile-studio container: web UI + API on :7700, config/data in /data (mount it).
# Node is included so stdio MCP servers published on npm (`npx -y ...`) work inside the container.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 \
    MISSILE_HOME=/data MISSILE_HOST=0.0.0.0 MISSILE_PORT=7700

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml README.md LICENSE ./
COPY src ./src
RUN pip install --no-cache-dir . && npm install -g npm@latest >/dev/null 2>&1 || true

VOLUME ["/data"]
EXPOSE 7700
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -fsS http://127.0.0.1:7700/api/health || exit 1

# Token: set MISSILE_TOKEN in the environment (or let the server generate one and print it on first start).
CMD ["sh", "-c", "missile serve --host ${MISSILE_HOST} --port ${MISSILE_PORT} ${MISSILE_TOKEN:+--token $MISSILE_TOKEN}"]
