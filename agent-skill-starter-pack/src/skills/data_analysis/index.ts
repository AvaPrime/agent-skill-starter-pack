/**
 * @module skills/data-analysis
 * @description Statistical data analysis skill.
 * Performs descriptive statistics, correlation, outlier detection,
 * trend analysis, and LLM-powered narrative insight generation.
 *
 * @example
 * ```ts
 * const result = await executor.run(dataAnalysisSkill, {
 *   data: [{ revenue: 1200, month: 'Jan' }, ...],
 *   targetColumn: 'revenue',
 *   analyses: ['descriptive', 'outliers', 'trend', 'insights'],
 * }, taskId);
 * ```
 */

import { z } from 'zod';
import { BaseSkill } from '../../core/base-skill';
import { SkillDefinition, ExecutionContext } from '../../core/types';
import { SkillExecutionError } from '../../core/executor';
import { getSecret } from '../../config';

// ── Input Schema ──────────────────────────────────────────────────────────────

export const DataAnalysisInputSchema = z.object({
  /** Array of data records (JSON objects) */
  data: z.array(z.record(z.unknown())).min(1).max(100000),
  /** Column to use as the primary analysis target */
  targetColumn: z.string(),
  /** Optional grouping column for segmented analysis */
  groupByColumn: z.string().optional(),
  /** Which analyses to run */
  analyses: z
    .array(z.enum(['descriptive', 'correlation', 'outliers', 'trend', 'distribution', 'insights']))
    .min(1),
  /** Columns to include in correlation analysis */
  correlationColumns: z.array(z.string()).optional(),
  /** Outlier detection method */
  outlierMethod: z.enum(['zscore', 'iqr']).default('iqr'),
  /** Z-score threshold for outlier detection (when method=zscore) */
  zscoreThreshold: z.number().default(3),
  /** LLM model for insights generation */
  insightsModel: z.string().default('gpt-4o-mini'),
  /** Custom prompt context for insights */
  insightsContext: z.string().optional(),
  /** Output format for insights */
  insightsFormat: z.enum(['bullet_points', 'narrative', 'structured']).default('bullet_points'),
});

export type DataAnalysisInput = z.infer<typeof DataAnalysisInputSchema>;

// ── Output Schema ─────────────────────────────────────────────────────────────

const DescriptiveStatsSchema = z.object({
  count: z.number(),
  mean: z.number(),
  median: z.number(),
  mode: z.number().optional(),
  stdDev: z.number(),
  variance: z.number(),
  min: z.number(),
  max: z.number(),
  range: z.number(),
  q1: z.number(),
  q3: z.number(),
  iqr: z.number(),
  skewness: z.number(),
  kurtosis: z.number(),
  sum: z.number(),
  missingValues: z.number(),
  missingPct: z.number(),
});

export const DataAnalysisOutputSchema = z.object({
  targetColumn: z.string(),
  rowCount: z.number(),
  descriptive: DescriptiveStatsSchema.optional(),
  correlations: z.record(z.number()).optional(),
  outliers: z
    .object({
      method: z.string(),
      count: z.number(),
      indices: z.array(z.number()),
      values: z.array(z.number()),
      threshold: z.number(),
    })
    .optional(),
  trend: z
    .object({
      direction: z.enum(['increasing', 'decreasing', 'stable', 'volatile']),
      slope: z.number(),
      rSquared: z.number(),
      periods: z.number(),
    })
    .optional(),
  distribution: z
    .object({
      histogram: z.array(z.object({ bucket: z.string(), count: z.number(), pct: z.number() })),
      isNormal: z.boolean(),
      shapiroWilkStatistic: z.number().optional(),
    })
    .optional(),
  groupedStats: z.record(DescriptiveStatsSchema).optional(),
  insights: z.string().optional(),
  analysedAt: z.string(),
  durationMs: z.number(),
});

export type DataAnalysisOutput = z.infer<typeof DataAnalysisOutputSchema>;

// ── Skill Definition ──────────────────────────────────────────────────────────

export const dataAnalysisDefinition: SkillDefinition<DataAnalysisInput, DataAnalysisOutput> = {
  id: 'data-analysis',
  name: 'Data Analysis',
  version: '1.0.0',
  description:
    'Statistical analysis of structured data: descriptive stats, correlation, outlier detection, trend analysis, and LLM-powered insights.',
  inputSchema: DataAnalysisInputSchema,
  outputSchema: DataAnalysisOutputSchema,
  category: 'data-analysis',
  tags: ['statistics', 'analytics', 'data', 'insights', 'ml'],
  supportsStreaming: false,
  maxConcurrency: 10,
  config: {
    timeoutMs: 60000,
    maxRetries: 2,
    retryDelayMs: 1000,
    retryBackoffMultiplier: 2,
    cacheTtlSeconds: 600,
  },
};

// ── Skill Implementation ──────────────────────────────────────────────────────

export class DataAnalysisSkill extends BaseSkill<DataAnalysisInput, DataAnalysisOutput> {
  readonly definition = dataAnalysisDefinition;

  protected async executeImpl(
    input: DataAnalysisInput,
    context: ExecutionContext,
  ): Promise<DataAnalysisOutput> {
    const start = Date.now();
    this.logger.info(
      {
        targetColumn: input.targetColumn,
        rowCount: input.data.length,
        executionId: context.executionId,
      },
      'Starting data analysis',
    );

    // Extract numeric values for the target column
    const values = this.extractNumericValues(input.data, input.targetColumn);
    if (values.length === 0) {
      throw new SkillExecutionError(
        `No numeric values found in column "${input.targetColumn}"`,
        'INVALID_COLUMN',
        false,
      );
    }

    const output: DataAnalysisOutput = {
      targetColumn: input.targetColumn,
      rowCount: input.data.length,
      analysedAt: new Date().toISOString(),
      durationMs: 0,
    };

    // Run requested analyses
    const analyses = new Set(input.analyses);

    if (analyses.has('descriptive')) {
      output.descriptive = this.computeDescriptiveStats(values, input.data.length);
    }

    if (analyses.has('correlation') && input.correlationColumns?.length) {
      output.correlations = this.computeCorrelations(
        input.data,
        input.targetColumn,
        input.correlationColumns,
      );
    }

    if (analyses.has('outliers')) {
      output.outliers = this.detectOutliers(values, input.outlierMethod, input.zscoreThreshold);
    }

    if (analyses.has('trend')) {
      output.trend = this.computeTrend(values);
    }

    if (analyses.has('distribution')) {
      output.distribution = this.computeDistribution(values);
    }

    if (input.groupByColumn) {
      output.groupedStats = this.computeGroupedStats(
        input.data,
        input.targetColumn,
        input.groupByColumn,
      );
    }

    if (analyses.has('insights')) {
      output.insights = await this.generateInsights(input, output);
    }

    output.durationMs = Date.now() - start;
    return output;
  }

  // ── Statistical Methods ───────────────────────────────────────────────────

  private extractNumericValues(data: Record<string, unknown>[], column: string): number[] {
    return data
      .map((row) => row[column])
      .filter((v): v is number => typeof v === 'number' && !isNaN(v));
  }

  private computeDescriptiveStats(
    values: number[],
    totalRows: number,
  ): z.infer<typeof DescriptiveStatsSchema> {
    const sorted = [...values].sort((a, b) => a - b);
    const n = values.length;

    const mean = values.reduce((s, v) => s + v, 0) / n;
    const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / n;
    const stdDev = Math.sqrt(variance);

    const q1 = this.percentile(sorted, 25);
    const median = this.percentile(sorted, 50);
    const q3 = this.percentile(sorted, 75);

    // Skewness (Pearson's moment)
    const skewness =
      n > 2 ? values.reduce((s, v) => s + Math.pow((v - mean) / (stdDev || 1), 3), 0) / n : 0;

    // Excess kurtosis
    const kurtosis =
      n > 3 ? values.reduce((s, v) => s + Math.pow((v - mean) / (stdDev || 1), 4), 0) / n - 3 : 0;

    // Mode (most frequent value, rounded to 2 dp)
    const freq = new Map<number, number>();
    for (const v of values) {
      const k = Math.round(v * 100) / 100;
      freq.set(k, (freq.get(k) ?? 0) + 1);
    }
    const mode = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

    return {
      count: n,
      mean,
      median,
      mode,
      stdDev,
      variance,
      min: sorted[0],
      max: sorted[n - 1],
      range: sorted[n - 1] - sorted[0],
      q1,
      q3,
      iqr: q3 - q1,
      skewness,
      kurtosis,
      sum: values.reduce((s, v) => s + v, 0),
      missingValues: totalRows - n,
      missingPct: ((totalRows - n) / totalRows) * 100,
    };
  }

  private computeCorrelations(
    data: Record<string, unknown>[],
    target: string,
    columns: string[],
  ): Record<string, number> {
    const targetValues = this.extractNumericValues(data, target);
    const result: Record<string, number> = {};

    for (const col of columns) {
      if (col === target) continue;
      const colValues = this.extractNumericValues(data, col);
      if (colValues.length >= 2 && targetValues.length >= 2) {
        result[col] = this.pearsonCorrelation(
          targetValues.slice(0, Math.min(targetValues.length, colValues.length)),
          colValues.slice(0, Math.min(targetValues.length, colValues.length)),
        );
      }
    }

    return result;
  }

  private pearsonCorrelation(x: number[], y: number[]): number {
    const n = x.length;
    const meanX = x.reduce((s, v) => s + v, 0) / n;
    const meanY = y.reduce((s, v) => s + v, 0) / n;
    const num = x.reduce((s, v, i) => s + (v - meanX) * (y[i] - meanY), 0);
    const den = Math.sqrt(
      x.reduce((s, v) => s + Math.pow(v - meanX, 2), 0) *
        y.reduce((s, v) => s + Math.pow(v - meanY, 2), 0),
    );
    return den === 0 ? 0 : num / den;
  }

  private detectOutliers(
    values: number[],
    method: 'zscore' | 'iqr',
    zThreshold: number,
  ): DataAnalysisOutput['outliers'] {
    const outlierIndices: number[] = [];
    const outlierValues: number[] = [];
    let threshold: number;

    if (method === 'zscore') {
      const mean = values.reduce((s, v) => s + v, 0) / values.length;
      const std = Math.sqrt(values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length);
      threshold = zThreshold;

      values.forEach((v, i) => {
        if (Math.abs((v - mean) / (std || 1)) > zThreshold) {
          outlierIndices.push(i);
          outlierValues.push(v);
        }
      });
    } else {
      const sorted = [...values].sort((a, b) => a - b);
      const q1 = this.percentile(sorted, 25);
      const q3 = this.percentile(sorted, 75);
      const iqr = q3 - q1;
      const lower = q1 - 1.5 * iqr;
      const upper = q3 + 1.5 * iqr;
      threshold = 1.5;

      values.forEach((v, i) => {
        if (v < lower || v > upper) {
          outlierIndices.push(i);
          outlierValues.push(v);
        }
      });
    }

    return {
      method,
      count: outlierIndices.length,
      indices: outlierIndices,
      values: outlierValues,
      threshold,
    };
  }

  private computeTrend(values: number[]): DataAnalysisOutput['trend'] {
    const n = values.length;
    const x = Array.from({ length: n }, (_, i) => i);
    const meanX = (n - 1) / 2;
    const meanY = values.reduce((s, v) => s + v, 0) / n;

    const slope =
      x.reduce((s, xi, i) => s + (xi - meanX) * (values[i] - meanY), 0) /
      x.reduce((s, xi) => s + Math.pow(xi - meanX, 2), 0);

    const yHat = x.map((xi) => meanY + slope * (xi - meanX));
    const ssTot = values.reduce((s, v) => s + Math.pow(v - meanY, 2), 0);
    const ssRes = values.reduce((s, v, i) => s + Math.pow(v - yHat[i], 2), 0);
    const rSquared = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

    const cv =
      Math.abs(values.reduce((s, v) => s + Math.pow(v - meanY, 2), 0) / n) / Math.abs(meanY || 1);
    const direction =
      cv > 0.5
        ? 'volatile'
        : Math.abs(slope) < 0.01 * Math.abs(meanY || 1)
          ? 'stable'
          : slope > 0
            ? 'increasing'
            : 'decreasing';

    return { direction, slope, rSquared, periods: n };
  }

  private computeDistribution(values: number[]): DataAnalysisOutput['distribution'] {
    const min = Math.min(...values);
    const max = Math.max(...values);
    const bucketCount = Math.min(20, Math.ceil(Math.sqrt(values.length)));
    const bucketSize = (max - min) / bucketCount || 1;

    const buckets = Array.from({ length: bucketCount }, (_, i) => ({
      lower: min + i * bucketSize,
      upper: min + (i + 1) * bucketSize,
      count: 0,
    }));

    for (const v of values) {
      const idx = Math.min(Math.floor((v - min) / bucketSize), bucketCount - 1);
      buckets[idx].count++;
    }

    const histogram = buckets.map((b) => ({
      bucket: `${b.lower.toFixed(2)}–${b.upper.toFixed(2)}`,
      count: b.count,
      pct: (b.count / values.length) * 100,
    }));

    // Approximate normality: check if |skewness| < 0.5 and |kurtosis| < 1
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const std = Math.sqrt(values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length);
    const skewness =
      values.reduce((s, v) => s + Math.pow((v - mean) / (std || 1), 3), 0) / values.length;
    const kurtosis =
      values.reduce((s, v) => s + Math.pow((v - mean) / (std || 1), 4), 0) / values.length - 3;

    return { histogram, isNormal: Math.abs(skewness) < 0.5 && Math.abs(kurtosis) < 1 };
  }

  private computeGroupedStats(
    data: Record<string, unknown>[],
    targetColumn: string,
    groupColumn: string,
  ): Record<string, z.infer<typeof DescriptiveStatsSchema>> {
    const groups = new Map<string, number[]>();

    for (const row of data) {
      const groupKey = String(row[groupColumn] ?? 'unknown');
      const value = row[targetColumn];
      if (typeof value === 'number' && !isNaN(value)) {
        if (!groups.has(groupKey)) groups.set(groupKey, []);
        groups.get(groupKey)!.push(value);
      }
    }

    const result: Record<string, z.infer<typeof DescriptiveStatsSchema>> = {};
    for (const [key, values] of groups.entries()) {
      result[key] = this.computeDescriptiveStats(values, values.length);
    }
    return result;
  }

  private async generateInsights(
    input: DataAnalysisInput,
    partialOutput: DataAnalysisOutput,
  ): Promise<string> {
    this.trackApiCall();

    try {
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey: getSecret('openaiApiKey') ?? '' });

      const statsJson = JSON.stringify(
        {
          targetColumn: input.targetColumn,
          rowCount: partialOutput.rowCount,
          descriptive: partialOutput.descriptive,
          outliers: partialOutput.outliers,
          trend: partialOutput.trend,
          correlations: partialOutput.correlations,
        },
        null,
        2,
      );

      const formatInstructions = {
        bullet_points: 'Respond with 5–8 concise bullet points.',
        narrative: 'Respond with a 2–3 paragraph narrative analysis.',
        structured:
          'Respond with a JSON object containing keys: summary, key_findings (array), recommendations (array), risks (array).',
      }[input.insightsFormat];

      const response = await client.chat.completions.create({
        model: input.insightsModel,
        messages: [
          {
            role: 'system',
            content: `You are a senior data analyst. Analyze the provided statistics and generate actionable insights. ${input.insightsContext ?? ''} ${formatInstructions}`,
          },
          { role: 'user', content: `Statistics:\n${statsJson}` },
        ],
        max_tokens: 800,
        temperature: 0.3,
      });

      return response.choices[0]?.message?.content ?? 'No insights generated.';
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message },
        'Failed to generate LLM insights — returning stats summary',
      );
      return `Analysis complete. ${partialOutput.descriptive ? `Mean: ${partialOutput.descriptive.mean.toFixed(2)}, StdDev: ${partialOutput.descriptive.stdDev.toFixed(2)}, Outliers: ${partialOutput.outliers?.count ?? 0}` : ''}`;
    }
  }

  private percentile(sorted: number[], p: number): number {
    const idx = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
  }
}

export const dataAnalysisSkill = new DataAnalysisSkill();
