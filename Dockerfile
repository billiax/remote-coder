FROM node:20-slim

# Install Claude CLI
RUN npm install -g @anthropic-ai/claude-code

# App setup
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript and copy static assets
RUN npx tsc && cp -r src/public dist/public

# Workspaces volume
RUN mkdir -p /app/workspaces

ENV PORT=3333
EXPOSE 3333

CMD ["node", "dist/server.js"]
