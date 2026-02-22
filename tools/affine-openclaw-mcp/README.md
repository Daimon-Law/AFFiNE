# affine-openclaw-mcp (PoC)

PoC MCP server providing broad AFFiNE self-hosted workspace access without browser automation.

## Features

- Document tools: `list_docs`, `create_doc`, `read_doc`, `edit_doc`, `delete_doc`
- Collection tools: `list_collections`, `create_collection`, `update_collection`, `delete_collection`
- Comment tools: `list_comments`, `create_comment`, `resolve_comment`, `delete_comment`
- Utility tools: `current_user`, `search`
- Socket.IO + Yjs write path with per-doc sequential mutation queue

## Required environment variables

```bash
AFFINE_BASE_URL=https://affine.agentic-lawyer.xyz
AFFINE_WORKSPACE_ID=015afe98-6bb6-4745-bbcf-63b9afe52318

# Required for websocket auth:
AFFINE_EMAIL=clawgentic@apps.agentic-lawyer.xyz
AFFINE_PASSWORD=***

# Optional for GraphQL bearer mode:
AFFINE_TOKEN=ut_xxx

# Optional (defaults 0.26.2)
AFFINE_CLIENT_VERSION=0.26.2
```

## Run

```bash
cd tools/affine-openclaw-mcp
npm install
npm run check
npm start
```

The server runs over MCP stdio transport.

## Notes / limitations (PoC)

- `read_doc` converts a subset of BlockSuite blocks to markdown (paragraph/headings/lists/todo/code/divider).
- `edit_doc` currently supports append/update/delete for common block types.
- `search` is implemented as best-effort local scan over doc markdown.
- Anchored inline comments are not implemented (doc-level comments only).
