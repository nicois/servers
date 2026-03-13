import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  KnowledgeGraphManager,
  sanitizeUserId,
  getUserMemoryFilePath,
  ensureMemoryBaseDir,
} from '../index.js';

describe('Multi-user helpers', () => {
  describe('sanitizeUserId', () => {
    it('should preserve alphanumeric characters', () => {
      expect(sanitizeUserId('alice123')).toBe('alice123');
    });

    it('should preserve underscores, hyphens, and dots', () => {
      expect(sanitizeUserId('alice_b-c.d')).toBe('alice_b-c.d');
    });

    it('should replace spaces with underscores', () => {
      expect(sanitizeUserId('alice smith')).toBe('alice_smith');
    });

    it('should replace path traversal characters', () => {
      // Dots are allowed (for email-like IDs), but slashes are stripped
      expect(sanitizeUserId('../etc/passwd')).toBe('.._etc_passwd');
    });

    it('should replace slashes', () => {
      expect(sanitizeUserId('user/name\\dir')).toBe('user_name_dir');
    });

    it('should replace special characters', () => {
      expect(sanitizeUserId('user@example.com')).toBe('user_example.com');
    });

    it('should handle unicode characters', () => {
      expect(sanitizeUserId('ユーザー')).toBe('____');
    });
  });

  describe('getUserMemoryFilePath', () => {
    it('should return correct path for a simple userId', () => {
      const result = getUserMemoryFilePath('/data/memories', 'alice');
      expect(result).toBe(path.join('/data/memories', 'alice.jsonl'));
    });

    it('should sanitize the userId in the path', () => {
      const result = getUserMemoryFilePath('/data/memories', '../evil');
      expect(result).toBe(path.join('/data/memories', '.._evil.jsonl'));
    });

    it('should handle userId with dots', () => {
      const result = getUserMemoryFilePath('/data/memories', 'user@host.com');
      expect(result).toBe(path.join('/data/memories', 'user_host.com.jsonl'));
    });
  });

  describe('ensureMemoryBaseDir', () => {
    const originalEnv = process.env.MEMORY_BASE_DIR;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.MEMORY_BASE_DIR;
      } else {
        process.env.MEMORY_BASE_DIR = originalEnv;
      }
    });

    it('should return null when MEMORY_BASE_DIR is not set', async () => {
      delete process.env.MEMORY_BASE_DIR;
      const result = await ensureMemoryBaseDir();
      expect(result).toBeNull();
    });

    it('should return resolved path for absolute MEMORY_BASE_DIR', async () => {
      const tmpDir = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        `test-base-dir-${Date.now()}`
      );
      process.env.MEMORY_BASE_DIR = tmpDir;

      const result = await ensureMemoryBaseDir();
      expect(result).toBe(tmpDir);

      // Directory should have been created
      const stat = await fs.stat(tmpDir);
      expect(stat.isDirectory()).toBe(true);

      // Cleanup
      await fs.rmdir(tmpDir);
    });

    it('should resolve relative MEMORY_BASE_DIR from module directory', async () => {
      process.env.MEMORY_BASE_DIR = `test-relative-${Date.now()}`;

      const result = await ensureMemoryBaseDir();
      expect(result).not.toBeNull();
      expect(path.isAbsolute(result!)).toBe(true);

      // Cleanup
      await fs.rmdir(result!);
    });
  });
});

describe('Multi-user data isolation', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      `test-multi-user-${Date.now()}`
    );
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up all files in the temp dir
    try {
      const files = await fs.readdir(tmpDir);
      for (const file of files) {
        await fs.unlink(path.join(tmpDir, file));
      }
      await fs.rmdir(tmpDir);
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should isolate data between users with separate managers', async () => {
    const aliceManager = new KnowledgeGraphManager(path.join(tmpDir, 'alice.jsonl'));
    const bobManager = new KnowledgeGraphManager(path.join(tmpDir, 'bob.jsonl'));

    await aliceManager.createEntities([
      { name: 'AliceSecret', entityType: 'note', observations: ['private to alice'] },
    ]);

    await bobManager.createEntities([
      { name: 'BobSecret', entityType: 'note', observations: ['private to bob'] },
    ]);

    const aliceGraph = await aliceManager.readGraph();
    expect(aliceGraph.entities).toHaveLength(1);
    expect(aliceGraph.entities[0].name).toBe('AliceSecret');

    const bobGraph = await bobManager.readGraph();
    expect(bobGraph.entities).toHaveLength(1);
    expect(bobGraph.entities[0].name).toBe('BobSecret');
  });

  it('should not leak entities across user files', async () => {
    const aliceManager = new KnowledgeGraphManager(path.join(tmpDir, 'alice.jsonl'));
    const bobManager = new KnowledgeGraphManager(path.join(tmpDir, 'bob.jsonl'));

    await aliceManager.createEntities([
      { name: 'Shared', entityType: 'concept', observations: ['alice version'] },
    ]);

    await bobManager.createEntities([
      { name: 'Shared', entityType: 'concept', observations: ['bob version'] },
    ]);

    // Both should have the entity, but with their own observations
    const aliceGraph = await aliceManager.readGraph();
    expect(aliceGraph.entities[0].observations).toEqual(['alice version']);

    const bobGraph = await bobManager.readGraph();
    expect(bobGraph.entities[0].observations).toEqual(['bob version']);
  });

  it('should not leak relations across user files', async () => {
    const aliceManager = new KnowledgeGraphManager(path.join(tmpDir, 'alice.jsonl'));
    const bobManager = new KnowledgeGraphManager(path.join(tmpDir, 'bob.jsonl'));

    await aliceManager.createEntities([
      { name: 'A', entityType: 'node', observations: [] },
      { name: 'B', entityType: 'node', observations: [] },
    ]);
    await aliceManager.createRelations([
      { from: 'A', to: 'B', relationType: 'alice_link' },
    ]);

    const bobGraph = await bobManager.readGraph();
    expect(bobGraph.entities).toHaveLength(0);
    expect(bobGraph.relations).toHaveLength(0);
  });

  it('should use separate files per user', async () => {
    const aliceManager = new KnowledgeGraphManager(
      getUserMemoryFilePath(tmpDir, 'alice')
    );
    const bobManager = new KnowledgeGraphManager(
      getUserMemoryFilePath(tmpDir, 'bob')
    );

    await aliceManager.createEntities([
      { name: 'Test', entityType: 'test', observations: [] },
    ]);

    // Verify the file was created at the right path
    const aliceFile = path.join(tmpDir, 'alice.jsonl');
    const stat = await fs.stat(aliceFile);
    expect(stat.isFile()).toBe(true);

    // Bob's file should not exist yet
    await expect(fs.stat(path.join(tmpDir, 'bob.jsonl'))).rejects.toThrow();
  });
});
