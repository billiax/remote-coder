import { AgentResponse, HistoryMessage, ImageInput, SessionTool, AgentOptions, EngineType } from "../../src/types";

describe("TypeScript interfaces", () => {
  it("AgentResponse can be constructed with required fields", () => {
    const response: AgentResponse = {
      sessionId: "test-123",
      result: "Hello",
      isError: false,
      durationMs: 100,
      costUsd: 0.01,
    };
    expect(response.sessionId).toBe("test-123");
    expect(response.inputTokens).toBeUndefined();
  });

  it("AgentResponse supports optional fields", () => {
    const response: AgentResponse = {
      sessionId: "test-123",
      result: "Hello",
      isError: false,
      durationMs: 100,
      costUsd: 0.01,
      inputTokens: 5000,
      contextWindow: 200000,
    };
    expect(response.inputTokens).toBe(5000);
    expect(response.contextWindow).toBe(200000);
  });

  it("HistoryMessage can represent user message", () => {
    const msg: HistoryMessage = {
      role: "user",
      content: "Hello",
      timestamp: Date.now(),
    };
    expect(msg.role).toBe("user");
    expect(msg.imageUrls).toBeUndefined();
  });

  it("HistoryMessage can include image URLs", () => {
    const msg: HistoryMessage = {
      role: "user",
      content: "See this image",
      timestamp: Date.now(),
      imageUrls: ["/images/ws/img-1.png"],
    };
    expect(msg.imageUrls).toHaveLength(1);
  });

  it("ImageInput requires data and media_type", () => {
    const img: ImageInput = {
      data: "base64data",
      media_type: "image/png",
    };
    expect(img.media_type).toBe("image/png");
  });

  it("SessionTool has required and optional fields", () => {
    const tool: SessionTool = {
      name: "my_tool",
      description: "Does something",
      parameters: {
        input: { type: "string", description: "The input", required: true },
      },
    };
    expect(tool.name).toBe("my_tool");
    expect(tool.parameters?.input.required).toBe(true);
  });

  it("EngineType only allows valid values", () => {
    const engines: EngineType[] = ["claude", "opencode"];
    expect(engines).toContain("claude");
    expect(engines).toContain("opencode");
  });
});
