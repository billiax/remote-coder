import { swaggerSpec } from "../../src/swagger";

describe("swaggerSpec", () => {
  it("has valid OpenAPI version", () => {
    expect(swaggerSpec.openapi).toBe("3.0.3");
  });

  it("has title and version", () => {
    expect(swaggerSpec.info.title).toBe("Remote Coder API");
    expect(swaggerSpec.info.version).toBeTruthy();
  });

  it("defines all expected paths", () => {
    const paths = Object.keys(swaggerSpec.paths);
    expect(paths).toContain("/chat");
    expect(paths).toContain("/sessions");
    expect(paths).toContain("/sessions/{id}/history");
    expect(paths).toContain("/sessions/{id}/compact");
    expect(paths).toContain("/sessions/{id}/tools");
    expect(paths).toContain("/sessions/{id}");
    expect(paths).toContain("/health");
  });

  it("defines POST /chat endpoint", () => {
    const chat = swaggerSpec.paths["/chat"];
    expect(chat.post).toBeDefined();
    expect(chat.post.summary).toBeTruthy();
    expect(chat.post.responses["200"]).toBeDefined();
    expect(chat.post.responses["400"]).toBeDefined();
  });

  it("defines GET /health without security", () => {
    const health = swaggerSpec.paths["/health"];
    expect(health.get).toBeDefined();
    expect(health.get.security).toEqual([]);
  });

  it("defines API key security scheme", () => {
    const scheme = swaggerSpec.components.securitySchemes.ApiKey;
    expect(scheme.type).toBe("apiKey");
    expect(scheme.in).toBe("header");
    expect(scheme.name).toBe("X-API-Key");
  });

  it("defines ChatRequest schema", () => {
    const schema = swaggerSpec.components.schemas.ChatRequest;
    expect(schema.type).toBe("object");
    expect(schema.required).toContain("message");
    expect(schema.properties.message).toBeDefined();
    expect(schema.properties.workspace).toBeDefined();
    expect(schema.properties.images).toBeDefined();
    expect(schema.properties.tools).toBeDefined();
  });

  it("defines ChatResponse schema", () => {
    const schema = swaggerSpec.components.schemas.ChatResponse;
    expect(schema.properties.sessionId).toBeDefined();
    expect(schema.properties.response).toBeDefined();
    expect(schema.properties.isError).toBeDefined();
    expect(schema.properties.durationMs).toBeDefined();
    expect(schema.properties.costUsd).toBeDefined();
  });

  it("defines ToolDef schema", () => {
    const schema = swaggerSpec.components.schemas.ToolDef;
    expect(schema.required).toContain("name");
    expect(schema.required).toContain("description");
  });

  it("defines DELETE /sessions/{id}", () => {
    const endpoint = swaggerSpec.paths["/sessions/{id}"];
    expect(endpoint.delete).toBeDefined();
  });

  it("defines PUT and GET for /sessions/{id}/tools", () => {
    const endpoint = swaggerSpec.paths["/sessions/{id}/tools"];
    expect(endpoint.put).toBeDefined();
    expect(endpoint.get).toBeDefined();
  });
});
