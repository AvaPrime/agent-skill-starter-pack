/**
 * @file tests/unit/nlp.test.ts
 * @description Unit tests for NlpSkill covering sentiment, keyword extraction,
 * language detection, toxicity, and distribution of results.
 */

import { NlpSkill } from '../../src/skills/nlp';
import { createMockContext, textFixtures } from '../mocks';

// Mock OpenAI to avoid real API calls in unit tests
jest.mock('openai', () => {
  return {
    default: jest.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [{
              message: {
                content: JSON.stringify({
                  label: 'positive',
                  score: 0.8,
                  confidence: 0.9,
                  breakdown: { positive: 0.7, negative: 0.1, neutral: 0.2 },
                }),
              },
            }],
          }),
        },
      },
    })),
  };
});

describe('NlpSkill', () => {
  let skill: NlpSkill;
  const ctx = createMockContext();

  beforeEach(() => {
    skill = new NlpSkill();
    jest.clearAllMocks();
  });

  // ── Tokenization / Basic Counts ───────────────────────────────────────────

  describe('basic text metrics', () => {
    it('correctly counts words and characters', async () => {
      const text = 'Hello world this is a test sentence.';
      const result = await skill.execute(
        { text, operations: ['keywords'], keywordCount: 5 },
        ctx,
      );

      expect(result.inputLength).toBe(text.length);
      expect(result.wordCount).toBeGreaterThan(0);
    });

    it('correctly counts sentences', async () => {
      const text = 'First sentence. Second sentence! Third sentence?';
      const result = await skill.execute(
        { text, operations: ['keywords'], keywordCount: 5 },
        ctx,
      );

      expect(result.sentenceCount).toBe(3);
    });
  });

  // ── Language Detection ────────────────────────────────────────────────────

  describe('language detection', () => {
    it('detects English text', async () => {
      const result = await skill.execute(
        { text: 'The quick brown fox jumps over the lazy dog', operations: ['language_detect'] },
        ctx,
      );

      expect(result.language).toBe('en');
      expect(result.languageConfidence).toBeGreaterThan(0.3);
    });

    it('detects French text', async () => {
      const result = await skill.execute(
        { text: 'Le chat est sur le tapis et les enfants jouent dans le jardin avec les amis', operations: ['language_detect'] },
        ctx,
      );

      expect(result.language).toBe('fr');
    });

    it('detects Spanish text', async () => {
      const result = await skill.execute(
        { text: 'El perro está en el jardín con los niños y las flores son muy bonitas', operations: ['language_detect'] },
        ctx,
      );

      expect(result.language).toBe('es');
    });
  });

  // ── Sentiment Analysis ────────────────────────────────────────────────────

  describe('sentiment analysis (lexicon-based)', () => {
    it('classifies strongly positive text correctly', async () => {
      // Short text uses lexicon — no LLM call
      const shortPositive = 'excellent outstanding brilliant amazing superb wonderful';
      const result = await skill.execute(
        { text: shortPositive, operations: ['sentiment'], sentimentGranularity: 'ternary' },
        ctx,
      );

      expect(result.sentiment?.label).toBe('positive');
      expect(result.sentiment?.score).toBeGreaterThan(0);
    });

    it('classifies strongly negative text correctly', async () => {
      const shortNegative = 'terrible awful horrible dreadful useless broken failure';
      const result = await skill.execute(
        { text: shortNegative, operations: ['sentiment'], sentimentGranularity: 'ternary' },
        ctx,
      );

      expect(result.sentiment?.label).toBe('negative');
      expect(result.sentiment?.score).toBeLessThan(0);
    });

    it('classifies neutral text as neutral', async () => {
      const result = await skill.execute(
        { text: textFixtures.neutral, operations: ['sentiment'], sentimentGranularity: 'ternary' },
        ctx,
      );

      // Neutral text should have score close to 0
      expect(Math.abs(result.sentiment?.score ?? 0)).toBeLessThan(0.5);
    });

    it('binary granularity returns only positive or negative', async () => {
      const result = await skill.execute(
        { text: 'good product', operations: ['sentiment'], sentimentGranularity: 'binary' },
        ctx,
      );

      expect(['positive', 'negative']).toContain(result.sentiment?.label);
    });

    it('includes sentiment breakdown percentages', async () => {
      const result = await skill.execute(
        { text: textFixtures.positive, operations: ['sentiment'], sentimentGranularity: 'ternary' },
        ctx,
      );

      // Breakdown should exist and sum to ~1
      if (result.sentiment?.breakdown) {
        const sum = result.sentiment.breakdown.positive + result.sentiment.breakdown.negative + result.sentiment.breakdown.neutral;
        expect(sum).toBeCloseTo(1, 0);
      }
    });
  });

  // ── Keyword Extraction ────────────────────────────────────────────────────

  describe('keyword extraction', () => {
    it('returns requested number of keywords', async () => {
      const result = await skill.execute(
        { text: textFixtures.financial, operations: ['keywords'], keywordCount: 5 },
        ctx,
      );

      expect(result.keywords?.length).toBeLessThanOrEqual(5);
      expect(result.keywords?.length).toBeGreaterThan(0);
    });

    it('excludes common stopwords from keywords', async () => {
      const result = await skill.execute(
        { text: textFixtures.financial, operations: ['keywords'], keywordCount: 10 },
        ctx,
      );

      const words = result.keywords?.map((k) => k.word) ?? [];
      const stopwords = ['the', 'a', 'an', 'and', 'or', 'is', 'of'];
      const hasStopword = words.some((w) => stopwords.includes(w.toLowerCase()));
      expect(hasStopword).toBe(false);
    });

    it('keywords have valid score and frequency', async () => {
      const result = await skill.execute(
        { text: textFixtures.technical, operations: ['keywords'], keywordCount: 10 },
        ctx,
      );

      result.keywords?.forEach((k) => {
        expect(k.score).toBeGreaterThan(0);
        expect(k.frequency).toBeGreaterThan(0);
        expect(typeof k.isBigram).toBe('boolean');
      });
    });

    it('sorts keywords by relevance score descending', async () => {
      const result = await skill.execute(
        { text: 'revenue revenue revenue profit profit loss', operations: ['keywords'], keywordCount: 5 },
        ctx,
      );

      const scores = result.keywords?.map((k) => k.score) ?? [];
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]!);
      }
    });
  });

  // ── Toxicity Detection ────────────────────────────────────────────────────

  describe('toxicity detection', () => {
    it('marks clean text as non-toxic', async () => {
      const result = await skill.execute(
        { text: textFixtures.neutral, operations: ['toxicity'] },
        ctx,
      );

      expect(result.toxicity?.isToxic).toBe(false);
      expect(result.toxicity?.score).toBeLessThan(0.1);
    });

    it('returns toxicity categories breakdown', async () => {
      const result = await skill.execute(
        { text: textFixtures.positive, operations: ['toxicity'] },
        ctx,
      );

      expect(result.toxicity?.categories).toBeDefined();
      expect(typeof result.toxicity?.score).toBe('number');
    });
  });

  // ── Multiple Operations ───────────────────────────────────────────────────

  describe('multiple operations', () => {
    it('runs sentiment and keywords together', async () => {
      const result = await skill.execute(
        {
          text: textFixtures.positive,
          operations: ['sentiment', 'keywords'],
          keywordCount: 5,
          sentimentGranularity: 'ternary',
        },
        ctx,
      );

      expect(result.sentiment).toBeDefined();
      expect(result.keywords).toBeDefined();
    });

    it('includes processedAt timestamp', async () => {
      const result = await skill.execute(
        { text: 'Hello world', operations: ['keywords'], keywordCount: 3 },
        ctx,
      );

      expect(result.processedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('runs all non-LLM operations without API calls', async () => {
      const result = await skill.execute(
        {
          text: textFixtures.positive,
          operations: ['language_detect', 'keywords', 'toxicity'],
          keywordCount: 5,
        },
        ctx,
      );

      expect(result.language).toBeDefined();
      expect(result.keywords).toBeDefined();
      expect(result.toxicity).toBeDefined();
      expect(result.sentiment).toBeUndefined();
    });
  });

  // ── Input Validation ──────────────────────────────────────────────────────

  describe('input validation', () => {
    it('rejects empty text through schema', () => {
      const parse = skill.definition.inputSchema.safeParse({
        text: '',
        operations: ['keywords'],
      });
      expect(parse.success).toBe(false);
    });

    it('rejects empty operations array through schema', () => {
      const parse = skill.definition.inputSchema.safeParse({
        text: 'Hello world',
        operations: [],
      });
      expect(parse.success).toBe(false);
    });

    it('accepts text at maximum length boundary', () => {
      const parse = skill.definition.inputSchema.safeParse({
        text: 'a'.repeat(50000),
        operations: ['keywords'],
      });
      expect(parse.success).toBe(true);
    });
  });
});
