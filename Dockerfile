FROM node:20-alpine

WORKDIR /app

# Install dependencies inside the container's native filesystem
COPY package.json ./
RUN npm install --omit=dev

# Copy application source and persistent data directory
COPY src ./src
COPY public ./public
COPY data ./data

ENV PORT=3456
ENV WA_AUTH_DIR=/app/data/wa-auth

EXPOSE 3456

CMD ["node", "src/server.js"]
