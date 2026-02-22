# AFFiNE Agent Access Runbook (As-Is, No Code Changes)

This runbook documents what an automation agent can do today against AFFiNE self-hosted using existing APIs/tools (GraphQL, MCP, and Sync socket protocol), plus exact call patterns.

---

## 1) Endpoint Inventory

### 1.1 GraphQL

- **Endpoint:** `POST /graphql`
- **Purpose:** auth token management, comments/replies, workspace/doc queries, etc.

### 1.2 Workspace MCP

- **Endpoint:** `POST /api/workspaces/:workspaceId/mcp`
- **Protocol:** streamable-http MCP
- `GET` / `DELETE` on this path are method-not-allowed by design.

### 1.3 Realtime Sync (Socket.IO)

- **Gateway:** Socket.IO event API (`space:join`, `space:load-doc`, `space:push-doc-update`, ...)
- **Purpose:** CRDT update exchange and collaborative editing.

---

## 2) Authentication Runbook

## 2.1 Bearer token behavior

AFFiNE accepts bearer tokens from `Authorization: Bearer <token>`.

## 2.2 Generate a personal access token

Use GraphQL mutation `generateUserAccessToken`:

```bash
curl -sS "$AFFINE_BASE_URL/graphql" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $AFFINE_SESSION_OR_TOKEN" \
  --data-raw '{
    "query":"mutation($input:GenerateAccessTokenInput!){generateUserAccessToken(input:$input){id name token expiresAt}}",
    "variables":{"input":{"name":"mcp","expiresAt":null}}
  }'
```

## 2.3 Revoke token

```bash
curl -sS "$AFFINE_BASE_URL/graphql" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $TOKEN" \
  --data-raw '{
    "query":"mutation($id:String!){revokeUserAccessToken(id:$id)}",
    "variables":{"id":"<token_id>"}
  }'
```

---

## 3) MCP Tooling (Built-in Server)

## 3.1 MCP server URL template

```text
https://<host>/api/workspaces/<workspaceId>/mcp
```

Include header:

```text
Authorization: Bearer <token>
```

## 3.2 Tools exposed

Always registered:

- `read_document`
- `semantic_search`
- `keyword_search`

Conditionally registered (**only if** `env.dev || env.namespaces.canary`):

- `create_document`
- `update_document`
- `update_document_meta`

## 3.3 Write tool limitations

`create_document` / `update_document` are markdown-oriented and explicitly do **not** support database blocks and images.

## 3.4 Tool inputs

- `read_document`: `{ docId: string }`
- `semantic_search`: `{ query: string }`
- `keyword_search`: `{ query: string }`
- `create_document`: `{ title: string, content: string }` (dev/canary only)
- `update_document`: `{ docId: string, content: string }` (dev/canary only)
- `update_document_meta`: `{ docId: string, title: string }` (dev/canary only)

## 3.5 Permissions checked

- `create_document` -> `Workspace.CreateDoc`
- `update_document` / `update_document_meta` -> `Doc.Update`
- `read_document` / search outputs are permission-filtered by `Doc.Read`

---

## 4) GraphQL Capability Runbook

## 4.1 Comments/replies (supported and stable)

Available mutations include:

- `createComment(input: CommentCreateInput!)`
- `updateComment(input: CommentUpdateInput!)`
- `deleteComment(id: String!)`
- `resolveComment(input: CommentResolveInput!)`
- `createReply(input: ReplyCreateInput!)`
- `updateReply(input: ReplyUpdateInput!)`
- `deleteReply(id: String!)`

Important: `content` is a `JSONObject`, not plain text.

Example:

```bash
curl -sS "$AFFINE_BASE_URL/graphql" \
  -H "content-type: application/json" \
  -H "authorization: Bearer $TOKEN" \
  --data-raw '{
    "query":"mutation($input:CommentCreateInput!){createComment(input:$input){id resolved}}",
    "variables":{"input":{
      "workspaceId":"'$WORKSPACE_ID'",
      "docId":"'$DOC_ID'",
      "docMode":"page",
      "docTitle":"My Doc",
      "content":{"type":"paragraph","content":[{"type":"text","text":"Agent note"}]}
    }}
  }'
```

## 4.2 Read back comments/docs

Workspace fields include:

- `comments(docId, pagination)`
- `commentChanges(docId, pagination)`
- `doc(docId)`
- `docs(pagination)`

## 4.3 Doc creation via GraphQL

As-is schema does **not** expose a direct `createDoc` mutation in `Mutation`.

## 4.4 `applyDocUpdates` caveat

`applyDocUpdates` returns merged markdown from an LLM pass; it does not itself persist changes to the doc.

---

## 5) Sync Socket Runbook (for collaborative writes)

## 5.1 Join workspace

Event: `space:join`

Payload:

```json
{
  "spaceType": "workspace",
  "spaceId": "<workspaceId>",
  "clientVersion": "0.26.0"
}
```

## 5.2 Load doc state

Event: `space:load-doc`

Payload:

```json
{
  "spaceType": "workspace",
  "spaceId": "<workspaceId>",
  "docId": "<docId>",
  "stateVector": "<base64_optional>"
}
```

Returns `missing`, `state`, `timestamp`.

## 5.3 Push doc update

Event: `space:push-doc-update`

Payload:

```json
{
  "spaceType": "workspace",
  "spaceId": "<workspaceId>",
  "docId": "<docId>",
  "update": "<base64_yjs_update>"
}
```

Returns `accepted: true` and `timestamp`.

## 5.4 Ordering discipline (critical)

For deterministic results:

1. Send one write
2. Wait for ack (`accepted` + timestamp)
3. Then send next write

Do not fire many append/update calls concurrently.

---

## 6) Collections/Folders Reality (As-Is)

Collections are stored in workspace root YDoc under `setting.collections` and manipulated as Yjs objects/arrays by frontend services.

Implication:

- Collection behavior depends on root doc sync propagation semantics.
- If your automation path mutates a different surface (or races sync readiness), cross-user visibility can appear inconsistent.

---

## 7) Feature Availability Matrix

| Goal                                 | Best path                                         | Availability | Notes                                                    |
| ------------------------------------ | ------------------------------------------------- | ------------ | -------------------------------------------------------- |
| Shared human+agent editing           | Sync socket writes                                | High         | Core collaborative path                                  |
| Create docs programmatically         | MCP `create_document` or sync-based creation flow | Medium       | MCP create is dev/canary only                            |
| Rich block editing                   | Sync block ops > MCP markdown                     | Medium/High  | MCP write tools limit DB/image blocks                    |
| In-doc comments/replies              | GraphQL comment APIs                              | High         | Structured JSON content required                         |
| Programmatic collection organization | RootYDoc collection mutations                     | Medium/Low   | Not a clear first-class GraphQL collection mutation path |

---

## 8) Recommended Operational Sequence (No code changes)

1. Generate/store access token.
2. Use MCP for read/search by default.
3. Use GraphQL for comments/replies and token lifecycle.
4. Use sync writes for reliable collaborative editing and complex block operations.
5. For collections, mutate the root YDoc collection state and verify from a second user session before proceeding.
6. Enforce strict sequential write acks to prevent ordering scramble.

---

## 9) Quick Validation Checklist

After each automation stage, verify:

- Doc readable from second user session.
- Expected blocks visible in UI.
- Comment/reply roundtrip works.
- Collection assignment visible from both accounts.
- Timestamps/updated metadata reflect expected order.
