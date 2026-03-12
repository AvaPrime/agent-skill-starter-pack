#!/usr/bin/env ts-node
/**
 * @file scripts/create-skill.ts
 * @description Interactive CLI to scaffold a new skill in under 30 seconds.
 *
 * Usage:
 *   npm run skill:create
 *   npm run skill:create -- --id my-skill --category custom --name "My Skill"
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

interface SkillConfig {
  id: string;
  name: string;
  category: string;
  description: string;
}

const CATEGORIES = ['web-scraping', 'data-analysis', 'api-integration', 'nlp', 'code-generation', 'file-processing', 'custom'];

function toPascalCase(str: string): string {
  return str.split(/[-_\s]+/).map((w) => w[0]?.toUpperCase() + w.slice(1)).join('');
}

function toCamelCase(str: string): string {
  const pascal = toPascalCase(str);
  return pascal[0]?.toLowerCase() + pascal.slice(1);
}

function toSnakeCase(str: string): string {
  return str.replace(/-/g, '_');
}

function generateSkillTemplate(config: SkillConfig): string {
  const className = toPascalCase(config.id) + 'Skill';
  const instanceName = toCamelCase(config.id) + 'Skill';
  const constPrefix = toSnakeCase(config.id).toUpperCase();

  return `/**
 * @module skills/${toSnakeCase(config.id)}
 * @description ${config.description}
 *
 * @example
 * \`\`\`ts
 * const result = await executor.run(${instanceName}, {
 *   // your input here
 * }, taskId);
 * \`\`\`
 */

import { z } from 'zod';
import { BaseSkill } from '../../core/base-skill';
import { SkillDefinition, ExecutionContext, SkillHealthStatus } from '../../core/types';
import { SkillExecutionError } from '../../core/executor';

// ── Input Schema ──────────────────────────────────────────────────────────────
// TODO: Define your input fields

export const ${toPascalCase(config.id)}InputSchema = z.object({
  // example: query: z.string().min(1).describe('The search query'),
  exampleField: z.string().min(1).describe('An example required field'),
  optionalField: z.string().optional().describe('An optional field'),
});

export type ${toPascalCase(config.id)}Input = z.infer<typeof ${toPascalCase(config.id)}InputSchema>;

// ── Output Schema ─────────────────────────────────────────────────────────────
// TODO: Define your output structure

export const ${toPascalCase(config.id)}OutputSchema = z.object({
  result: z.string().describe('The primary result'),
  processedAt: z.string().describe('ISO-8601 timestamp'),
  metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
});

export type ${toPascalCase(config.id)}Output = z.infer<typeof ${toPascalCase(config.id)}OutputSchema>;

// ── Skill Definition ──────────────────────────────────────────────────────────

export const ${toCamelCase(config.id)}Definition: SkillDefinition<${toPascalCase(config.id)}Input, ${toPascalCase(config.id)}Output> = {
  id: '${config.id}',
  name: '${config.name}',
  version: '1.0.0',
  description: '${config.description}',
  inputSchema: ${toPascalCase(config.id)}InputSchema,
  outputSchema: ${toPascalCase(config.id)}OutputSchema,
  category: '${config.category}',
  tags: ['${config.id}', 'custom'],
  supportsStreaming: false,
  maxConcurrency: 10,
  config: {
    timeoutMs: 30000,       // 30 seconds
    maxRetries: 3,          // retry up to 3 times
    retryDelayMs: 1000,     // start with 1 second delay
    retryBackoffMultiplier: 2, // double delay each retry
    cacheTtlSeconds: 300,   // cache results for 5 minutes
    rateLimit: {
      maxRequests: 100,
      windowMs: 60000,      // 100 requests per minute
    },
  },
};

// ── Skill Implementation ──────────────────────────────────────────────────────

export class ${className} extends BaseSkill<${toPascalCase(config.id)}Input, ${toPascalCase(config.id)}Output> {
  readonly definition = ${toCamelCase(config.id)}Definition;

  protected async executeImpl(
    input: ${toPascalCase(config.id)}Input,
    context: ExecutionContext,
  ): Promise<${toPascalCase(config.id)}Output> {
    this.logger.info(
      { executionId: context.executionId },
      'Executing ${config.name}',
    );

    try {
      // ── TODO: Implement your skill logic here ───────────────────────────────
      //
      // Tips:
      //   - Call this.trackApiCall() before each external API/network call
      //   - Throw SkillExecutionError with retryable=true for transient errors
      //   - Throw SkillExecutionError with retryable=false for permanent errors
      //   - Use this.logger for structured logging (never console.log)
      //
      // Example:
      //   this.trackApiCall();
      //   const response = await someApiCall(input.exampleField);
      //   if (!response.ok) {
      //     throw new SkillExecutionError('API call failed', 'API_ERROR', true);
      //   }
      // ───────────────────────────────────────────────────────────────────────

      const result = \`Processed: \${input.exampleField}\`;

      return {
        result,
        processedAt: new Date().toISOString(),
        metadata: { inputLength: input.exampleField.length },
      };

    } catch (err) {
      if (err instanceof SkillExecutionError) throw err;

      throw new SkillExecutionError(
        \`${config.name} failed: \${(err as Error).message}\`,
        '${constPrefix}_ERROR',
        true, // set to false if not retryable
      );
    }
  }

  /**
   * Health check — verify all dependencies are reachable.
   * Override this with real dependency checks (DB ping, API status, etc.)
   */
  override async healthCheck(): Promise<SkillHealthStatus> {
    const start = Date.now();

    // TODO: Add your dependency health checks here
    // Example:
    //   const response = await fetch('https://api.example.com/health');
    //   const healthy = response.ok;

    return {
      healthy: true,
      latencyMs: Date.now() - start,
      details: {
        skillId: this.definition.id,
        version: this.definition.version,
        // TODO: Add dependency status details
      },
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Clean up resources — override if your skill holds connections,
   * browser instances, database connections, etc.
   */
  override async cleanup(): Promise<void> {
    // TODO: Close any open connections or resources
    this.logger.info({ skillId: this.definition.id }, 'Skill cleaned up');
  }
}

// Singleton instance — import this in your agent setup
export const ${instanceName} = new ${className}();
`;
}

function generateTestTemplate(config: SkillConfig): string {
  const className = toPascalCase(config.id) + 'Skill';
  const snakeId = toSnakeCase(config.id);

  return `/**
 * @file tests/unit/${snakeId}.test.ts
 * @description Unit tests for ${config.name}.
 *
 * Generated by: npm run skill:create
 * Add tests covering: positive cases, edge cases, failure cases, input validation.
 */

import { ${className} } from '../../src/skills/${snakeId}';
import { createMockContext } from '../mocks';

describe('${className}', () => {
  let skill: ${className};
  const ctx = createMockContext();

  beforeEach(() => {
    skill = new ${className}();
  });

  // ── Input Validation ──────────────────────────────────────────────────────

  describe('input validation', () => {
    it('accepts valid input', () => {
      const parse = skill.definition.inputSchema.safeParse({
        exampleField: 'test value',
      });
      expect(parse.success).toBe(true);
    });

    it('rejects empty exampleField', () => {
      const parse = skill.definition.inputSchema.safeParse({
        exampleField: '',
      });
      expect(parse.success).toBe(false);
    });

    it('rejects missing required fields', () => {
      const parse = skill.definition.inputSchema.safeParse({});
      expect(parse.success).toBe(false);
    });
  });

  // ── Positive Cases ────────────────────────────────────────────────────────

  describe('successful execution', () => {
    it('returns success result for valid input', async () => {
      const result = await skill.execute(
        { exampleField: 'test' },
        ctx,
      );

      // TODO: Replace with real assertions based on your implementation
      expect(result.result).toContain('test');
      expect(result.processedAt).toMatch(/^\\d{4}-\\d{2}-\\d{2}T/);
    });
  });

  // ── Edge Cases ────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles minimum valid input length', async () => {
      const result = await skill.execute({ exampleField: 'a' }, ctx);
      expect(result).toBeDefined();
    });

    // TODO: Add more edge case tests
  });

  // ── Health Check ──────────────────────────────────────────────────────────

  describe('health check', () => {
    it('returns healthy status', async () => {
      const status = await skill.healthCheck();
      expect(status.healthy).toBe(true);
      expect(status.latencyMs).toBeGreaterThanOrEqual(0);
      expect(status.checkedAt).toBeDefined();
    });
  });

  // ── Skill Definition ──────────────────────────────────────────────────────

  describe('skill definition', () => {
    it('has correct id', () => {
      expect(skill.definition.id).toBe('${config.id}');
    });

    it('has correct category', () => {
      expect(skill.definition.category).toBe('${config.category}');
    });

    it('has valid config', () => {
      expect(skill.definition.config.timeoutMs).toBeGreaterThan(0);
      expect(skill.definition.config.maxRetries).toBeGreaterThanOrEqual(0);
    });
  });
});
`;
}

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const argMap: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (args[i]?.startsWith('--')) {
      argMap[args[i]!.slice(2)] = args[i + 1] ?? '';
    }
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n🚀  Agent Skill Scaffolder\n');

  const id = argMap['id'] ?? await prompt(rl, '  Skill ID (kebab-case, e.g. my-custom-skill): ');
  const name = argMap['name'] ?? await prompt(rl, `  Display name (e.g. My Custom Skill): `);
  const description = argMap['description'] ?? await prompt(rl, `  Description: `);
  console.log(`  Category: ${CATEGORIES.join(', ')}`);
  const category = argMap['category'] ?? await prompt(rl, `  Category [custom]: `) || 'custom';

  rl.close();

  const config: SkillConfig = { id, name, description, category };

  // Create skill directory and files
  const snakeId = toSnakeCase(id);
  const skillDir = path.join(process.cwd(), 'src', 'skills', snakeId);
  const testDir = path.join(process.cwd(), 'tests', 'unit');

  if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });

  const skillPath = path.join(skillDir, 'index.ts');
  const testPath = path.join(testDir, `${snakeId}.test.ts`);

  fs.writeFileSync(skillPath, generateSkillTemplate(config));
  fs.writeFileSync(testPath, generateTestTemplate(config));

  console.log('\n✅  Skill scaffolded successfully!\n');
  console.log(`   Skill:  ${skillPath}`);
  console.log(`   Tests:  ${testPath}`);
  console.log('\n   Next steps:');
  console.log(`   1. Implement executeImpl() in ${skillPath}`);
  console.log(`   2. Run tests: npm run test:unit -- --testPathPattern=${snakeId}`);
  console.log(`   3. Register in src/index.ts`);
  console.log(`   4. Import and add to your agent: agent.registry.register(${toCamelCase(id)}Skill)\n`);
}

main().catch(console.error);
