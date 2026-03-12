/**
 * @module core/registry
 * @description In-memory skill registry with category indexing and hot-reload support.
 */

import {
  ISkill,
  ISkillRegistry,
  SkillDefinition,
  SkillCategory,
} from './types';
import { Logger } from '../monitoring/logger';

export class SkillRegistry implements ISkillRegistry {
  private readonly skills = new Map<string, ISkill<unknown, unknown>>();
  private readonly categoryIndex = new Map<SkillCategory, Set<string>>();
  private readonly logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger ?? new Logger({ name: 'SkillRegistry' });
  }

  register<TInput, TOutput>(skill: ISkill<TInput, TOutput>): void {
    const { id, category, version } = skill.definition;

    if (this.skills.has(id)) {
      this.logger.warn({ skillId: id }, 'Overwriting existing skill registration');
    }

    this.skills.set(id, skill as ISkill<unknown, unknown>);

    if (!this.categoryIndex.has(category)) {
      this.categoryIndex.set(category, new Set());
    }
    this.categoryIndex.get(category)!.add(id);

    this.logger.info({ skillId: id, version, category }, 'Skill registered');
  }

  get<TInput, TOutput>(skillId: string): ISkill<TInput, TOutput> | undefined {
    return this.skills.get(skillId) as ISkill<TInput, TOutput> | undefined;
  }

  list(): SkillDefinition[] {
    return Array.from(this.skills.values()).map((s) => s.definition);
  }

  listByCategory(category: SkillCategory): SkillDefinition[] {
    const ids = this.categoryIndex.get(category) ?? new Set();
    return Array.from(ids)
      .map((id) => this.skills.get(id)?.definition)
      .filter((d): d is SkillDefinition => d !== undefined);
  }

  has(skillId: string): boolean {
    return this.skills.has(skillId);
  }

  remove(skillId: string): boolean {
    const skill = this.skills.get(skillId);
    if (!skill) return false;

    this.skills.delete(skillId);
    this.categoryIndex.get(skill.definition.category)?.delete(skillId);
    this.logger.info({ skillId }, 'Skill removed from registry');
    return true;
  }

  /** Run health checks on all registered skills in parallel */
  async healthCheckAll(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    await Promise.allSettled(
      Array.from(this.skills.entries()).map(async ([id, skill]) => {
        try {
          const status = await skill.healthCheck();
          results[id] = status.healthy;
        } catch {
          results[id] = false;
        }
      }),
    );
    return results;
  }
}
