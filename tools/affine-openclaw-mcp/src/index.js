import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { customAlphabet } from 'nanoid';
import { io } from 'socket.io-client';
import * as Y from 'yjs';
import { z } from 'zod';

const nanoid = customAlphabet(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-',
  21
);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

class AffineClient {
  constructor() {
    this.baseUrl = requiredEnv('AFFINE_BASE_URL').replace(/\/$/, '');
    this.workspaceId = requiredEnv('AFFINE_WORKSPACE_ID');
    this.email = process.env.AFFINE_EMAIL;
    this.password = process.env.AFFINE_PASSWORD;
    this.bearerToken = process.env.AFFINE_TOKEN ?? null;
    this.clientVersion = process.env.AFFINE_CLIENT_VERSION ?? '0.26.2';

    this.cookieHeader = null;
    this.socket = null;
    this.joined = false;
    this.writeQueues = new Map();
  }

  async init() {
    if (!this.bearerToken && this.email && this.password) {
      await this.signIn();
    }

    await this.ensureSocket();
  }

  async signIn() {
    const res = await fetch(`${this.baseUrl}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: this.email, password: this.password }),
    });

    if (!res.ok) {
      throw new Error(`Sign-in failed: ${res.status} ${res.statusText}`);
    }

    const setCookie =
      res.headers.getSetCookie?.() ??
      [res.headers.get('set-cookie')].filter(Boolean);
    if (!setCookie.length) {
      throw new Error('Sign-in succeeded but no session cookies were returned');
    }

    this.cookieHeader = setCookie.map(v => v.split(';')[0]).join('; ');
  }

  async graphql(query, variables = {}) {
    const headers = { 'content-type': 'application/json' };
    if (this.bearerToken) headers.authorization = `Bearer ${this.bearerToken}`;
    if (this.cookieHeader) headers.cookie = this.cookieHeader;

    const res = await fetch(`${this.baseUrl}/graphql`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      throw new Error(`GraphQL failed: ${res.status} ${res.statusText}`);
    }

    const json = await res.json();
    if (json.errors?.length) {
      throw new Error(json.errors.map(e => e.message).join('; '));
    }

    return json.data;
  }

  async ensureSocket() {
    if (this.socket?.connected && this.joined) return;

    if (!this.cookieHeader) {
      if (this.email && this.password) await this.signIn();
      else
        throw new Error(
          'Socket auth requires AFFINE_EMAIL + AFFINE_PASSWORD session login'
        );
    }

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
      this.joined = false;
    }

    this.socket = io(this.baseUrl, {
      path: '/socket.io/',
      transports: ['websocket'],
      extraHeaders: {
        Cookie: this.cookieHeader,
      },
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Socket connect timeout')),
        15000
      );
      this.socket.once('connect', () => {
        clearTimeout(timeout);
        resolve();
      });
      this.socket.once('connect_error', err => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    const joined = await this.emitAck('space:join', {
      spaceType: 'workspace',
      spaceId: this.workspaceId,
      clientVersion: this.clientVersion,
    });

    if (!joined?.data?.success) {
      throw new Error(`space:join failed: ${JSON.stringify(joined)}`);
    }

    this.joined = true;
  }

  async emitAck(event, payload) {
    await this.ensureSocket();
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Socket ack timeout for ${event}`)),
        20000
      );

      this.socket.emit(event, payload, response => {
        clearTimeout(timeout);
        resolve(response);
      });
    });
  }

  async loadYDoc(docId) {
    const response = await this.emitAck('space:load-doc', {
      spaceType: 'workspace',
      spaceId: this.workspaceId,
      docId,
    });

    if (!response?.data) {
      throw new Error(
        `Failed to load doc ${docId}: ${JSON.stringify(response)}`
      );
    }

    const ydoc = new Y.Doc({ guid: docId });
    if (response.data.missing) {
      const update = Buffer.from(response.data.missing, 'base64');
      Y.applyUpdate(ydoc, update);
    }

    return { ydoc, timestamp: response.data.timestamp ?? 0 };
  }

  async pushYUpdate(docId, update) {
    const response = await this.emitAck('space:push-doc-update', {
      spaceType: 'workspace',
      spaceId: this.workspaceId,
      docId,
      update: Buffer.from(update).toString('base64'),
    });

    if (!response?.data?.accepted) {
      throw new Error(
        `Push rejected for ${docId}: ${JSON.stringify(response)}`
      );
    }

    return response.data.timestamp;
  }

  async mutateDocSequential(docId, mutator) {
    const existing = this.writeQueues.get(docId) ?? Promise.resolve();
    const next = existing.then(async () => {
      const { ydoc } = await this.loadYDoc(docId);
      let producedUpdate = null;

      ydoc.on('update', update => {
        producedUpdate = update;
      });

      mutator(ydoc);

      if (!producedUpdate) {
        return { changed: false, timestamp: null };
      }

      const timestamp = await this.pushYUpdate(docId, producedUpdate);
      return { changed: true, timestamp };
    });

    this.writeQueues.set(
      docId,
      next.catch(() => {})
    );
    return next;
  }

  getRootPages(rootDoc) {
    const meta = rootDoc.getMap('meta');
    let pages = meta.get('pages');
    if (!(pages instanceof Y.Array)) {
      pages = new Y.Array();
      meta.set('pages', pages);
    }
    return pages;
  }

  getRootCollections(rootDoc) {
    const setting = rootDoc.getMap('setting');
    let collections = setting.get('collections');
    if (!(collections instanceof Y.Array)) {
      collections = new Y.Array();
      setting.set('collections', collections);
    }
    return collections;
  }

  listPagesFromRoot(rootDoc) {
    const pages = this.getRootPages(rootDoc);
    return pages.toArray().map(item => {
      if (item instanceof Y.Map) {
        const tags = item.get('tags');
        return {
          docId: item.get('id') ?? null,
          title: item.get('title') ?? '',
          createDate: item.get('createDate') ?? null,
          updatedDate: item.get('updatedDate') ?? null,
          tags: tags instanceof Y.Array ? tags.toArray() : [],
        };
      }

      return {
        docId: item.id ?? null,
        title: item.title ?? '',
        createDate: item.createDate ?? null,
        updatedDate: item.updatedDate ?? null,
        tags: Array.isArray(item.tags) ? item.tags : [],
      };
    });
  }

  createBaseDoc(title = '') {
    const doc = new Y.Doc();
    const blocks = doc.getMap('blocks');

    const pageId = nanoid();
    const surfaceId = nanoid();
    const noteId = nanoid();

    const page = new Y.Map();
    page.set('sys:id', pageId);
    page.set('sys:flavour', 'affine:page');
    const pageChildren = new Y.Array();
    pageChildren.insert(0, [surfaceId, noteId]);
    page.set('sys:children', pageChildren);
    const titleText = new Y.Text();
    if (title) titleText.insert(0, title);
    page.set('prop:title', titleText);

    const surface = new Y.Map();
    surface.set('sys:id', surfaceId);
    surface.set('sys:flavour', 'affine:surface');
    surface.set('sys:children', new Y.Array());

    const note = new Y.Map();
    note.set('sys:id', noteId);
    note.set('sys:flavour', 'affine:note');
    note.set('sys:children', new Y.Array());

    blocks.set(pageId, page);
    blocks.set(surfaceId, surface);
    blocks.set(noteId, note);

    return { doc, pageId, noteId };
  }

  appendParagraphBlock(ydoc, text, type = 'text') {
    const blocks = ydoc.getMap('blocks');
    const noteEntry = [...blocks.values()].find(
      block =>
        block instanceof Y.Map && block.get('sys:flavour') === 'affine:note'
    );

    if (!(noteEntry instanceof Y.Map)) {
      throw new Error('No affine:note block found');
    }

    const noteChildren = noteEntry.get('sys:children');
    if (!(noteChildren instanceof Y.Array)) {
      throw new Error('Invalid note children');
    }

    const blockId = nanoid();
    const block = new Y.Map();
    block.set('sys:id', blockId);
    block.set('sys:flavour', 'affine:paragraph');
    block.set('sys:children', new Y.Array());
    block.set('prop:type', type);
    const content = new Y.Text();
    if (text) content.insert(0, text);
    block.set('prop:text', content);

    blocks.set(blockId, block);
    noteChildren.push([blockId]);

    return blockId;
  }

  parseDocToMarkdown(ydoc) {
    const blocks = ydoc.getMap('blocks');

    const page = [...blocks.values()].find(
      block =>
        block instanceof Y.Map && block.get('sys:flavour') === 'affine:page'
    );

    const titleText = page?.get('prop:title');
    const title = titleText instanceof Y.Text ? titleText.toString() : '';

    const note = [...blocks.values()].find(
      block =>
        block instanceof Y.Map && block.get('sys:flavour') === 'affine:note'
    );

    const lines = [];
    if (title) lines.push(`# ${title}`);

    const children = note?.get('sys:children');
    if (children instanceof Y.Array) {
      for (const childId of children.toArray()) {
        const block = blocks.get(childId);
        if (!(block instanceof Y.Map)) continue;
        const flavour = block.get('sys:flavour');

        if (flavour === 'affine:paragraph' || flavour === 'affine:list') {
          const text = block.get('prop:text');
          const value = text instanceof Y.Text ? text.toString() : '';
          const type = block.get('prop:type') ?? 'text';

          if (type === 'h1') lines.push(`# ${value}`);
          else if (type === 'h2') lines.push(`## ${value}`);
          else if (type === 'h3') lines.push(`### ${value}`);
          else if (type === 'bulleted') lines.push(`- ${value}`);
          else if (type === 'numbered') lines.push(`1. ${value}`);
          else if (type === 'todo') {
            const checked = block.get('prop:checked') ? 'x' : ' ';
            lines.push(`- [${checked}] ${value}`);
          } else lines.push(value);
        } else if (flavour === 'affine:code') {
          const text = block.get('prop:text');
          const value = text instanceof Y.Text ? text.toString() : '';
          const lang = block.get('prop:language') ?? '';
          lines.push(`\`\`\`${lang}`);
          lines.push(value);
          lines.push('```');
        } else if (flavour === 'affine:divider') {
          lines.push('---');
        }
      }
    }

    return lines.join('\n\n').trim();
  }

  async listDocs() {
    const { ydoc } = await this.loadYDoc(this.workspaceId);
    return this.listPagesFromRoot(ydoc);
  }

  async createDoc({ title, markdown }) {
    const docId = nanoid();
    const base = this.createBaseDoc(title);

    if (markdown?.trim()) {
      for (const line of markdown.split(/\n+/)) {
        const t = line.trim();
        if (!t) continue;
        this.appendParagraphBlock(base.doc, t);
      }
    }

    const initialUpdate = Y.encodeStateAsUpdate(base.doc);

    await this.pushYUpdate(docId, initialUpdate);

    await this.mutateDocSequential(this.workspaceId, rootDoc => {
      const pages = this.getRootPages(rootDoc);
      const now = Date.now();
      const pageMeta = new Y.Map();
      pageMeta.set('id', docId);
      pageMeta.set('title', title ?? '');
      pageMeta.set('createDate', now);
      pageMeta.set('updatedDate', now);
      pageMeta.set('tags', new Y.Array());
      pages.push([pageMeta]);
    });

    return { docId, title: title ?? '' };
  }

  async readDoc(docId) {
    const { ydoc } = await this.loadYDoc(docId);
    const markdown = this.parseDocToMarkdown(ydoc);
    const blocks = ydoc.getMap('blocks');
    return {
      docId,
      markdown,
      blockCount: blocks.size,
    };
  }

  async editDoc({ docId, operations }) {
    const produced = [];

    for (const operation of operations) {
      const result = await this.mutateDocSequential(docId, ydoc => {
        const blocks = ydoc.getMap('blocks');

        if (operation.action === 'append') {
          if (operation.blockType === 'code') {
            const note = [...blocks.values()].find(
              block =>
                block instanceof Y.Map &&
                block.get('sys:flavour') === 'affine:note'
            );
            if (!(note instanceof Y.Map)) throw new Error('No note block');
            const noteChildren = note.get('sys:children');
            if (!(noteChildren instanceof Y.Array))
              throw new Error('Invalid note children');

            const blockId = nanoid();
            const block = new Y.Map();
            block.set('sys:id', blockId);
            block.set('sys:flavour', 'affine:code');
            block.set('sys:children', new Y.Array());
            block.set('prop:language', operation.language ?? 'text');
            const text = new Y.Text();
            if (operation.content) text.insert(0, operation.content);
            block.set('prop:text', text);
            blocks.set(blockId, block);
            noteChildren.push([blockId]);
            produced.push(blockId);
          } else {
            const typeMap = {
              heading1: 'h1',
              heading2: 'h2',
              bulleted: 'bulleted',
              numbered: 'numbered',
              todo: 'todo',
              text: 'text',
            };
            const blockId = this.appendParagraphBlock(
              ydoc,
              operation.content ?? '',
              typeMap[operation.blockType] ?? 'text'
            );

            if (operation.blockType === 'todo') {
              const block = blocks.get(blockId);
              if (block instanceof Y.Map) block.set('prop:checked', false);
            }
            produced.push(blockId);
          }
        } else if (operation.action === 'update') {
          const target = blocks.get(operation.blockId);
          if (!(target instanceof Y.Map))
            throw new Error(`Block not found: ${operation.blockId}`);
          const propText = target.get('prop:text');
          if (!(propText instanceof Y.Text))
            throw new Error('Target block has no text');
          propText.delete(0, propText.length);
          propText.insert(0, operation.content ?? '');
          produced.push(operation.blockId);
        } else if (operation.action === 'delete') {
          const note = [...blocks.values()].find(
            block =>
              block instanceof Y.Map &&
              block.get('sys:flavour') === 'affine:note'
          );
          if (!(note instanceof Y.Map)) throw new Error('No note block');
          const noteChildren = note.get('sys:children');
          if (noteChildren instanceof Y.Array) {
            const ids = noteChildren.toArray();
            const idx = ids.indexOf(operation.blockId);
            if (idx >= 0) noteChildren.delete(idx, 1);
          }
          blocks.delete(operation.blockId);
          produced.push(operation.blockId);
        } else {
          throw new Error(`Unsupported action: ${operation.action}`);
        }
      });

      if (!result.changed) {
        throw new Error(`No update produced for operation ${operation.action}`);
      }
    }

    return { success: true, blockIds: produced };
  }

  async deleteDoc(docId) {
    await this.emitAck('space:delete-doc', {
      spaceType: 'workspace',
      spaceId: this.workspaceId,
      docId,
    });

    await this.mutateDocSequential(this.workspaceId, rootDoc => {
      const pages = this.getRootPages(rootDoc);
      const arr = pages.toArray();
      const idx = arr.findIndex(item =>
        item instanceof Y.Map ? item.get('id') === docId : item.id === docId
      );
      if (idx >= 0) pages.delete(idx, 1);
    });

    return { success: true, docId };
  }

  async listCollections() {
    const { ydoc } = await this.loadYDoc(this.workspaceId);
    const collections = this.getRootCollections(ydoc);

    return collections.toArray().map(item => {
      const id = item instanceof Y.Map ? item.get('id') : item.id;
      const name = item instanceof Y.Map ? item.get('name') : item.name;
      const allowList =
        item instanceof Y.Map ? item.get('allowList') : item.allowList;
      const docIds =
        allowList instanceof Y.Array
          ? allowList.toArray()
          : Array.isArray(allowList)
            ? allowList
            : [];
      return { id, name, docCount: docIds.length, docIds };
    });
  }

  async createCollection({ name, docIds = [] }) {
    const id = nanoid();

    await this.mutateDocSequential(this.workspaceId, rootDoc => {
      const collections = this.getRootCollections(rootDoc);
      const record = new Y.Map();
      record.set('id', id);
      record.set('name', name);
      const rules = new Y.Map();
      rules.set('filters', new Y.Array());
      record.set('rules', rules);
      const allowList = new Y.Array();
      if (docIds.length) allowList.insert(0, docIds);
      record.set('allowList', allowList);
      collections.push([record]);
    });

    return { id, name };
  }

  async updateCollection({
    collectionId,
    addDocIds = [],
    removeDocIds = [],
    name,
  }) {
    await this.mutateDocSequential(this.workspaceId, rootDoc => {
      const collections = this.getRootCollections(rootDoc);
      const arr = collections.toArray();
      const idx = arr.findIndex(item =>
        item instanceof Y.Map
          ? item.get('id') === collectionId
          : item.id === collectionId
      );
      if (idx < 0) throw new Error(`Collection not found: ${collectionId}`);

      const item = collections.get(idx);
      if (!(item instanceof Y.Map))
        throw new Error('Collection entry is not YMap');

      if (typeof name === 'string') item.set('name', name);

      let allowList = item.get('allowList');
      if (!(allowList instanceof Y.Array)) {
        allowList = new Y.Array();
        item.set('allowList', allowList);
      }

      const existing = new Set(allowList.toArray());
      for (const docId of addDocIds) existing.add(docId);
      for (const docId of removeDocIds) existing.delete(docId);

      allowList.delete(0, allowList.length);
      if (existing.size) allowList.insert(0, [...existing]);
    });

    return { success: true, collectionId };
  }

  async deleteCollection(collectionId) {
    await this.mutateDocSequential(this.workspaceId, rootDoc => {
      const collections = this.getRootCollections(rootDoc);
      const arr = collections.toArray();
      const idx = arr.findIndex(item =>
        item instanceof Y.Map
          ? item.get('id') === collectionId
          : item.id === collectionId
      );
      if (idx >= 0) collections.delete(idx, 1);
    });

    return { success: true, collectionId };
  }

  async currentUser() {
    const data = await this.graphql(
      `query { currentUser { id name email avatarUrl } }`
    );
    return data.currentUser;
  }

  async listComments(docId) {
    const data = await this.graphql(
      `query($ws: String!, $docId: String!) {
         workspace(id: $ws) {
           comments(docId: $docId) {
             edges { node { id content createdAt updatedAt resolved user { id name } replies { id content createdAt user { id name } } } }
           }
         }
       }`,
      { ws: this.workspaceId, docId }
    );

    return data.workspace.comments.edges.map(e => e.node);
  }

  async createComment({ docId, content, docTitle }) {
    const payload = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: content }],
        },
      ],
    };

    const data = await this.graphql(
      `mutation($input: CommentCreateInput!) {
         createComment(input: $input) { id content createdAt resolved }
       }`,
      {
        input: {
          workspaceId: this.workspaceId,
          docId,
          docMode: 'page',
          docTitle,
          content: payload,
        },
      }
    );

    return data.createComment;
  }

  async resolveComment(commentId) {
    const data = await this.graphql(
      `mutation($input: CommentResolveInput!) { resolveComment(input: $input) }`,
      { input: { id: commentId, resolved: true } }
    );
    return { success: data.resolveComment };
  }

  async deleteComment(commentId) {
    const data = await this.graphql(
      `mutation($id: String!) { deleteComment(id: $id) }`,
      { id: commentId }
    );
    return { success: data.deleteComment };
  }

  async search(query) {
    const docs = await this.listDocs();
    const lowered = query.toLowerCase();
    const matches = [];

    for (const doc of docs.slice(0, 50)) {
      try {
        const content = await this.readDoc(doc.docId);
        if (
          (doc.title ?? '').toLowerCase().includes(lowered) ||
          content.markdown.toLowerCase().includes(lowered)
        ) {
          matches.push({
            docId: doc.docId,
            title: doc.title,
            snippet: content.markdown.slice(0, 240),
          });
        }
      } catch {
        // ignore unreadable docs
      }
    }

    return matches;
  }
}

const client = new AffineClient();

function asText(obj) {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
  };
}

const server = new McpServer({
  name: 'affine-openclaw-mcp',
  version: '0.1.0',
});

server.registerTool(
  'current_user',
  {
    title: 'Current User',
    description: 'Get current authenticated AFFiNE user',
    inputSchema: z.object({}),
  },
  async () => asText(await client.currentUser())
);

server.registerTool(
  'list_docs',
  {
    title: 'List Docs',
    description: 'List all workspace documents',
    inputSchema: z.object({}),
  },
  async () => asText(await client.listDocs())
);

server.registerTool(
  'create_doc',
  {
    title: 'Create Doc',
    description: 'Create a doc with optional markdown-like seed paragraphs',
    inputSchema: z.object({
      title: z.string().min(1),
      markdown: z.string().optional(),
    }),
  },
  async input => asText(await client.createDoc(input))
);

server.registerTool(
  'read_doc',
  {
    title: 'Read Doc',
    description: 'Read a doc and convert to markdown',
    inputSchema: z.object({ docId: z.string() }),
  },
  async ({ docId }) => asText(await client.readDoc(docId))
);

server.registerTool(
  'edit_doc',
  {
    title: 'Edit Doc',
    description: 'Sequential block-level edit operations',
    inputSchema: z.object({
      docId: z.string(),
      operations: z.array(
        z.object({
          action: z.enum(['append', 'update', 'delete']),
          blockType: z
            .enum([
              'text',
              'heading1',
              'heading2',
              'bulleted',
              'numbered',
              'todo',
              'code',
            ])
            .optional(),
          content: z.string().optional(),
          blockId: z.string().optional(),
          language: z.string().optional(),
        })
      ),
    }),
  },
  async input => asText(await client.editDoc(input))
);

server.registerTool(
  'delete_doc',
  {
    title: 'Delete Doc',
    description: 'Delete doc from workspace',
    inputSchema: z.object({ docId: z.string() }),
  },
  async ({ docId }) => asText(await client.deleteDoc(docId))
);

server.registerTool(
  'list_collections',
  {
    title: 'List Collections',
    description: 'List workspace collections and doc IDs',
    inputSchema: z.object({}),
  },
  async () => asText(await client.listCollections())
);

server.registerTool(
  'create_collection',
  {
    title: 'Create Collection',
    description: 'Create collection and optional doc links',
    inputSchema: z.object({
      name: z.string().min(1),
      docIds: z.array(z.string()).optional(),
    }),
  },
  async input => asText(await client.createCollection(input))
);

server.registerTool(
  'update_collection',
  {
    title: 'Update Collection',
    description: 'Rename collection and add/remove docs',
    inputSchema: z.object({
      collectionId: z.string(),
      addDocIds: z.array(z.string()).optional(),
      removeDocIds: z.array(z.string()).optional(),
      name: z.string().optional(),
    }),
  },
  async input => asText(await client.updateCollection(input))
);

server.registerTool(
  'delete_collection',
  {
    title: 'Delete Collection',
    description: 'Delete collection only',
    inputSchema: z.object({ collectionId: z.string() }),
  },
  async ({ collectionId }) =>
    asText(await client.deleteCollection(collectionId))
);

server.registerTool(
  'list_comments',
  {
    title: 'List Comments',
    description: 'List comments on a doc',
    inputSchema: z.object({ docId: z.string() }),
  },
  async ({ docId }) => asText(await client.listComments(docId))
);

server.registerTool(
  'create_comment',
  {
    title: 'Create Comment',
    description: 'Create a document-level comment',
    inputSchema: z.object({
      docId: z.string(),
      docTitle: z.string().min(1),
      content: z.string().min(1),
    }),
  },
  async input => asText(await client.createComment(input))
);

server.registerTool(
  'resolve_comment',
  {
    title: 'Resolve Comment',
    description: 'Resolve a comment',
    inputSchema: z.object({ commentId: z.string() }),
  },
  async ({ commentId }) => asText(await client.resolveComment(commentId))
);

server.registerTool(
  'delete_comment',
  {
    title: 'Delete Comment',
    description: 'Delete a comment',
    inputSchema: z.object({ commentId: z.string() }),
  },
  async ({ commentId }) => asText(await client.deleteComment(commentId))
);

server.registerTool(
  'search',
  {
    title: 'Search',
    description: 'Best-effort local content search over docs',
    inputSchema: z.object({ query: z.string().min(1) }),
  },
  async ({ query }) => asText(await client.search(query))
);

async function main() {
  await client.init();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('[affine-openclaw-mcp] fatal:', err);
  process.exit(1);
});
