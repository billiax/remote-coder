# Response Format

When a session has **tools** registered (persistent or ephemeral), the agent must respond with **raw JSON only** — no markdown fences, no text before or after. The entire response is a single JSON object.

---

## Message Response

Use when replying to the user with text.

```json
{"type": "message", "content": "Your reply here. Supports markdown."}
```

### Rules for `content`

- The value is a **JSON string** — all special characters must be escaped:
  - Newlines → `\n`
  - Quotes → `\"`
  - Backslashes → `\\`
- Example with code block:

```json
{"type": "message", "content": "Here is the code:\n\n```js\nconst x = 1;\n```\n\nDone."}
```

---

## Request Response

Use when you need information from the external system (browser, UI, etc.).

### Single request (no params)

```json
{"type": "requests", "requests": [{"name": "screenshot"}]}
```

### Single request (with params)

```json
{"type": "requests", "requests": [{"name": "click", "params": {"selector": "#submit"}}]}
```

### Multiple requests

```json
{"type": "requests", "requests": [{"name": "screenshot"}, {"name": "console_logs"}]}
```

### With explanation text

```json
{"type": "requests", "content": "Let me check the page first.", "requests": [{"name": "screenshot"}]}
```

---

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"message"` or `"requests"` | yes | Response type |
| `content` | string | yes for message, optional for requests | Text content / explanation |
| `requests` | array | yes for requests | List of `{name, params?}` objects |

### Request object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Tool name (must match a registered tool) |
| `params` | object | no | Key-value parameters for the tool |

---

## Critical Rules

1. Your **entire** response must be a single JSON object — nothing else
2. No markdown fences, no explanation text, no preamble
3. The JSON must be valid and parseable by `JSON.parse()`
4. After sending requests, **wait** for results — do not guess or hallucinate results
5. Do not use built-in tools (Read, Write, Bash) for things that requests provide
6. Use `\n` for newlines inside string values — never raw line breaks inside a string
