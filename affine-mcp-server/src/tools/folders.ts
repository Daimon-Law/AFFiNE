/**
 * AFFiNE MCP Server - Folder Tools
 *
 * Tools for managing the folder/explorer tree stored in the userspace.
 * These allow organising documents into folders, moving items, and
 * inspecting the folder hierarchy.
 *
 * 7 tools:
 *   - affine_list_folders       (read folder tree)
 *   - affine_create_folder      (create a new folder)
 *   - affine_add_doc_to_folder  (place a doc reference in the tree)
 *   - affine_move_folder_item   (move a node within the tree)
 *   - affine_remove_folder_node (remove a node from the tree)
 *   - affine_rename_folder      (rename a folder node)
 *   - affine_dump_userspace     (debug: dump raw userspace root doc)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListFoldersInputSchema,
  CreateFolderInputSchema,
  AddDocToFolderInputSchema,
  MoveFolderItemInputSchema,
  RemoveFolderNodeInputSchema,
  RenameFolderInputSchema,
  DumpUserspaceRootInputSchema,
} from "../schemas/inputs.js";
import {
  listFolderTree,
  createFolder,
  addDocToFolder,
  moveFolderItem,
  removeFolderNode,
  renameFolder,
  dumpUserspaceRoot,
} from "../services/userspace-helpers.js";
import { CHARACTER_LIMIT } from "../constants.js";
import type { FolderNode, FolderTree } from "../types.js";

/**
 * Render a folder tree as an indented text tree.
 */
function renderFolderTreeMarkdown(tree: FolderTree): string {
  if (tree.rootIds.length === 0) {
    return "No folder tree found. The userspace explorer may be empty or use a different format.\n\nTip: Use `affine_dump_userspace` to inspect the raw userspace root doc structure.";
  }

  const lines: string[] = [`# Folder Tree (${Object.keys(tree.nodes).length} nodes)\n`];

  function renderNode(nodeId: string, indent: number): void {
    const node = tree.nodes[nodeId];
    if (!node) return;

    const prefix = "  ".repeat(indent);
    const icon = node.type === "folder" ? "📁" : node.type === "doc" ? "📄" : `[${node.type}]`;

    lines.push(`${prefix}${icon} ${node.data || "(unnamed)"}  (id: ${node.id})`);

    for (const childId of node.children) {
      renderNode(childId, indent + 1);
    }
  }

  for (const rootId of tree.rootIds) {
    renderNode(rootId, 0);
  }

  return lines.join("\n");
}

export function registerFolderTools(server: McpServer): void {
  // ─── List Folders ──────────────────────────────────────────────────────────

  server.tool(
    "affine_list_folders",
    "List the folder/explorer tree from the userspace. Shows how documents are organised into folders in the sidebar.",
    ListFoldersInputSchema.shape,
    async (params) => {
      try {
        const tree = await listFolderTree();
        const isJson = params.response_format === "json";

        if (isJson) {
          const json = JSON.stringify(tree, null, 2);
          return {
            content: [
              {
                type: "text" as const,
                text: json.length > CHARACTER_LIMIT
                  ? json.slice(0, CHARACTER_LIMIT) + "\n...(truncated)"
                  : json,
              },
            ],
          };
        }

        const md = renderFolderTreeMarkdown(tree);
        return {
          content: [
            {
              type: "text" as const,
              text: md.length > CHARACTER_LIMIT
                ? md.slice(0, CHARACTER_LIMIT) + "\n...(truncated)"
                : md,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing folders: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─── Create Folder ─────────────────────────────────────────────────────────

  server.tool(
    "affine_create_folder",
    "Create a new folder in the explorer tree. Optionally nest it inside another folder.",
    CreateFolderInputSchema.shape,
    async (params) => {
      try {
        const nodeId = await createFolder(params.name, params.parentNodeId);
        const isJson = params.response_format === "json";

        const result = { nodeId, name: params.name, parentNodeId: params.parentNodeId ?? null };

        if (isJson) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `✅ Folder created: **${params.name}**\n- Node ID: \`${nodeId}\`\n- Parent: ${params.parentNodeId ? `\`${params.parentNodeId}\`` : "root"}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error creating folder: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─── Add Doc to Folder ─────────────────────────────────────────────────────

  server.tool(
    "affine_add_doc_to_folder",
    "Add a document reference to the folder tree. The document itself is not moved — only a reference is added to the explorer tree.",
    AddDocToFolderInputSchema.shape,
    async (params) => {
      try {
        const nodeId = await addDocToFolder(params.docId, params.parentNodeId);
        const isJson = params.response_format === "json";

        const result = { nodeId, docId: params.docId, parentNodeId: params.parentNodeId ?? null };

        if (isJson) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `✅ Doc added to folder tree\n- Doc ID: \`${params.docId}\`\n- Node ID: \`${nodeId}\`\n- Parent: ${params.parentNodeId ? `\`${params.parentNodeId}\`` : "root"}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error adding doc to folder: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─── Move Folder Item ──────────────────────────────────────────────────────

  server.tool(
    "affine_move_folder_item",
    "Move a folder tree node (doc or folder) to a different parent or position. Use affine_list_folders to get node IDs first.",
    MoveFolderItemInputSchema.shape,
    async (params) => {
      try {
        await moveFolderItem(params.nodeId, params.newParentNodeId, params.position);
        const isJson = params.response_format === "json";

        const result = {
          moved: params.nodeId,
          newParent: params.newParentNodeId ?? "root",
          position: params.position ?? "end",
        };

        if (isJson) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `✅ Moved node \`${params.nodeId}\` → ${params.newParentNodeId ? `\`${params.newParentNodeId}\`` : "root"}${params.position !== undefined ? ` at position ${params.position}` : ""}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error moving folder item: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─── Remove Folder Node ────────────────────────────────────────────────────

  server.tool(
    "affine_remove_folder_node",
    "Remove a node from the folder tree. For folders, also removes child nodes from the tree. Does NOT delete the underlying documents.",
    RemoveFolderNodeInputSchema.shape,
    async (params) => {
      try {
        await removeFolderNode(params.nodeId);
        const isJson = params.response_format === "json";

        if (isJson) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ removed: params.nodeId }) }],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `✅ Removed node \`${params.nodeId}\` from folder tree`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error removing folder node: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─── Rename Folder ─────────────────────────────────────────────────────────

  server.tool(
    "affine_rename_folder",
    "Rename an existing folder in the explorer tree.",
    RenameFolderInputSchema.shape,
    async (params) => {
      try {
        await renameFolder(params.nodeId, params.name);
        const isJson = params.response_format === "json";

        if (isJson) {
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ nodeId: params.nodeId, newName: params.name }) },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `✅ Renamed folder \`${params.nodeId}\` → **${params.name}**`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error renaming folder: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─── Dump Userspace Root (Debug) ───────────────────────────────────────────

  server.tool(
    "affine_dump_userspace",
    "Debug tool: dump the raw structure of the userspace root doc. Use this to inspect what keys and data exist in the userspace for troubleshooting folder operations.",
    DumpUserspaceRootInputSchema.shape,
    async (params) => {
      try {
        const dump = await dumpUserspaceRoot();
        const json = JSON.stringify(dump, null, 2);

        return {
          content: [
            {
              type: "text" as const,
              text: json.length > CHARACTER_LIMIT
                ? json.slice(0, CHARACTER_LIMIT) + "\n...(truncated)"
                : json,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error dumping userspace root: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
