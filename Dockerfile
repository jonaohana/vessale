FROM node:20-slim

# System deps for Chrome/Chromium to run
RUN apt-get update && apt-get install -y \
    ca-certificates fonts-liberation xdg-utils \
    libasound2 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdbus-1-3 libdrm2 libgbm1 libnspr4 libnss3 \
    libx11-6 libx11-xcb1 libxcomposite1 libxdamage1 \
    libxext6 libxfixes3 libxrandr2 libxrender1 libxshmfence1 \
    libxkbcommon0 libpango-1.0-0 libpangocairo-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps (this will download a compatible Chromium)
COPY package*.json ./
RUN npm ci

# App code
COPY . .

# Helpful in constrained environments
ENV PUPPETEER_CACHE_DIR=/usr/local/share/puppeteer

# Build (if you have one) then start
CMD ["node", "index.js"]