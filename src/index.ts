import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

/**
 * The official INBIO MCP server (mcp.in.bio).
 *
 * Two tiers of tools:
 *  - Keyless (shorten_link, generate_qr_code): work with no auth at all,
 *    backed by in.bio's free public endpoints.
 *  - Account tools (create_link, list_links, analytics, ...): require an
 *    INBIO API token supplied by the MCP client as an
 *    `Authorization: Bearer <token>` header. Tokens are created by a human
 *    at https://in.bio/settings (API access is a Pro/Business feature).
 */

const API = "https://in.bio";

type Props = { token: string };

interface Env {
  InbioMCP: DurableObjectNamespace;
}

const STYLE_PARAMS = {
  dot_style: z.enum(["square", "dots", "rounded"]).optional().describe("Data-dot style"),
  marker_shape: z.enum(["square", "rounded", "circle"]).optional().describe("Corner-marker shape"),
  marker_center: z.enum(["square", "dot"]).optional().describe("Corner-marker center"),
  foreground: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional().describe("Foreground hex color"),
  marker_color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional().describe("Marker hex color (defaults to foreground)"),
  size: z.number().int().min(64).max(2048).optional().describe("Image size in px (default 512)"),
  transparent: z.boolean().optional().describe("Transparent background"),
  format: z.enum(["png", "svg"]).optional().describe("Image format (default png)"),
};

function text(value: unknown) {
  return {
    content: [
      { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export class InbioMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "inbio", version: "1.0.0" });

  private async api(path: string, init: RequestInit = {}, auth = false): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "inbio-mcp/1.0.0",
      ...(init.headers as Record<string, string> | undefined),
    };
    if (auth) {
      if (!this.props?.token) {
        throw new Error(
          "This tool needs an INBIO API token. Configure the MCP client with an `Authorization: Bearer <token>` header — create a token at https://in.bio/settings (API access requires a Pro or Business plan). The shorten_link and generate_qr_code tools work without any token.",
        );
      }
      headers.Authorization = `Bearer ${this.props.token}`;
    }
    return fetch(`${API}${path}`, { ...init, headers });
  }

  private async apiJson(path: string, init: RequestInit = {}, auth = false) {
    const response = await this.api(path, init, auth);
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const message =
        (body.message as string) ?? (body.error as string) ?? `INBIO API returned HTTP ${response.status}`;
      throw new Error(`${message}${body.errors ? ` — ${JSON.stringify(body.errors)}` : ""}`);
    }
    return body;
  }

  async init() {
    // ── Resources & prompts ──────────────────────────────────────
    // Registered so capability scanners (and curious agents) get real
    // answers from resources/list and prompts/list instead of -32601.

    this.server.resource(
      "openapi",
      "https://in.bio/openapi.json",
      { description: "OpenAPI 3.1 specification for the INBIO REST API", mimeType: "application/json" },
      async (uri) => {
        const response = await fetch(uri.href, { headers: { "User-Agent": "inbio-mcp/1.0.0" } });
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: await response.text() }] };
      },
    );

    this.server.resource(
      "llms-txt",
      "https://in.bio/llms.txt",
      { description: "Machine-readable index of INBIO's free APIs, SDKs, and docs", mimeType: "text/plain" },
      async (uri) => {
        const response = await fetch(uri.href, { headers: { "User-Agent": "inbio-mcp/1.0.0" } });
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: await response.text() }] };
      },
    );

    this.server.registerPrompt(
      "create-campaign-link",
      {
        description: "Create a UTM-tagged, tracked short link for a marketing campaign",
        argsSchema: {
          url: z.string().describe("Destination URL"),
          campaign: z.string().describe("Campaign name, e.g. july-launch"),
          source: z.string().optional().describe("Traffic source, e.g. newsletter"),
          medium: z.string().optional().describe("Channel type, e.g. email"),
        },
      },
      ({ url, campaign, source, medium }) => ({
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Create a tracked campaign short link for ${url}. Use the create_link tool with utm set to {campaign: "${campaign}"${source ? `, source: "${source}"` : ""}${medium ? `, medium: "${medium}"` : ""}} (falling back to shorten_link if no API token is configured), then report the short URL and its QR code URL.`,
            },
          },
        ],
      }),
    );

    // ── Keyless tools ────────────────────────────────────────────

    this.server.registerTool(
      "shorten_link",
      {
        description:
          "Shorten a URL into an in.bio short link. Free, no account or token needed. Anonymous links are deleted after 30 days unless claimed via the returned claim_url; claimed/account links also get click analytics.",
        inputSchema: { url: z.string().url().describe("The long URL to shorten") },
      },
      async ({ url }) => {
        try {
          const body = await this.apiJson("/api/shorten", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
          });
          return text(body);
        } catch (error) {
          return errorResult((error as Error).message);
        }
      },
    );

    this.server.registerTool(
      "generate_qr_code",
      {
        description:
          "Generate a styled QR code image URL. Free, no token needed. Encodes a URL, text, Wi-Fi credentials, vCard, email, phone, SMS, or WhatsApp payload. Returns a stable image URL (PNG or SVG) that can be embedded or downloaded directly.",
        inputSchema: {
          type: z.enum(["url", "text", "email", "phone", "sms", "whatsapp", "wifi", "vcard"]).optional()
            .describe("Payload type (default url)"),
          fields: z.record(z.string(), z.string())
            .describe("Payload fields for the type: url→{url}; text→{text}; email→{to,subject?,body?}; phone→{phone}; sms→{phone,body?}; whatsapp→{phone,text?}; wifi→{ssid,password?,encryption?}; vcard→{name,org?,title?,phone?,email?,url?}"),
          ...STYLE_PARAMS,
        },
      },
      async ({ type, fields, ...style }) => {
        const params = new URLSearchParams();
        if (type && type !== "url") params.set("type", type);
        for (const [key, value] of Object.entries(fields)) params.set(key, value);
        for (const [key, value] of Object.entries(style)) {
          if (value !== undefined) params.set(key, String(value).replace(/^#/, ""));
        }
        const url = `${API}/api/qr?${params.toString()}`;
        // Validate the parameters server-side so agents get real feedback.
        const probe = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
        if (!probe.ok) {
          const body = (await probe.json().catch(() => ({}))) as { message?: string; errors?: unknown };
          return errorResult(body.message ?? `QR API returned HTTP ${probe.status}`);
        }
        return text({ qr_url: url, format: params.get("format") ?? "png", note: "This URL renders the QR image directly and is cache-friendly. Add download=1 to force download." });
      },
    );

    // ── Account tools (Bearer token required) ────────────────────

    this.server.registerTool(
      "create_link",
      {
        description:
          "Create a short link on the authenticated INBIO account, with full options (custom slug, title, tags, folder, UTM parameters, expiration, password, click limit). Requires the links:write token scope.",
        inputSchema: {
          destination_url: z.string().url(),
          slug: z.string().min(4).max(64).regex(/^[a-zA-Z0-9-_]+$/).optional().describe("Custom slug (random if omitted)"),
          title: z.string().max(255).optional(),
          description: z.string().max(1000).optional(),
          redirect_type: z.union([z.literal(301), z.literal(302), z.literal(307)]).optional(),
          folder_id: z.number().int().optional(),
          tags: z.array(z.string()).optional(),
          expires_at: z.string().optional().describe("ISO 8601 datetime (Pro+)"),
          fallback_url: z.string().url().optional().describe("Shown after expiry (Pro+)"),
          click_limit: z.number().int().positive().optional().describe("Pro+"),
          password: z.string().optional().describe("Password-protect the link (Pro+)"),
          utm: z.object({
            source: z.string().optional(),
            medium: z.string().optional(),
            campaign: z.string().optional(),
            term: z.string().optional(),
            content: z.string().optional(),
          }).optional(),
        },
      },
      async (args) => {
        try {
          return text(await this.apiJson("/api/v1/links", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(args),
          }, true));
        } catch (error) {
          return errorResult((error as Error).message);
        }
      },
    );

    this.server.registerTool(
      "list_links",
      {
        description: "List the account's short links with optional filters. Requires links:read scope.",
        inputSchema: {
          search: z.string().optional().describe("Matches slug, title, destination URL"),
          status: z.enum(["active", "disabled", "archived", "expired", "exhausted", "blocked", "pending_review"]).optional(),
          tag: z.string().optional(),
          folder_id: z.number().int().optional(),
          page: z.number().int().min(1).optional(),
          per_page: z.number().int().min(1).max(100).optional(),
        },
      },
      async (args) => {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(args)) {
          if (value !== undefined) params.set(key, String(value));
        }
        try {
          return text(await this.apiJson(`/api/v1/links?${params.toString()}`, {}, true));
        } catch (error) {
          return errorResult((error as Error).message);
        }
      },
    );

    this.server.registerTool(
      "get_link",
      {
        description: "Fetch one short link by id. Requires links:read scope.",
        inputSchema: { id: z.number().int() },
      },
      async ({ id }) => {
        try {
          return text(await this.apiJson(`/api/v1/links/${id}`, {}, true));
        } catch (error) {
          return errorResult((error as Error).message);
        }
      },
    );

    this.server.registerTool(
      "update_link",
      {
        description: "Update a short link (any subset of create_link fields, plus slug). Editing destination_url requires the Pro+ edit-destination feature. Requires links:write scope.",
        inputSchema: {
          id: z.number().int(),
          fields: z.record(z.string(), z.unknown()).describe("Fields to update, same names as create_link"),
        },
      },
      async ({ id, fields }) => {
        try {
          return text(await this.apiJson(`/api/v1/links/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(fields),
          }, true));
        } catch (error) {
          return errorResult((error as Error).message);
        }
      },
    );

    this.server.registerTool(
      "delete_link",
      {
        description: "Delete a short link (it stops redirecting). Requires links:write scope.",
        inputSchema: { id: z.number().int() },
      },
      async ({ id }) => {
        try {
          const response = await this.api(`/api/v1/links/${id}`, { method: "DELETE" }, true);
          if (response.status === 204) return text({ deleted: true, id });
          const body = (await response.json().catch(() => ({}))) as { message?: string };
          return errorResult(body.message ?? `HTTP ${response.status}`);
        } catch (error) {
          return errorResult((error as Error).message);
        }
      },
    );

    this.server.registerTool(
      "set_link_enabled",
      {
        description: "Enable or disable a short link. Requires links:write scope.",
        inputSchema: { id: z.number().int(), enabled: z.boolean() },
      },
      async ({ id, enabled }) => {
        try {
          return text(await this.apiJson(`/api/v1/links/${id}/${enabled ? "enable" : "disable"}`, { method: "POST" }, true));
        } catch (error) {
          return errorResult((error as Error).message);
        }
      },
    );

    this.server.registerTool(
      "get_link_analytics",
      {
        description: "Click analytics for a link: totals, daily series, top countries, devices, browsers, referrers. Bot traffic is excluded. Requires analytics:read scope.",
        inputSchema: {
          id: z.number().int(),
          from: z.string().optional().describe("YYYY-MM-DD (default: 30 days before to)"),
          to: z.string().optional().describe("YYYY-MM-DD (default: today)"),
        },
      },
      async ({ id, from, to }) => {
        const params = new URLSearchParams();
        if (from) params.set("from", from);
        if (to) params.set("to", to);
        try {
          return text(await this.apiJson(`/api/v1/links/${id}/analytics?${params.toString()}`, {}, true));
        } catch (error) {
          return errorResult((error as Error).message);
        }
      },
    );

    this.server.registerTool(
      "list_folders",
      { description: "List the account's link folders. Requires links:read scope.", inputSchema: {} },
      async () => {
        try {
          return text(await this.apiJson("/api/v1/folders", {}, true));
        } catch (error) {
          return errorResult((error as Error).message);
        }
      },
    );

    this.server.registerTool(
      "list_tags",
      { description: "List the account's link tags. Requires links:read scope.", inputSchema: {} },
      async () => {
        try {
          return text(await this.apiJson("/api/v1/tags", {}, true));
        } catch (error) {
          return errorResult((error as Error).message);
        }
      },
    );

    this.server.registerTool(
      "get_account_usage",
      {
        description: "Current plan, period usage (links created, clicks, API requests), and plan limits for the authenticated account.",
        inputSchema: {},
      },
      async () => {
        try {
          return text(await this.apiJson("/api/v1/account/usage", {}, true));
        } catch (error) {
          return errorResult((error as Error).message);
        }
      },
    );
  }
}

const SERVER_CARD = {
  serverInfo: { name: "inbio", version: "1.0.0" },
  description:
    "Official INBIO (in.bio) MCP server: shorten URLs and generate styled QR codes with no auth, and manage links, folders, tags, and click analytics with an INBIO API token.",
  transport: { type: "streamable-http", endpoint: "https://mcp.in.bio/mcp" },
  capabilities: { tools: {}, resources: {}, prompts: {} },
  authentication: {
    type: "bearer",
    required: false,
    instructions:
      "Keyless tools (shorten_link, generate_qr_code) need no auth. Account tools need `Authorization: Bearer <token>` — create a token at https://in.bio/settings. See https://in.bio/auth.md",
  },
  documentation: "https://docs.in.bio/api/mcp",
};

const HOME = `INBIO MCP server

Endpoint (Streamable HTTP): https://mcp.in.bio/mcp

Keyless tools: shorten_link, generate_qr_code — no account needed.
Account tools: create_link, list_links, get_link, update_link, delete_link,
set_link_enabled, get_link_analytics, list_folders, list_tags,
get_account_usage — send "Authorization: Bearer <token>"
(create a token at https://in.bio/settings).

Client config example (Claude Code):
  claude mcp add --transport http inbio https://mcp.in.bio/mcp

Docs: https://docs.in.bio/api/mcp
`;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      const authorization = request.headers.get("Authorization") ?? "";
      const token = authorization.replace(/^Bearer\s+/i, "").trim();
      (ctx as ExecutionContext & { props: Props }).props = { token };
      return InbioMCP.serve("/mcp", { binding: "InbioMCP" }).fetch(request, env, ctx);
    }

    if (url.pathname === "/.well-known/mcp/server-card.json") {
      return new Response(JSON.stringify(SERVER_CARD, null, 2), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
      });
    }

    if (url.pathname === "/") {
      return new Response(HOME, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    return new Response("Not found", { status: 404 });
  },
};
