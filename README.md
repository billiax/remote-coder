# Remote Coder

A remote AI coding agent you can control via API. Supports multiple AI engines (Claude Code, OpenCode) and models (Anthropic, OpenAI, Gemini, and more) through a single HTTP API and web UI.

**What it does:** You send coding tasks via API or the browser UI, and the agent reads, writes, and edits files in isolated workspaces. Sessions persist — you can send follow-up messages to continue where you left off.

## Quick Start (Docker)

```bash
# Clone and configure
git clone https://github.com/billiax/remote-coder.git
cd remote-coder
cp .env.example .env
```

Edit `.env` — you need at least one engine configured:

```bash
# For Claude engine (pick one):
CLAUDE_CODE_OAUTH_TOKEN=your-token    # from Claude Code CLI login
# or
ANTHROPIC_API_KEY=sk-ant-...          # from console.anthropic.com

# Optional: protect the API
API_KEY=your-secret-key
```

Then run:

```bash
docker compose up -d
```

Open **http://localhost:3333** — that's it.

## Configuration

All configuration is via environment variables in `.env`:

### Server

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3333` |
| `API_KEY` | Require `X-API-Key` header on API routes | _(none, open)_ |
| `DEFAULT_ENGINE` | Default engine when not specified | `claude` |
| `BASE_DIR` | Where workspace directories are created | `./workspaces` |
| `ALLOWED_WORKSPACES` | Comma-separated whitelist of workspace names | _(any)_ |
| `MCP_CONFIG` | Path to MCP config JSON (for Context7 etc.) | _(none)_ |

### Claude Engine

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key — uses Claude Agent SDK |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token — uses Claude Code CLI |
| `ANTHROPIC_BASE_URL` | Route API calls through a proxy |

Set **one** of `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. If both are set, the API key takes priority (SDK mode).

### OpenCode Engine

| Variable | Description |
|----------|-------------|
| `OPENCODE_PROVIDER_API_KEY` | API key for your OpenAI-compatible proxy |

OpenCode requires a provider config file at `config/opencode.json` (see below).

## Engines & Models

### Claude

Models: `sonnet`, `opus`, `haiku` (aliases), or any full model ID.

```bash
curl -X POST http://localhost:3333/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_KEY" \
  -d '{
    "message": "create a hello.ts file",
    "workspace": "my-project",
    "engine": "claude",
    "model": "sonnet"
  }'
```

### OpenCode

Works with any OpenAI-compatible proxy. Configure your provider in `config/opencode.json`:

```bash
cp config/opencode.json.example config/opencode.json
```

Edit `config/opencode.json`:

```json
{
  "provider": {
    "custom": {
      "api": "https://your-proxy.example.com/v1",
      "env": ["OPENCODE_PROVIDER_API_KEY"],
      "models": {
        "gpt-5": { "name": "GPT-5" },
        "gpt-5-mini": { "name": "GPT-5 Mini" }
      }
    }
  }
}
```

Then use it:

```bash
curl -X POST http://localhost:3333/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_KEY" \
  -d '{
    "message": "build a REST API",
    "workspace": "my-project",
    "engine": "opencode",
    "model": "custom/gpt-5"
  }'
```

OpenCode also has free built-in models (no API key needed):
- `opencode/big-pickle`
- `opencode/gpt-5-nano`

## API Reference

All endpoints return JSON. Set `X-API-Key` header if `API_KEY` is configured.

### POST /chat

Send a message to a coding agent. Creates a new session or continues an existing one.

```json
{
  "message": "your task",
  "workspace": "project-name",
  "engine": "claude",
  "model": "sonnet",
  "sessionId": "optional-resume-id"
}
```

Response:

```json
{
  "sessionId": "abc-123",
  "response": "Created the file...",
  "isError": false,
  "durationMs": 5000,
  "costUsd": 0.05,
  "workspace": "project-name",
  "model": "sonnet",
  "engine": "claude"
}
```

### GET /sessions

List all active sessions.

### GET /sessions/:id/history

Get message history for a session.

### POST /sessions/:id/compact

Compact session context (Claude only).

### DELETE /sessions/:id

Delete a session.

### GET /health

Health check (no auth required). Returns `{"status":"ok","engine":"claude"}`.

## Web UI

Open `http://localhost:3333` in your browser. If `API_KEY` is set, pass it via URL on first visit:

```
http://localhost:3333/?apiKey=your-secret-key
```

The key is saved in localStorage — you only need to do this once.

## Deploy to Kubernetes (AKS)

### Prerequisites

- Azure Container Registry (ACR) attached to your AKS cluster
- `kubectl` access to the cluster
- GitHub repo with these **variables** (Settings > Variables):
  - `ACR_NAME` — your ACR name
  - `AKS_CLUSTER` — AKS cluster name
  - `AKS_RG` — resource group
- GitHub repo **secrets**:
  - `AZURE_CREDENTIALS` — service principal JSON
  - `REMOTE_CODER_API_KEY` — API key for the service
  - `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`
  - `OPENCODE_PROVIDER_API_KEY` (optional)

### Deploy

Push to `main` triggers the CI/CD pipeline automatically. Or deploy manually:

```bash
# First time
./k8s/install.sh install

# Update after changes
./k8s/install.sh update

# Check status
./k8s/install.sh status
```

## Development

```bash
npm install
cp .env.example .env
# Edit .env with your keys
npm run dev
```

## Architecture

```
HTTP API / Web UI
      │
  Express server (src/server.ts)
      │
  Agent Factory (src/agent-factory.ts)
      ├── Claude Code (src/claude-session.ts)
      │     ├── SDK mode (ANTHROPIC_API_KEY)
      │     └── CLI mode (CLAUDE_CODE_OAUTH_TOKEN)
      └── OpenCode (src/opencode-session.ts)
            └── CLI mode (opencode run --format json)
```

Each session gets an isolated workspace directory. Files created by the agent live in `workspaces/<name>/`.

## License

ISC
