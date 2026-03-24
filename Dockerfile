FROM node:20-slim

# Install curl and bash for OpenCode installer
RUN apt-get update && apt-get install -y curl bash && rm -rf /var/lib/apt/lists/*

# Install Claude CLI
RUN npm install -g @anthropic-ai/claude-code

# Install OpenCode
RUN curl -fsSL https://opencode.ai/install | bash
ENV PATH="/root/.opencode/bin:$PATH"

# App setup
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript and copy static assets
RUN npx tsc && cp -r src/public dist/public && cp src/system-prompt.md src/tools-prompt.md dist/

# OpenCode config — copy your config/opencode.json or fall back to example
RUN mkdir -p /root/.config/opencode
COPY config/opencode.json* config/opencode.json.example /tmp/oc-cfg/
RUN cp /tmp/oc-cfg/opencode.json /root/.config/opencode/opencode.json 2>/dev/null \
    || cp /tmp/oc-cfg/opencode.json.example /root/.config/opencode/opencode.json \
    && rm -rf /tmp/oc-cfg

# Workspaces volume
RUN mkdir -p /app/workspaces

ENV PORT=3333
EXPOSE 3333

CMD ["node", "dist/server.js"]
