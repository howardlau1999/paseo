import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  McpServer as ModernMcpServer,
  type CallToolResult as ModernCallToolResult,
} from "@modelcontextprotocol/server";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { addModelVisibleStructuredContent } from "./tools/paseo-tool-serialization.js";
import { createPaseoToolCatalog, type PaseoToolHostDependencies } from "./tools/paseo-tools.js";
import type { PaseoToolResult } from "./tools/types.js";

export type AgentMcpServerOptions = PaseoToolHostDependencies;

type McpToolContext = RequestHandlerExtra<ServerRequest, ServerNotification>;

function toMcpToolResult(result: PaseoToolResult): CallToolResult {
  const modelVisibleResult = addModelVisibleStructuredContent(result);
  return {
    content: modelVisibleResult.content as CallToolResult["content"],
    ...(modelVisibleResult.structuredContent !== undefined
      ? {
          structuredContent:
            modelVisibleResult.structuredContent as CallToolResult["structuredContent"],
        }
      : {}),
    ...(modelVisibleResult.isError !== undefined ? { isError: modelVisibleResult.isError } : {}),
  };
}

export async function createAgentMcpServer(options: AgentMcpServerOptions): Promise<McpServer> {
  const catalog = await createPaseoToolCatalog(options);
  const server = new McpServer({
    name: "agent-mcp",
    version: "2.0.0",
  });

  for (const tool of catalog.tools.values()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: unknown, context?: McpToolContext) =>
        toMcpToolResult(await catalog.executeTool(tool.name, args, { signal: context?.signal })),
    );
  }

  return server;
}

/** Serve the same tool catalog to clients using the 2026-07-28 MCP protocol. */
export async function createModernAgentMcpServer(
  options: AgentMcpServerOptions,
): Promise<ModernMcpServer> {
  const catalog = await createPaseoToolCatalog(options);
  const server = new ModernMcpServer({ name: "agent-mcp", version: "2.0.0" });

  for (const tool of catalog.tools.values()) {
    // The v2 SDK accepts a schema object; Paseo tools can also provide a raw
    // Zod shape, which needs wrapping before registration.
    const inputSchema =
      tool.inputSchema instanceof z.ZodType
        ? tool.inputSchema
        : z.object(tool.inputSchema ?? {}).passthrough();
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema },
      async (args, context) => {
        const result = addModelVisibleStructuredContent(
          await catalog.executeTool(tool.name, args, { signal: context.mcpReq.signal }),
        );
        return {
          content: result.content as ModernCallToolResult["content"],
          ...(result.structuredContent !== undefined
            ? {
                structuredContent:
                  result.structuredContent as ModernCallToolResult["structuredContent"],
              }
            : {}),
          ...(result.isError !== undefined ? { isError: result.isError } : {}),
        };
      },
    );
  }

  return server;
}
