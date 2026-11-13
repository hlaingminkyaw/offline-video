# Works on Render (Docker web service) and Hugging Face Spaces (Docker SDK).
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
      -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && chown 1000:1000 /usr/local/bin/yt-dlp

WORKDIR /app
COPY server/package.json server/
RUN cd server && npm install --omit=dev && npm cache clean --force
COPY server/ server/
COPY public/ public/
# writable folder for catalog.json (HF persistent storage at /data is used automatically if enabled)
RUN mkdir -p server/data && chown -R 1000:1000 server/data

ENV NODE_ENV=production PORT=7860
EXPOSE 7860

# "node" user = uid 1000 (required by Hugging Face Spaces)
USER node

# Update yt-dlp on every start – YouTube changes often.
CMD ["sh", "-c", "yt-dlp -U || true; exec node server/server.js"]
