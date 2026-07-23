# inbio-mcp — official INBIO MCP server

The official [Model Context Protocol](https://modelcontextprotocol.io) server
for [INBIO](https://in.bio), the premium URL shortener with click analytics
and customizable QR codes.

**Remote endpoint (Streamable HTTP):** `https://mcp.in.bio/mcp` — no
installation needed.

```bash
claude mcp add --transport http inbio https://mcp.in.bio/mcp
```

## Tools

No token needed: `shorten_link`, `generate_qr_code` (every design option).

With an INBIO API token (`Authorization: Bearer <token>`, created at
[in.bio/settings](https://in.bio/settings)): `create_link`, `list_links`,
`get_link`, `update_link`, `delete_link`, `set_link_enabled`,
`get_link_analytics`, `list_folders`, `list_tags`, `get_account_usage`.

Resources expose the [OpenAPI spec](https://in.bio/openapi.json) and
[llms.txt](https://in.bio/llms.txt); a `create-campaign-link` prompt builds
UTM-tagged tracked links.

Docs: https://docs.in.bio/mcp-server · Auth guide: https://in.bio/auth.md

## Running your own copy

This is a Cloudflare Worker using the [Agents SDK](https://developers.cloudflare.com/agents/):

```bash
npm install
npx wrangler deploy
```

## License

MIT © [InBio, Inc.](https://in.bio)
