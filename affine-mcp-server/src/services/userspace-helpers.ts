/**
 * AFFiNE Userspace Yjs Helpers
 *
 * Handles reading and writing the per-user folder tree stored in the
 * userspace root doc. In AFFiNE 0.26.x the folder organisation is
 * persisted in a Yjs document whose docId = userId, accessed through
 * the "userspace" spaceType.
 *
 * The folder tree lives inside a top-level YMap called "explorer".
 * Each node is a YMap with keys:
 *   - data  (string): docId for doc nodes, folder name for folder nodes
 *   - type  (string): "folder", "doc", "collection", "tag", etc.
 *   - index (string): fractional-index key for ordering
 *   - children (YArray<YMap>): ordered child nodes (recursive)
 *
 * The explorer root itself is a YMap whose keys are top-level node IDs,
 * each containing a YMap with the structure above.
 */

import * as Y from "yjs";
import { nanoid } from "nanoid";
import { loadUserspaceDoc, pushUserspaceDocUpdate } from "./websocket.js";
import { getCurrentUser } from "./graphql.js";
import type { FolderNode, FolderTree, FolderNodeType } from "../types.js";

// Cache the userId so we don't hit GraphQL on every call
let cachedUserId: string | null = null;

/**
 * Resolve the authenticated user's ID (cached).
 */
export async function resolveUserId(): Promise<string> {
  if (cachedUserId) return cachedUserId;

  const user = await getCurrentUser();
  if (!user?.id) {
    throw new Error("Cannot determine authenticated user ID. Check auth credentials.");
  }

  cachedUserId = user.id;
  return cachedUserId;
}

/**
 * Load the userspace root Yjs document.
 * The doc ID for the userspace root = userId.
 */
async function loadUserspaceRootDoc(): Promise<{ ydoc: Y.Doc; userId: string }> {
  const userId = await resolveUserId();

  const result = await loadUserspaceDoc(userId, userId);
  const ydoc = new Y.Doc();

  if (result.missing) {
    const update = new Uint8Array(Buffer.from(result.missing, "base64"));
    Y.applyUpdate(ydoc, update);
  }

  return { ydoc, userId };
}

/**
 * Push the userspace root doc back to the server.
 */
async function pushUserspaceRootDoc(userId: string, ydoc: Y.Doc): Promise<void> {
  const update = Y.encodeStateAsUpdate(ydoc);
  const base64 = Buffer.from(update).toString("base64");
  await pushUserspaceDocUpdate(userId, userId, base64);
}

// ─── Recursive Tree Traversal ─────────────────────────────────────────────

/**
 * Recursively extract FolderNode data from a YMap node.
 */
function extractNode(
  nodeId: string,
  ymap: Y.Map<unknown>,
  nodes: Record<string, FolderNode>
): void {
  const data = (ymap.get("data") as string) ?? "";
  const type = (ymap.get("type") as FolderNodeType) ?? "doc";
  const index = ymap.get("index") as string | undefined;
  const childrenArr = ymap.get("children") as Y.Array<Y.Map<unknown>> | undefined;

  const childIds: string[] = [];

  if (childrenArr) {
    for (let i = 0; i < childrenArr.length; i++) {
      const child = childrenArr.get(i);
      if (child instanceof Y.Map) {
        // Child nodes use their own id, or we generate a stable one
        const childId = (child.get("id") as string) || `${nodeId}:${i}`;
        childIds.push(childId);
        extractNode(childId, child, nodes);
      }
    }
  }

  nodes[nodeId] = {
    id: nodeId,
    type,
    data,
    children: childIds,
    index,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Read the full folder tree from the userspace root doc.
 */
export async function listFolderTree(): Promise<FolderTree> {
  const { ydoc } = await loadUserspaceRootDoc();

  const nodes: Record<string, FolderNode> = {};
  const rootIds: string[] = [];

  // The explorer data is a YMap at the top level of the doc.
  // In AFFiNE 0.26.x it may be stored under "explorer" key or
  // may be the root doc's top-level maps. We try "explorer" first,
  // then fall back to scanning all top-level maps for folder-like data.
  const explorer = ydoc.getMap("explorer");

  if (explorer.size > 0) {
    for (const [key, value] of explorer.entries()) {
      if (value instanceof Y.Map) {
        rootIds.push(key);
        extractNode(key, value, nodes);
      }
    }
  } else {
    // Fallback: scan all top-level YMaps for folder-tree structure
    // The userspace doc may use different keys in different AFFiNE versions
    const topKeys = Array.from(ydoc.share.keys());
    for (const key of topKeys) {
      const shared = ydoc.getMap(key);
      if (shared instanceof Y.Map) {
        // Check if this looks like a folder tree entry (has "type" or "data" keys)
        if (shared.has("type") || shared.has("data") || shared.has("children")) {
          rootIds.push(key);
          extractNode(key, shared, nodes);
        }
      }
    }
  }

  return { rootIds, nodes };
}

/**
 * Dump the raw structure of the userspace root doc for debugging.
 * Returns a JSON-serialisable object describing all top-level keys,
 * their types, and a summary of their contents.
 */
export async function dumpUserspaceRoot(): Promise<Record<string, unknown>> {
  const { ydoc, userId } = await loadUserspaceRootDoc();
  const dump: Record<string, unknown> = { userId };

  const topKeys = Array.from(ydoc.share.keys());
  dump._topLevelKeys = topKeys;

  for (const key of topKeys) {
    try {
      const shared = ydoc.share.get(key);
      if (shared instanceof Y.Map) {
        dump[key] = dumpYMap(shared, 0);
      } else if (shared instanceof Y.Array) {
        dump[key] = dumpYArray(shared, 0);
      } else if (shared instanceof Y.Text) {
        dump[key] = { _type: "YText", value: shared.toString().slice(0, 500) };
      } else {
        dump[key] = { _type: shared?.constructor?.name ?? "unknown" };
      }
    } catch {
      dump[key] = { _error: "Could not read" };
    }
  }

  return dump;
}

/** Recursively dump a YMap (max depth 4 to avoid huge output) */
function dumpYMap(ymap: Y.Map<unknown>, depth: number): unknown {
  if (depth > 4) return { _truncated: true, size: ymap.size };

  const obj: Record<string, unknown> = { _type: "YMap", _size: ymap.size };
  for (const [k, v] of ymap.entries()) {
    if (v instanceof Y.Map) {
      obj[k] = dumpYMap(v, depth + 1);
    } else if (v instanceof Y.Array) {
      obj[k] = dumpYArray(v, depth + 1);
    } else if (v instanceof Y.Text) {
      obj[k] = { _type: "YText", value: v.toString().slice(0, 200) };
    } else {
      obj[k] = v;
    }
  }
  return obj;
}

/** Recursively dump a YArray (max depth 4, max 20 items) */
function dumpYArray(yarr: Y.Array<unknown>, depth: number): unknown {
  if (depth > 4) return { _truncated: true, length: yarr.length };

  const items: unknown[] = [];
  const limit = Math.min(yarr.length, 20);
  for (let i = 0; i < limit; i++) {
    const v = yarr.get(i);
    if (v instanceof Y.Map) {
      items.push(dumpYMap(v, depth + 1));
    } else if (v instanceof Y.Array) {
      items.push(dumpYArray(v, depth + 1));
    } else if (v instanceof Y.Text) {
      items.push({ _type: "YText", value: v.toString().slice(0, 200) });
    } else {
      items.push(v);
    }
  }

  if (yarr.length > limit) {
    items.push({ _truncated: true, remaining: yarr.length - limit });
  }

  return { _type: "YArray", _length: yarr.length, items };
}

// ─── Folder Mutations ─────────────────────────────────────────────────────

/**
 * Create a new folder node in the explorer tree.
 *
 * @param name         - Display name for the folder
 * @param parentNodeId - Parent folder node ID, or undefined for root
 * @returns The new folder's node ID
 */
export async function createFolder(
  name: string,
  parentNodeId?: string
): Promise<string> {
  const { ydoc, userId } = await loadUserspaceRootDoc();
  const explorer = ydoc.getMap("explorer");
  const nodeId = nanoid(21);

  const folderMap = new Y.Map<unknown>();
  folderMap.set("data", name);
  folderMap.set("type", "folder");
  folderMap.set("id", nodeId);
  folderMap.set("children", new Y.Array<Y.Map<unknown>>());

  if (parentNodeId) {
    // Find parent and append to its children
    const parent = findNodeInExplorer(explorer, parentNodeId);
    if (!parent) {
      throw new Error(`Parent folder node "${parentNodeId}" not found`);
    }
    let children = parent.get("children") as Y.Array<Y.Map<unknown>> | undefined;
    if (!children) {
      children = new Y.Array<Y.Map<unknown>>();
      parent.set("children", children);
    }
    children.push([folderMap]);
  } else {
    // Add at root level
    explorer.set(nodeId, folderMap);
  }

  await pushUserspaceRootDoc(userId, ydoc);
  return nodeId;
}

/**
 * Add a doc reference to the folder tree.
 *
 * @param docId        - The document ID to reference
 * @param parentNodeId - Parent folder node ID, or undefined for root
 * @returns The new node ID
 */
export async function addDocToFolder(
  docId: string,
  parentNodeId?: string
): Promise<string> {
  const { ydoc, userId } = await loadUserspaceRootDoc();
  const explorer = ydoc.getMap("explorer");
  const nodeId = nanoid(21);

  const docMap = new Y.Map<unknown>();
  docMap.set("data", docId);
  docMap.set("type", "doc");
  docMap.set("id", nodeId);
  docMap.set("children", new Y.Array<Y.Map<unknown>>());

  if (parentNodeId) {
    const parent = findNodeInExplorer(explorer, parentNodeId);
    if (!parent) {
      throw new Error(`Parent folder node "${parentNodeId}" not found`);
    }
    let children = parent.get("children") as Y.Array<Y.Map<unknown>> | undefined;
    if (!children) {
      children = new Y.Array<Y.Map<unknown>>();
      parent.set("children", children);
    }
    children.push([docMap]);
  } else {
    explorer.set(nodeId, docMap);
  }

  await pushUserspaceRootDoc(userId, ydoc);
  return nodeId;
}

/**
 * Remove a node from the folder tree.
 * For folders this removes the entire subtree from the tree structure.
 * This does NOT delete underlying documents — only the folder tree entry.
 */
export async function removeFolderNode(nodeId: string): Promise<void> {
  const { ydoc, userId } = await loadUserspaceRootDoc();
  const explorer = ydoc.getMap("explorer");

  // Check if it's a root-level node
  if (explorer.has(nodeId)) {
    explorer.delete(nodeId);
    await pushUserspaceRootDoc(userId, ydoc);
    return;
  }

  // Search recursively through all root nodes
  const removed = removeNodeRecursive(explorer, nodeId);
  if (!removed) {
    throw new Error(`Folder node "${nodeId}" not found in the tree`);
  }

  await pushUserspaceRootDoc(userId, ydoc);
}

/**
 * Move a folder tree node to a different parent/position.
 */
export async function moveFolderItem(
  nodeId: string,
  newParentNodeId?: string,
  position?: number
): Promise<void> {
  const { ydoc, userId } = await loadUserspaceRootDoc();
  const explorer = ydoc.getMap("explorer");

  // 1. Find and detach the node
  let detached: Y.Map<unknown> | null = null;

  // Check root level first
  if (explorer.has(nodeId)) {
    detached = explorer.get(nodeId) as Y.Map<unknown>;
    // We need to clone it since deleting from YMap removes it
    const cloned = cloneYMap(ydoc, detached);
    explorer.delete(nodeId);
    detached = cloned;
  } else {
    detached = detachNodeRecursive(explorer, nodeId, ydoc);
  }

  if (!detached) {
    throw new Error(`Folder node "${nodeId}" not found in the tree`);
  }

  // 2. Insert at new location
  if (newParentNodeId) {
    const parent = findNodeInExplorer(explorer, newParentNodeId);
    if (!parent) {
      throw new Error(`Destination parent "${newParentNodeId}" not found`);
    }
    let children = parent.get("children") as Y.Array<Y.Map<unknown>> | undefined;
    if (!children) {
      children = new Y.Array<Y.Map<unknown>>();
      parent.set("children", children);
    }
    if (position !== undefined && position < children.length) {
      children.insert(position, [detached]);
    } else {
      children.push([detached]);
    }
  } else {
    // Move to root level
    explorer.set(nodeId, detached);
  }

  await pushUserspaceRootDoc(userId, ydoc);
}

/**
 * Rename a folder node.
 */
export async function renameFolder(nodeId: string, newName: string): Promise<void> {
  const { ydoc, userId } = await loadUserspaceRootDoc();
  const explorer = ydoc.getMap("explorer");

  const node = findNodeInExplorer(explorer, nodeId);
  if (!node) {
    throw new Error(`Folder node "${nodeId}" not found`);
  }

  const type = node.get("type") as string;
  if (type !== "folder") {
    throw new Error(`Node "${nodeId}" is a ${type}, not a folder. Only folders can be renamed.`);
  }

  node.set("data", newName);
  await pushUserspaceRootDoc(userId, ydoc);
}

// ─── Internal Helpers ─────────────────────────────────────────────────────

/**
 * Find a node by ID anywhere in the explorer tree.
 * Returns the YMap for that node, or null if not found.
 */
function findNodeInExplorer(
  explorer: Y.Map<unknown>,
  nodeId: string
): Y.Map<unknown> | null {
  // Check root level
  if (explorer.has(nodeId)) {
    const val = explorer.get(nodeId);
    if (val instanceof Y.Map) return val;
  }

  // Search recursively
  for (const [, value] of explorer.entries()) {
    if (value instanceof Y.Map) {
      const found = findNodeRecursive(value, nodeId);
      if (found) return found;
    }
  }

  return null;
}

function findNodeRecursive(
  ymap: Y.Map<unknown>,
  nodeId: string
): Y.Map<unknown> | null {
  const id = ymap.get("id") as string | undefined;
  if (id === nodeId) return ymap;

  const children = ymap.get("children") as Y.Array<Y.Map<unknown>> | undefined;
  if (children) {
    for (let i = 0; i < children.length; i++) {
      const child = children.get(i);
      if (child instanceof Y.Map) {
        const found = findNodeRecursive(child, nodeId);
        if (found) return found;
      }
    }
  }

  return null;
}

/**
 * Remove a node from anywhere in the tree. Returns true if found and removed.
 */
function removeNodeRecursive(
  explorer: Y.Map<unknown>,
  nodeId: string
): boolean {
  for (const [, value] of explorer.entries()) {
    if (value instanceof Y.Map) {
      if (removeFromChildren(value, nodeId)) return true;
    }
  }
  return false;
}

function removeFromChildren(
  parent: Y.Map<unknown>,
  nodeId: string
): boolean {
  const children = parent.get("children") as Y.Array<Y.Map<unknown>> | undefined;
  if (!children) return false;

  for (let i = 0; i < children.length; i++) {
    const child = children.get(i);
    if (child instanceof Y.Map) {
      const id = child.get("id") as string | undefined;
      if (id === nodeId) {
        children.delete(i, 1);
        return true;
      }
      // Recurse into child
      if (removeFromChildren(child, nodeId)) return true;
    }
  }

  return false;
}

/**
 * Detach a node from the tree and return a clone of it.
 */
function detachNodeRecursive(
  explorer: Y.Map<unknown>,
  nodeId: string,
  ydoc: Y.Doc
): Y.Map<unknown> | null {
  for (const [, value] of explorer.entries()) {
    if (value instanceof Y.Map) {
      const result = detachFromChildren(value, nodeId, ydoc);
      if (result) return result;
    }
  }
  return null;
}

function detachFromChildren(
  parent: Y.Map<unknown>,
  nodeId: string,
  ydoc: Y.Doc
): Y.Map<unknown> | null {
  const children = parent.get("children") as Y.Array<Y.Map<unknown>> | undefined;
  if (!children) return null;

  for (let i = 0; i < children.length; i++) {
    const child = children.get(i);
    if (child instanceof Y.Map) {
      const id = child.get("id") as string | undefined;
      if (id === nodeId) {
        const cloned = cloneYMap(ydoc, child);
        children.delete(i, 1);
        return cloned;
      }
      const result = detachFromChildren(child, nodeId, ydoc);
      if (result) return result;
    }
  }

  return null;
}

/**
 * Deep-clone a YMap into a new, independent YMap.
 * Needed because deleting a YMap from a YArray removes it from the doc.
 */
function cloneYMap(ydoc: Y.Doc, source: Y.Map<unknown>): Y.Map<unknown> {
  const clone = new Y.Map<unknown>();

  for (const [key, value] of source.entries()) {
    if (value instanceof Y.Map) {
      clone.set(key, cloneYMap(ydoc, value));
    } else if (value instanceof Y.Array) {
      clone.set(key, cloneYArray(ydoc, value));
    } else if (value instanceof Y.Text) {
      const t = new Y.Text();
      t.insert(0, value.toString());
      clone.set(key, t);
    } else {
      clone.set(key, value);
    }
  }

  return clone;
}

function cloneYArray(ydoc: Y.Doc, source: Y.Array<unknown>): Y.Array<unknown> {
  const clone = new Y.Array<unknown>();

  for (let i = 0; i < source.length; i++) {
    const value = source.get(i);
    if (value instanceof Y.Map) {
      clone.push([cloneYMap(ydoc, value)]);
    } else if (value instanceof Y.Array) {
      clone.push([cloneYArray(ydoc, value)]);
    } else {
      clone.push([value]);
    }
  }

  return clone;
}
