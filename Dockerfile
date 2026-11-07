# Match the Playwright NPM package exactly with the preinstalled Chromium version.
FROM mcr.microsoft.com/playwright:v1.55.0-noble

# Virtual display is used ONLY by the manual, short-lived login service.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    xvfb x11vnc novnc websockify && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
COPY integrations ./integrations
COPY Dockerfile compose.yaml ./

# Named-volume mount inherits permissions from this image on first creation.
RUN mkdir -p /home/pwuser/.tosano-copilot \
    && chown -R pwuser:pwuser /home/pwuser/.tosano-copilot /app
USER pwuser
ENV HOME=/home/pwuser PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
EXPOSE 3788 6080
CMD ["node", "src/server.mjs"]
