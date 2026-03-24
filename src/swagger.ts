export const swaggerSpec = {
  openapi: "3.0.3",
  info: {
    title: "Remote Coder API",
    version: "1.0.0",
    description:
      "Multi-engine AI coding agent. Send messages, attach images, define tools, and manage sessions.",
  },
  servers: [{ url: "/", description: "This server" }],
  components: {
    securitySchemes: {
      ApiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
    },
    schemas: {
      ChatRequest: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string", description: "Text message to send" },
          workspace: {
            type: "string",
            description: "Directory name (required for new sessions)",
          },
          sessionId: { type: "string", description: "Continue an existing session" },
          model: {
            type: "string",
            default: "sonnet",
            description: "sonnet | opus | haiku | full model ID",
          },
          engine: {
            type: "string",
            enum: ["claude", "opencode"],
            default: "claude",
          },
          images: {
            type: "array",
            description: "Base64-encoded images to include",
            items: {
              type: "object",
              required: ["data", "media_type"],
              properties: {
                data: { type: "string", description: "Base64 image data (no data: prefix)" },
                media_type: {
                  type: "string",
                  enum: ["image/png", "image/jpeg", "image/gif", "image/webp"],
                },
              },
            },
          },
          tools: {
            type: "array",
            description: "Ephemeral tool definitions (one turn only)",
            items: { $ref: "#/components/schemas/ToolDef" },
          },
        },
      },
      ChatResponse: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          response: { type: "string", description: "Claude's text response (message content or explanation text)" },
          requests: {
            nullable: true,
            description: "Parsed requests from Claude's response. null when Claude sends a plain message. When non-null, the client should execute each request and send the results back in the next message as [REQUEST RESULT: <name>] blocks.",
            type: "array",
            items: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string", description: "Name of the requested information source (matches a tool name)" },
                params: {
                  type: "object",
                  additionalProperties: true,
                  description: "Parameters for the request (if any)",
                },
              },
            },
          },
          isError: { type: "boolean" },
          durationMs: { type: "number" },
          costUsd: { type: "number" },
          workspace: { type: "string" },
          model: { type: "string" },
          engine: { type: "string" },
          imageUrls: {
            type: "array",
            items: { type: "string" },
            description: "URLs of uploaded images (only when images were sent)",
          },
        },
      },
      ToolDef: {
        type: "object",
        required: ["name", "description"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          parameters: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                type: { type: "string" },
                description: { type: "string" },
                required: { type: "boolean" },
              },
            },
          },
        },
      },
      HistoryMessage: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["user", "assistant", "system"] },
          content: { type: "string" },
          durationMs: { type: "number" },
          costUsd: { type: "number" },
          timestamp: { type: "number" },
          imageUrls: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  security: [{ ApiKey: [] }],
  paths: {
    "/chat": {
      post: {
        summary: "Send a message",
        description:
          "Start a new session or continue an existing one. Supports images and tools.\n\n**Tool flow:** When you provide `tools`, Claude may respond with `requests` (non-null array) instead of a plain message. Each request has a `name` and optional `params`. Execute the requested actions on your side, then send the results back by calling `/chat` again with the same `sessionId` and a message formatted as `[REQUEST RESULT: <name>]\\n<result data>` for each request. Claude will then continue working with the results.\n\n**Example flow:**\n1. POST /chat with tools → response has `requests: [{name: 'page_snapshot'}]`\n2. Client takes a page snapshot\n3. POST /chat with message `[REQUEST RESULT: page_snapshot]\\n<html>...</html>` → response has `requests: [{name: 'click', params: {selector: '#btn'}}]`\n4. Client clicks the button\n5. POST /chat with message `[REQUEST RESULT: click]\\nClicked successfully` → response has `requests: null` (plain message)",
        tags: ["Chat"],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/ChatRequest" } },
          },
        },
        responses: {
          200: {
            description: "Success",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ChatResponse" } },
            },
          },
          400: { description: "Bad request" },
          500: { description: "Server error" },
        },
      },
    },
    "/sessions": {
      get: {
        summary: "List all sessions",
        tags: ["Sessions"],
        responses: {
          200: {
            description: "Session list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    sessions: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          sessionId: { type: "string" },
                          workspace: { type: "string" },
                          model: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/sessions/{id}/history": {
      get: {
        summary: "Get session history",
        tags: ["Sessions"],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: {
            description: "Message history",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    sessionId: { type: "string" },
                    workspace: { type: "string" },
                    model: { type: "string" },
                    messages: {
                      type: "array",
                      items: { $ref: "#/components/schemas/HistoryMessage" },
                    },
                  },
                },
              },
            },
          },
          404: { description: "Session not found" },
        },
      },
    },
    "/sessions/{id}/compact": {
      post: {
        summary: "Compact session context",
        description: "Compresses conversation context to free token space. Auto-triggers at 200K input tokens.",
        tags: ["Sessions"],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: { description: "Compacted" },
          404: { description: "Session not found" },
        },
      },
    },
    "/sessions/{id}/tools": {
      put: {
        summary: "Set persistent tools",
        description:
          "Replace all persistent tools for a session. These live in the system prompt and survive compaction. Send empty array to clear.",
        tags: ["Tools"],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["tools"],
                properties: {
                  tools: { type: "array", items: { $ref: "#/components/schemas/ToolDef" } },
                },
              },
            },
          },
        },
        responses: {
          200: { description: "Tools updated" },
          404: { description: "Session not found" },
        },
      },
      get: {
        summary: "Get session tools",
        tags: ["Tools"],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: { description: "Current tools" },
          404: { description: "Session not found" },
        },
      },
    },
    "/sessions/{id}": {
      delete: {
        summary: "Delete a session",
        tags: ["Sessions"],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { 200: { description: "Deleted" } },
      },
    },
    "/health": {
      get: {
        summary: "Health check",
        tags: ["System"],
        security: [],
        responses: {
          200: {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string" },
                    engine: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
