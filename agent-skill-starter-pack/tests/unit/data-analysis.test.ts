/**
 * @file tests/unit/data-analysis.test.ts
 * @description Unit tests for DataAnalysisSkill covering stats accuracy,
 * edge cases, outlier detection, and trend computation.
 */

import { DataAnalysisSkill } from '../../src/skills/data_analysis';
import { createMockContext, salesData } from '../mocks';

describe('DataAnalysisSkill', () => {
  let skill: DataAnalysisSkill;
  const ctx = createMockContext();

  beforeEach(() => {
    skill = new DataAnalysisSkill();
  });

  // ── Descriptive Statistics ────────────────────────────────────────────────

  describe('descriptive statistics', () => {
    it('computes correct mean for simple dataset', async () => {
      const data = [
        { value: 10 },
        { value: 20 },
        { value: 30 },
      ];

      const result = await skill.execute(
        { data, targetColumn: 'value', analyses: ['descriptive'] },
        ctx,
      );

      expect(result.descriptive?.mean).toBe(20);
      expect(result.descriptive?.min).toBe(10);
      expect(result.descriptive?.max).toBe(30);
      expect(result.descriptive?.count).toBe(3);
    });

    it('computes correct median for even-length dataset', async () => {
      const data = [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }];

      const result = await skill.execute(
        { data, targetColumn: 'v', analyses: ['descriptive'] },
        ctx,
      );

      expect(result.descriptive?.median).toBe(2.5);
    });

    it('correctly counts missing values', async () => {
      const data = [
        { value: 10 },
        { value: null },
        { value: 20 },
        { value: undefined },
        { value: 30 },
      ] as Record<string, unknown>[];

      const result = await skill.execute(
        { data, targetColumn: 'value', analyses: ['descriptive'] },
        ctx,
      );

      expect(result.descriptive?.count).toBe(3);
      expect(result.descriptive?.missingValues).toBe(2);
      expect(result.descriptive?.missingPct).toBeCloseTo(40, 0);
    });

    it('computes correct standard deviation', async () => {
      const data = [2, 4, 4, 4, 5, 5, 7, 9].map((v) => ({ v }));

      const result = await skill.execute(
        { data, targetColumn: 'v', analyses: ['descriptive'] },
        ctx,
      );

      // Population stdDev ≈ 2.0
      expect(result.descriptive?.stdDev).toBeCloseTo(2.0, 0);
    });

    it('computes sales data descriptive stats correctly', async () => {
      const result = await skill.execute(
        { data: salesData, targetColumn: 'revenue', analyses: ['descriptive'] },
        ctx,
      );

      expect(result.descriptive?.count).toBe(13);
      expect(result.descriptive?.min).toBe(500);
      expect(result.descriptive?.max).toBe(42000);
      expect(result.descriptive?.sum).toBeGreaterThan(0);
    });
  });

  // ── Outlier Detection ─────────────────────────────────────────────────────

  describe('outlier detection', () => {
    it('detects outlier with IQR method', async () => {
      const data = [
        ...Array.from({ length: 10 }, (_, i) => ({ v: 100 + i })),
        { v: 1000 }, // clear outlier
      ];

      const result = await skill.execute(
        { data, targetColumn: 'v', analyses: ['outliers'], outlierMethod: 'iqr' },
        ctx,
      );

      expect(result.outliers?.count).toBeGreaterThanOrEqual(1);
      expect(result.outliers?.values).toContain(1000);
    });

    it('detects outlier with Z-score method', async () => {
      const data = [
        ...Array.from({ length: 20 }, () => ({ v: 50 })),
        { v: 500 }, // 10+ standard deviations away
      ];

      const result = await skill.execute(
        { data, targetColumn: 'v', analyses: ['outliers'], outlierMethod: 'zscore', zscoreThreshold: 3 },
        ctx,
      );

      expect(result.outliers?.count).toBeGreaterThanOrEqual(1);
    });

    it('returns no outliers for uniform distribution', async () => {
      const data = Array.from({ length: 20 }, (_, i) => ({ v: i + 1 }));

      const result = await skill.execute(
        { data, targetColumn: 'v', analyses: ['outliers'], outlierMethod: 'zscore' },
        ctx,
      );

      expect(result.outliers?.count).toBe(0);
    });

    it('detects 500 revenue as outlier in sales data', async () => {
      const result = await skill.execute(
        { data: salesData, targetColumn: 'revenue', analyses: ['outliers'], outlierMethod: 'iqr' },
        ctx,
      );

      expect(result.outliers?.values).toContain(500);
    });
  });

  // ── Trend Analysis ────────────────────────────────────────────────────────

  describe('trend analysis', () => {
    it('detects increasing trend', async () => {
      const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => ({ v }));

      const result = await skill.execute(
        { data, targetColumn: 'v', analyses: ['trend'] },
        ctx,
      );

      expect(result.trend?.direction).toBe('increasing');
      expect(result.trend?.slope).toBeGreaterThan(0);
      expect(result.trend?.rSquared).toBeCloseTo(1, 1);
    });

    it('detects decreasing trend', async () => {
      const data = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((v) => ({ v }));

      const result = await skill.execute(
        { data, targetColumn: 'v', analyses: ['trend'] },
        ctx,
      );

      expect(result.trend?.direction).toBe('decreasing');
      expect(result.trend?.slope).toBeLessThan(0);
    });

    it('detects stable trend for flat data', async () => {
      const data = Array.from({ length: 10 }, () => ({ v: 100 }));

      const result = await skill.execute(
        { data, targetColumn: 'v', analyses: ['trend'] },
        ctx,
      );

      expect(result.trend?.direction).toBe('stable');
    });

    it('detects increasing trend in sales data', async () => {
      // Exclude the outlier
      const trendData = salesData.filter((d) => d.revenue > 1000);

      const result = await skill.execute(
        { data: trendData, targetColumn: 'revenue', analyses: ['trend'] },
        ctx,
      );

      expect(result.trend?.direction).toBe('increasing');
    });
  });

  // ── Correlation ───────────────────────────────────────────────────────────

  describe('correlation analysis', () => {
    it('computes perfect positive correlation', async () => {
      const data = [
        { x: 1, y: 2 }, { x: 2, y: 4 }, { x: 3, y: 6 },
        { x: 4, y: 8 }, { x: 5, y: 10 },
      ];

      const result = await skill.execute(
        { data, targetColumn: 'x', analyses: ['correlation'], correlationColumns: ['y'] },
        ctx,
      );

      expect(result.correlations?.y).toBeCloseTo(1.0, 2);
    });

    it('computes perfect negative correlation', async () => {
      const data = [
        { x: 1, y: 10 }, { x: 2, y: 8 }, { x: 3, y: 6 },
        { x: 4, y: 4 }, { x: 5, y: 2 },
      ];

      const result = await skill.execute(
        { data, targetColumn: 'x', analyses: ['correlation'], correlationColumns: ['y'] },
        ctx,
      );

      expect(result.correlations?.y).toBeCloseTo(-1.0, 2);
    });

    it('computes correlation between revenue and units in sales data', async () => {
      const result = await skill.execute(
        { data: salesData, targetColumn: 'revenue', analyses: ['correlation'], correlationColumns: ['units'] },
        ctx,
      );

      // Revenue and units should be positively correlated
      expect(result.correlations?.units).toBeGreaterThan(0.8);
    });
  });

  // ── Grouped Stats ─────────────────────────────────────────────────────────

  describe('grouped statistics', () => {
    it('computes stats per group', async () => {
      const result = await skill.execute(
        {
          data: salesData,
          targetColumn: 'revenue',
          analyses: ['descriptive'],
          groupByColumn: 'region',
        },
        ctx,
      );

      expect(result.groupedStats).toBeDefined();
      expect(Object.keys(result.groupedStats!)).toContain('North');
      expect(Object.keys(result.groupedStats!)).toContain('South');
    });
  });

  // ── Distribution ──────────────────────────────────────────────────────────

  describe('distribution analysis', () => {
    it('produces histogram with correct bucket structure', async () => {
      const data = Array.from({ length: 100 }, (_, i) => ({ v: i }));

      const result = await skill.execute(
        { data, targetColumn: 'v', analyses: ['distribution'] },
        ctx,
      );

      expect(result.distribution?.histogram.length).toBeGreaterThan(0);
      const totalPct = result.distribution!.histogram.reduce((s, b) => s + b.pct, 0);
      expect(totalPct).toBeCloseTo(100, 0);
    });

    it('identifies near-normal distribution', async () => {
      // Generate roughly normal-ish data
      const data = [
        ...Array(30).fill({ v: 50 }),
        ...Array(20).fill({ v: 45 }),
        ...Array(20).fill({ v: 55 }),
        ...Array(10).fill({ v: 40 }),
        ...Array(10).fill({ v: 60 }),
        ...Array(5).fill({ v: 35 }),
        ...Array(5).fill({ v: 65 }),
      ] as Record<string, unknown>[];

      const result = await skill.execute(
        { data, targetColumn: 'v', analyses: ['distribution'] },
        ctx,
      );

      expect(result.distribution?.isNormal).toBeDefined();
    });
  });

  // ── Error Cases ───────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('throws error for column with no numeric values', async () => {
      const data = [{ name: 'Alice' }, { name: 'Bob' }];

      await expect(
        skill.execute({ data, targetColumn: 'name', analyses: ['descriptive'] }, ctx),
      ).rejects.toThrow('No numeric values');
    });

    it('handles empty dataset gracefully through schema validation', async () => {
      const parseResult = skill.definition.inputSchema.safeParse({
        data: [],
        targetColumn: 'value',
        analyses: ['descriptive'],
      });

      expect(parseResult.success).toBe(false);
    });
  });

  // ── Multiple Operations ───────────────────────────────────────────────────

  describe('multiple operations', () => {
    it('runs all analysis types simultaneously', async () => {
      const result = await skill.execute(
        {
          data: salesData,
          targetColumn: 'revenue',
          analyses: ['descriptive', 'outliers', 'trend', 'distribution'],
          correlationColumns: ['units'],
        },
        ctx,
      );

      expect(result.descriptive).toBeDefined();
      expect(result.outliers).toBeDefined();
      expect(result.trend).toBeDefined();
      expect(result.distribution).toBeDefined();
      expect(result.rowCount).toBe(salesData.length);
    });

    it('includes timing information', async () => {
      const result = await skill.execute(
        { data: salesData, targetColumn: 'revenue', analyses: ['descriptive'] },
        ctx,
      );

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.analysedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});
