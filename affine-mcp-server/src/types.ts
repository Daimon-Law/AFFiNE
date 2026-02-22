/**
 * AFFiNE MCP Server - Type Definitions
 */

/** Document metadata from workspace root doc */
export interface DocMeta {
  id: string;
  title: string;
  createDate: number;
  updatedDate?: number;
  tags?: string[];
}

/** Collection metadata from workspace root doc */
export interface CollectionMeta {
  id: string;
  name: string;
  docIds: string[];
  docCount: number;
}

/** Block data within a document */
export interface BlockInfo {
  id: string;
  flavour: string;
  type?: string;
  text?: string;
  children: string[];
  checked?: boolean;
  language?: string;
}

/** Edit operation for affine_edit_doc */
export interface EditOperation {
  action: "append" | "update" | "delete";
  blockType?: string;
  content?: string;
  blockId?: string;
  propType?: string;
}

/** Comment data from GraphQL */
export interface CommentData {
  id: string;
  content: unknown;
  createdAt: string;
  userId?: string;
  resolved?: boolean;
}

/** Result of a WebSocket space:join */
export interface JoinResult {
  clientId?: string;
  success: boolean;
}

/** Result of a WebSocket space:load-doc */
export interface LoadDocResult {
  missing: string; // base64-encoded Yjs update (full doc state despite the name)
  state: string;   // base64-encoded state vector
  timestamp: number;
}

/** Result of a WebSocket space:push-doc-update */
export interface PushUpdateResult {
  accepted: boolean;
  timestamp?: number;
}

/** Auth session cookies */
export interface AuthSession {
  cookies: string;
  expiresAt?: number;
}

/** Response format enum */
export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

/** Rich text delta attribute */
export interface TextDelta {
  insert: string;
  attributes?: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strike?: boolean;
    code?: boolean;
    link?: string;
    reference?: unknown;
  };
}

// ─── Folder / Userspace Types ─────────────────────────────────────────────

/**
 * Type of item in the folder tree.
 * AFFiNE's explorer tree supports docs, folders, collections, tags, etc.
 */
export type FolderNodeType =
  | "folder"
  | "doc"
  | "collection"
  | "tag"
  | "trash"
  | "favorites";

/**
 * A node in the userspace folder tree.
 * Corresponds to one entry in the explorer sidebar.
 */
export interface FolderNode {
  /** Unique ID of this folder node */
  id: string;
  /** Type of node */
  type: FolderNodeType;
  /** For type=doc: the document ID. For type=folder: folder name or empty. */
  data: string;
  /** Ordered child node IDs */
  children: string[];
  /** Optional index key from Yjs (for ordering) */
  index?: string;
}

/**
 * Flat map of all folder nodes returned by the list tool.
 */
export interface FolderTree {
  /** The root node IDs (top-level items) */
  rootIds: string[];
  /** All nodes keyed by their ID */
  nodes: Record<string, FolderNode>;
}
