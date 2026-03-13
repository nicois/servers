#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Define memory file path using environment variable with fallback
export const defaultMemoryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory.jsonl');

// Handle backward compatibility: migrate memory.json to memory.jsonl if needed
export async function ensureMemoryFilePath(): Promise<string> {
  if (process.env.MEMORY_FILE_PATH) {
    // Custom path provided, use it as-is (with absolute path resolution)
    return path.isAbsolute(process.env.MEMORY_FILE_PATH)
      ? process.env.MEMORY_FILE_PATH
      : path.join(path.dirname(fileURLToPath(import.meta.url)), process.env.MEMORY_FILE_PATH);
  }
  
  // No custom path set, check for backward compatibility migration
  const oldMemoryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory.json');
  const newMemoryPath = defaultMemoryPath;
  
  try {
    // Check if old file exists and new file doesn't
    await fs.access(oldMemoryPath);
    try {
      await fs.access(newMemoryPath);
      // Both files exist, use new one (no migration needed)
      return newMemoryPath;
    } catch {
      // Old file exists, new file doesn't - migrate
      console.error('DETECTED: Found legacy memory.json file, migrating to memory.jsonl for JSONL format compatibility');
      await fs.rename(oldMemoryPath, newMemoryPath);
      console.error('COMPLETED: Successfully migrated memory.json to memory.jsonl');
      return newMemoryPath;
    }
  } catch {
    // Old file doesn't exist, use new path
    return newMemoryPath;
  }
}

// Initialize memory file path (will be set during startup)
let MEMORY_FILE_PATH: string;

// Multi-user state
let defaultManager: KnowledgeGraphManager;
let memoryBaseDir: string | null = null;

// Session-scoped user tracking (for multi-connection transports like SSE/HTTP)
const sessionUsers: Map<string, string> = new Map();

// Fallback for transports without sessionId (stdio — single connection)
let globalUserId: string | null = null;

// Cache of per-user managers
const userManagers: Map<string, KnowledgeGraphManager> = new Map();

// We are storing our memory using entities, relations, and observations in a graph structure
export interface Entity {
  name: string;
  entityType: string;
  observations: string[];
}

export interface Relation {
  from: string;
  to: string;
  relationType: string;
}

export interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

// The KnowledgeGraphManager class contains all operations to interact with the knowledge graph
export class KnowledgeGraphManager {
  constructor(private memoryFilePath: string) {}

  private async loadGraph(): Promise<KnowledgeGraph> {
    try {
      const data = await fs.readFile(this.memoryFilePath, "utf-8");
      const lines = data.split("\n").filter(line => line.trim() !== "");
      return lines.reduce((graph: KnowledgeGraph, line) => {
        const item = JSON.parse(line);
        if (item.type === "entity") {
          graph.entities.push({
            name: item.name,
            entityType: item.entityType,
            observations: item.observations
          });
        }
        if (item.type === "relation") {
          graph.relations.push({
            from: item.from,
            to: item.to,
            relationType: item.relationType
          });
        }
        return graph;
      }, { entities: [], relations: [] });
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as any).code === "ENOENT") {
        return { entities: [], relations: [] };
      }
      throw error;
    }
  }

  private async saveGraph(graph: KnowledgeGraph): Promise<void> {
    const lines = [
      ...graph.entities.map(e => JSON.stringify({
        type: "entity",
        name: e.name,
        entityType: e.entityType,
        observations: e.observations
      })),
      ...graph.relations.map(r => JSON.stringify({
        type: "relation",
        from: r.from,
        to: r.to,
        relationType: r.relationType
      })),
    ];
    await fs.writeFile(this.memoryFilePath, lines.join("\n"));
  }

  async createEntities(entities: Entity[]): Promise<Entity[]> {
    const graph = await this.loadGraph();
    const newEntities = entities.filter(e => !graph.entities.some(existingEntity => existingEntity.name === e.name));
    graph.entities.push(...newEntities);
    await this.saveGraph(graph);
    return newEntities;
  }

  async createRelations(relations: Relation[]): Promise<Relation[]> {
    const graph = await this.loadGraph();
    const newRelations = relations.filter(r => !graph.relations.some(existingRelation => 
      existingRelation.from === r.from && 
      existingRelation.to === r.to && 
      existingRelation.relationType === r.relationType
    ));
    graph.relations.push(...newRelations);
    await this.saveGraph(graph);
    return newRelations;
  }

  async addObservations(observations: { entityName: string; contents: string[] }[]): Promise<{ entityName: string; addedObservations: string[] }[]> {
    const graph = await this.loadGraph();
    const results = observations.map(o => {
      const entity = graph.entities.find(e => e.name === o.entityName);
      if (!entity) {
        throw new Error(`Entity with name ${o.entityName} not found`);
      }
      const newObservations = o.contents.filter(content => !entity.observations.includes(content));
      entity.observations.push(...newObservations);
      return { entityName: o.entityName, addedObservations: newObservations };
    });
    await this.saveGraph(graph);
    return results;
  }

  async deleteEntities(entityNames: string[]): Promise<void> {
    const graph = await this.loadGraph();
    graph.entities = graph.entities.filter(e => !entityNames.includes(e.name));
    graph.relations = graph.relations.filter(r => !entityNames.includes(r.from) && !entityNames.includes(r.to));
    await this.saveGraph(graph);
  }

  async deleteObservations(deletions: { entityName: string; observations: string[] }[]): Promise<void> {
    const graph = await this.loadGraph();
    deletions.forEach(d => {
      const entity = graph.entities.find(e => e.name === d.entityName);
      if (entity) {
        entity.observations = entity.observations.filter(o => !d.observations.includes(o));
      }
    });
    await this.saveGraph(graph);
  }

  async deleteRelations(relations: Relation[]): Promise<void> {
    const graph = await this.loadGraph();
    graph.relations = graph.relations.filter(r => !relations.some(delRelation => 
      r.from === delRelation.from && 
      r.to === delRelation.to && 
      r.relationType === delRelation.relationType
    ));
    await this.saveGraph(graph);
  }

  async readGraph(): Promise<KnowledgeGraph> {
    return this.loadGraph();
  }

  // Very basic search function
  async searchNodes(query: string): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();
    
    // Filter entities
    const filteredEntities = graph.entities.filter(e => 
      e.name.toLowerCase().includes(query.toLowerCase()) ||
      e.entityType.toLowerCase().includes(query.toLowerCase()) ||
      e.observations.some(o => o.toLowerCase().includes(query.toLowerCase()))
    );
  
    // Create a Set of filtered entity names for quick lookup
    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
  
    // Include relations where at least one endpoint matches the search results.
    // This lets callers discover connections to nodes outside the result set.
    const filteredRelations = graph.relations.filter(r => 
      filteredEntityNames.has(r.from) || filteredEntityNames.has(r.to)
    );
  
    const filteredGraph: KnowledgeGraph = {
      entities: filteredEntities,
      relations: filteredRelations,
    };
  
    return filteredGraph;
  }

  async openNodes(names: string[]): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();
    
    // Filter entities
    const filteredEntities = graph.entities.filter(e => names.includes(e.name));
  
    // Create a Set of filtered entity names for quick lookup
    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
  
    // Include relations where at least one endpoint is in the requested set.
    // Previously this required BOTH endpoints, which meant relations from a
    // requested node to an unrequested node were silently dropped — making it
    // impossible to discover a node's connections without reading the full graph.
    const filteredRelations = graph.relations.filter(r => 
      filteredEntityNames.has(r.from) || filteredEntityNames.has(r.to)
    );
  
    const filteredGraph: KnowledgeGraph = {
      entities: filteredEntities,
      relations: filteredRelations,
    };
  
    return filteredGraph;
  }
}

let knowledgeGraphManager: KnowledgeGraphManager;

export function sanitizeUserId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
}

export function getUserMemoryFilePath(baseDir: string, userId: string): string {
  return path.join(baseDir, `${sanitizeUserId(userId)}.jsonl`);
}

export async function ensureMemoryBaseDir(): Promise<string | null> {
  const baseDir = process.env.MEMORY_BASE_DIR;
  if (!baseDir) return null;
  const resolved = path.isAbsolute(baseDir)
    ? baseDir
    : path.join(path.dirname(fileURLToPath(import.meta.url)), baseDir);
  await fs.mkdir(resolved, { recursive: true });
  return resolved;
}

function getOrCreateUserManager(userId: string): KnowledgeGraphManager {
  let mgr = userManagers.get(userId);
  if (!mgr) {
    mgr = new KnowledgeGraphManager(getUserMemoryFilePath(memoryBaseDir!, userId));
    userManagers.set(userId, mgr);
  }
  return mgr;
}

export function extractUserIdFromHeaders(
  headers?: Record<string, string | string[] | undefined>
): string | null {
  if (!headers) return null;
  const value = headers["x-mcp-user"];
  if (!value) return null;
  const userId = Array.isArray(value) ? value[0] : value;
  return userId && userId.length > 0 ? userId : null;
}

function getManagerForSession(extra?: {
  sessionId?: string;
  requestInfo?: { headers?: Record<string, string | string[] | undefined> };
}): KnowledgeGraphManager | null {
  if (!memoryBaseDir) return defaultManager;
  if (extra?.sessionId) {
    const uid = sessionUsers.get(extra.sessionId);
    if (uid) return getOrCreateUserManager(uid);
  }
  if (globalUserId) return getOrCreateUserManager(globalUserId);
  // Check for user identity in HTTP headers (e.g. set by a reverse proxy)
  const headerUserId = extractUserIdFromHeaders(extra?.requestInfo?.headers);
  if (headerUserId) return getOrCreateUserManager(headerUserId);
  // Multi-user mode is active but no user has been set — refuse to operate
  // so that data doesn't accidentally land in a shared default graph.
  return null;
}

function setUserRequiredResponse() {
  return {
    content: [{ type: "text" as const, text: "Error: No user set. Call set_user or provide the X-MCP-User HTTP header to bind a user identity to this session." }],
    isError: true as const,
  };
}

// For tests
export function _resetMultiUserState(): void {
  sessionUsers.clear();
  userManagers.clear();
  globalUserId = null;
}

// Zod schemas for entities and relations
const EntitySchema = z.object({
  name: z.string().describe("The name of the entity"),
  entityType: z.string().describe("The type of the entity"),
  observations: z.array(z.string()).describe("An array of observation contents associated with the entity")
});

const RelationSchema = z.object({
  from: z.string().describe("The name of the entity where the relation starts"),
  to: z.string().describe("The name of the entity where the relation ends"),
  relationType: z.string().describe("The type of the relation")
});

// The server instance and tools exposed to Claude
const server = new McpServer({
  name: "memory-server",
  version: "0.6.3",
});

// Register create_entities tool
server.registerTool(
  "create_entities",
  {
    title: "Create Entities",
    description: "Create multiple new entities in the knowledge graph",
    inputSchema: {
      entities: z.array(EntitySchema)
    },
    outputSchema: {
      entities: z.array(EntitySchema)
    }
  },
  async ({ entities }, extra) => {
    const manager = getManagerForSession(extra);
    if (!manager) return setUserRequiredResponse();
    const result = await manager.createEntities(entities);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { entities: result }
    };
  }
);

// Register create_relations tool
server.registerTool(
  "create_relations",
  {
    title: "Create Relations",
    description: "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
    inputSchema: {
      relations: z.array(RelationSchema)
    },
    outputSchema: {
      relations: z.array(RelationSchema)
    }
  },
  async ({ relations }, extra) => {
    const manager = getManagerForSession(extra);
    if (!manager) return setUserRequiredResponse();
    const result = await manager.createRelations(relations);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { relations: result }
    };
  }
);

// Register add_observations tool
server.registerTool(
  "add_observations",
  {
    title: "Add Observations",
    description: "Add new observations to existing entities in the knowledge graph",
    inputSchema: {
      observations: z.array(z.object({
        entityName: z.string().describe("The name of the entity to add the observations to"),
        contents: z.array(z.string()).describe("An array of observation contents to add")
      }))
    },
    outputSchema: {
      results: z.array(z.object({
        entityName: z.string(),
        addedObservations: z.array(z.string())
      }))
    }
  },
  async ({ observations }, extra) => {
    const manager = getManagerForSession(extra);
    if (!manager) return setUserRequiredResponse();
    const result = await manager.addObservations(observations);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { results: result }
    };
  }
);

// Register delete_entities tool
server.registerTool(
  "delete_entities",
  {
    title: "Delete Entities",
    description: "Delete multiple entities and their associated relations from the knowledge graph",
    inputSchema: {
      entityNames: z.array(z.string()).describe("An array of entity names to delete")
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string()
    }
  },
  async ({ entityNames }, extra) => {
    const manager = getManagerForSession(extra);
    if (!manager) return setUserRequiredResponse();
    await manager.deleteEntities(entityNames);
    return {
      content: [{ type: "text" as const, text: "Entities deleted successfully" }],
      structuredContent: { success: true, message: "Entities deleted successfully" }
    };
  }
);

// Register delete_observations tool
server.registerTool(
  "delete_observations",
  {
    title: "Delete Observations",
    description: "Delete specific observations from entities in the knowledge graph",
    inputSchema: {
      deletions: z.array(z.object({
        entityName: z.string().describe("The name of the entity containing the observations"),
        observations: z.array(z.string()).describe("An array of observations to delete")
      }))
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string()
    }
  },
  async ({ deletions }, extra) => {
    const manager = getManagerForSession(extra);
    if (!manager) return setUserRequiredResponse();
    await manager.deleteObservations(deletions);
    return {
      content: [{ type: "text" as const, text: "Observations deleted successfully" }],
      structuredContent: { success: true, message: "Observations deleted successfully" }
    };
  }
);

// Register delete_relations tool
server.registerTool(
  "delete_relations",
  {
    title: "Delete Relations",
    description: "Delete multiple relations from the knowledge graph",
    inputSchema: {
      relations: z.array(RelationSchema).describe("An array of relations to delete")
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string()
    }
  },
  async ({ relations }, extra) => {
    const manager = getManagerForSession(extra);
    if (!manager) return setUserRequiredResponse();
    await manager.deleteRelations(relations);
    return {
      content: [{ type: "text" as const, text: "Relations deleted successfully" }],
      structuredContent: { success: true, message: "Relations deleted successfully" }
    };
  }
);

// Register read_graph tool
server.registerTool(
  "read_graph",
  {
    title: "Read Graph",
    description: "Read the entire knowledge graph",
    inputSchema: {},
    outputSchema: {
      entities: z.array(EntitySchema),
      relations: z.array(RelationSchema)
    }
  },
  async (_args, extra) => {
    const manager = getManagerForSession(extra);
    if (!manager) return setUserRequiredResponse();
    const graph = await manager.readGraph();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph }
    };
  }
);

// Register search_nodes tool
server.registerTool(
  "search_nodes",
  {
    title: "Search Nodes",
    description: "Search for nodes in the knowledge graph based on a query",
    inputSchema: {
      query: z.string().describe("The search query to match against entity names, types, and observation content")
    },
    outputSchema: {
      entities: z.array(EntitySchema),
      relations: z.array(RelationSchema)
    }
  },
  async ({ query }, extra) => {
    const manager = getManagerForSession(extra);
    if (!manager) return setUserRequiredResponse();
    const graph = await manager.searchNodes(query);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph }
    };
  }
);

// Register open_nodes tool
server.registerTool(
  "open_nodes",
  {
    title: "Open Nodes",
    description: "Open specific nodes in the knowledge graph by their names",
    inputSchema: {
      names: z.array(z.string()).describe("An array of entity names to retrieve")
    },
    outputSchema: {
      entities: z.array(EntitySchema),
      relations: z.array(RelationSchema)
    }
  },
  async ({ names }, extra) => {
    const manager = getManagerForSession(extra);
    if (!manager) return setUserRequiredResponse();
    const graph = await manager.openNodes(names);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph }
    };
  }
);

// Register set_user tool
server.registerTool(
  "set_user",
  {
    title: "Set User",
    description: "Bind a user identity to the current session. All subsequent tool calls will operate on that user's private knowledge graph. Requires MEMORY_BASE_DIR to be configured.",
    inputSchema: {
      userId: z.string().min(1).max(128).describe("The user identifier to associate with this session")
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string()
    }
  },
  async ({ userId }, extra) => {
    if (!memoryBaseDir) {
      return {
        content: [{ type: "text" as const, text: "Error: Multi-user mode is not enabled. Set the MEMORY_BASE_DIR environment variable to enable it." }],
        structuredContent: { success: false, message: "Multi-user mode is not enabled. Set the MEMORY_BASE_DIR environment variable to enable it." },
        isError: true,
      };
    }

    const sessionId = extra?.sessionId as string | undefined;

    if (sessionId) {
      if (sessionUsers.has(sessionId)) {
        return {
          content: [{ type: "text" as const, text: "Error: User already set for this session. Cannot switch user mid-session." }],
          structuredContent: { success: false, message: "User already set for this session. Cannot switch user mid-session." },
          isError: true,
        };
      }
      sessionUsers.set(sessionId, userId);
    } else {
      if (globalUserId) {
        return {
          content: [{ type: "text" as const, text: "Error: User already set for this session. Cannot switch user mid-session." }],
          structuredContent: { success: false, message: "User already set for this session. Cannot switch user mid-session." },
          isError: true,
        };
      }
      globalUserId = userId;
    }

    return {
      content: [{ type: "text" as const, text: `User set to "${userId}". All subsequent operations will use this user's knowledge graph.` }],
      structuredContent: { success: true, message: `User set to "${userId}". All subsequent operations will use this user's knowledge graph.` }
    };
  }
);

async function main() {
  // Initialize memory file path with backward compatibility
  MEMORY_FILE_PATH = await ensureMemoryFilePath();

  // Initialize multi-user base directory
  memoryBaseDir = await ensureMemoryBaseDir();

  if (memoryBaseDir && !process.env.MEMORY_FILE_PATH) {
    // Multi-user mode: default graph lives inside the base dir
    defaultManager = new KnowledgeGraphManager(path.join(memoryBaseDir, 'default.jsonl'));
  } else {
    // Single-file mode (original behavior)
    defaultManager = new KnowledgeGraphManager(MEMORY_FILE_PATH);
    if (memoryBaseDir && process.env.MEMORY_FILE_PATH) {
      console.error('Warning: MEMORY_FILE_PATH is set alongside MEMORY_BASE_DIR. MEMORY_FILE_PATH takes precedence; multi-user mode is disabled.');
      memoryBaseDir = null;
    }
  }

  // Backward compat: keep the old variable working for any code that references it
  knowledgeGraphManager = defaultManager;

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Knowledge Graph MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
