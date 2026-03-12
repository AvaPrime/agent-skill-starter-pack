/**
 * @module skills/nlp
 * @description Natural Language Processing skill.
 * Performs sentiment analysis, named entity recognition, text classification,
 * summarization, keyword extraction, and translation — using both
 * local heuristics and LLM-powered processing.
 *
 * @example
 * ```ts
 * const result = await executor.run(nlpSkill, {
 *   text: 'Apple reported record Q4 revenue of $89.5B...',
 *   operations: ['sentiment', 'entities', 'keywords', 'summary'],
 * }, taskId);
 * ```
 */

import { z } from 'zod';
import { BaseSkill } from '../../core/base-skill';
import { SkillDefinition, ExecutionContext } from '../../core/types';

// ── Input Schema ──────────────────────────────────────────────────────────────

export const NlpInputSchema = z.object({
  /** Text content to process (max 50,000 characters) */
  text: z.string().min(1).max(50000),
  /** NLP operations to perform */
  operations: z.array(
    z.enum(['sentiment', 'entities', 'keywords', 'summary', 'classify', 'language_detect', 'toxicity']),
  ).min(1),
  /** Language hint (ISO 639-1, e.g. 'en', 'fr') */
  language: z.string().default('en'),
  /** LLM model for operations that use an LLM */
  model: z.string().default('gpt-4o-mini'),
  /** Custom categories for classification */
  classificationLabels: z.array(z.string()).optional(),
  /** Target summary length (words) */
  summaryLength: z.number().min(10).max(500).default(100),
  /** Number of keywords to extract */
  keywordCount: z.number().min(1).max(50).default(10),
  /** Sentiment granularity */
  sentimentGranularity: z.enum(['binary', 'ternary', 'fine_grained']).default('ternary'),
});

export type NlpInput = z.infer<typeof NlpInputSchema>;

// ── Output Schema ─────────────────────────────────────────────────────────────

const EntitySchema = z.object({
  text: z.string(),
  type: z.enum(['PERSON', 'ORGANIZATION', 'LOCATION', 'DATE', 'MONEY', 'PERCENT', 'PRODUCT', 'EVENT', 'OTHER']),
  score: z.number().min(0).max(1),
  startIndex: z.number(),
  endIndex: z.number(),
});

const SentimentSchema = z.object({
  label: z.enum(['positive', 'negative', 'neutral', 'very_positive', 'very_negative', 'mixed']),
  score: z.number().min(-1).max(1),
  confidence: z.number().min(0).max(1),
  breakdown: z.object({
    positive: z.number(),
    negative: z.number(),
    neutral: z.number(),
  }).optional(),
});

const KeywordSchema = z.object({
  word: z.string(),
  score: z.number(),
  frequency: z.number(),
  isBigram: z.boolean(),
});

const ClassificationSchema = z.object({
  label: z.string(),
  score: z.number(),
  allLabels: z.array(z.object({ label: z.string(), score: z.number() })),
});

export const NlpOutputSchema = z.object({
  inputLength: z.number(),
  wordCount: z.number(),
  sentenceCount: z.number(),
  language: z.string().optional(),
  languageConfidence: z.number().optional(),
  sentiment: SentimentSchema.optional(),
  entities: z.array(EntitySchema).optional(),
  keywords: z.array(KeywordSchema).optional(),
  summary: z.string().optional(),
  classification: ClassificationSchema.optional(),
  toxicity: z.object({
    isToxic: z.boolean(),
    score: z.number(),
    categories: z.record(z.number()),
  }).optional(),
  processedAt: z.string(),
});

export type NlpOutput = z.infer<typeof NlpOutputSchema>;

// ── Skill Definition ──────────────────────────────────────────────────────────

export const nlpDefinition: SkillDefinition<NlpInput, NlpOutput> = {
  id: 'nlp',
  name: 'Natural Language Processing',
  version: '1.0.0',
  description: 'Sentiment analysis, NER, keyword extraction, summarization, classification, and toxicity detection.',
  inputSchema: NlpInputSchema,
  outputSchema: NlpOutputSchema,
  category: 'nlp',
  tags: ['sentiment', 'ner', 'nlp', 'summarization', 'classification', 'keywords'],
  supportsStreaming: false,
  maxConcurrency: 15,
  config: {
    timeoutMs: 45000,
    maxRetries: 2,
    retryDelayMs: 1000,
    retryBackoffMultiplier: 1.5,
    cacheTtlSeconds: 3600,
    rateLimit: { maxRequests: 30, windowMs: 60000 },
  },
};

// ── Skill Implementation ──────────────────────────────────────────────────────

export class NlpSkill extends BaseSkill<NlpInput, NlpOutput> {
  readonly definition = nlpDefinition;

  // Common English stopwords for keyword extraction
  private static readonly STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'that', 'this', 'these', 'those',
    'it', 'its', 'their', 'our', 'your', 'my', 'his', 'her', 'we', 'they',
    'i', 'you', 'he', 'she', 'not', 'no', 'so', 'if', 'as', 'up', 'out',
  ]);

  // Positive/negative word lexicons (simplified Bing Liu opinion lexicon)
  private static readonly POSITIVE_WORDS = new Set([
    'excellent', 'outstanding', 'great', 'good', 'wonderful', 'fantastic',
    'amazing', 'superb', 'brilliant', 'terrific', 'positive', 'impressive',
    'exceptional', 'remarkable', 'successful', 'perfect', 'best', 'love',
    'enjoy', 'pleased', 'happy', 'satisfied', 'recommend', 'innovative',
    'efficient', 'effective', 'reliable', 'robust', 'strong', 'solid',
  ]);

  private static readonly NEGATIVE_WORDS = new Set([
    'bad', 'terrible', 'awful', 'horrible', 'dreadful', 'poor', 'worst',
    'disappointing', 'inadequate', 'failed', 'broken', 'slow', 'buggy',
    'useless', 'defective', 'subpar', 'mediocre', 'unreliable', 'difficult',
    'problematic', 'frustrating', 'annoying', 'expensive', 'overpriced',
    'crash', 'error', 'issue', 'problem', 'bug', 'failure', 'loss',
  ]);

  protected async executeImpl(
    input: NlpInput,
    context: ExecutionContext,
  ): Promise<NlpOutput> {
    this.logger.info({ operations: input.operations, textLength: input.text.length, executionId: context.executionId }, 'Starting NLP processing');

    const words = this.tokenize(input.text);
    const sentences = this.splitSentences(input.text);
    const ops = new Set(input.operations);

    const output: NlpOutput = {
      inputLength: input.text.length,
      wordCount: words.length,
      sentenceCount: sentences.length,
      processedAt: new Date().toISOString(),
    };

    // Language detection (heuristic)
    if (ops.has('language_detect')) {
      const { language, confidence } = this.detectLanguage(input.text);
      output.language = language;
      output.languageConfidence = confidence;
    }

    // Sentiment analysis (hybrid: lexicon + LLM fallback)
    if (ops.has('sentiment')) {
      output.sentiment = await this.analyzeSentiment(input, words);
    }

    // Named entity recognition (LLM-powered)
    if (ops.has('entities')) {
      output.entities = await this.extractEntities(input);
    }

    // Keyword extraction (TF-IDF inspired)
    if (ops.has('keywords')) {
      output.keywords = this.extractKeywords(words, input.keywordCount);
    }

    // Summarization (LLM)
    if (ops.has('summary')) {
      output.summary = await this.summarize(input);
    }

    // Text classification (LLM with custom labels)
    if (ops.has('classify')) {
      output.classification = await this.classify(input);
    }

    // Toxicity detection
    if (ops.has('toxicity')) {
      output.toxicity = this.detectToxicity(words);
    }

    return output;
  }

  // ── NLP Methods ───────────────────────────────────────────────────────────

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s'-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1);
  }

  private splitSentences(text: string): string[] {
    return text.split(/(?<=[.!?])\s+(?=[A-Z])/).filter((s) => s.trim().length > 0);
  }

  private detectLanguage(text: string): { language: string; confidence: number } {
    // Simplified: detect common language patterns
    const sample = text.slice(0, 1000).toLowerCase();
    const langPatterns: Record<string, RegExp> = {
      en: /\b(the|and|is|in|of|to|a)\b/g,
      fr: /\b(le|la|les|et|en|de|du|un|une)\b/g,
      es: /\b(el|la|los|las|y|en|de|del|un|una)\b/g,
      de: /\b(der|die|das|und|in|von|zu|mit|auf)\b/g,
      pt: /\b(o|a|os|as|e|em|de|do|da|um|uma)\b/g,
    };

    const scores: Record<string, number> = {};
    for (const [lang, pattern] of Object.entries(langPatterns)) {
      scores[lang] = (sample.match(pattern) ?? []).length;
    }

    const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    const total = Object.values(scores).reduce((s, v) => s + v, 0);

    return {
      language: top?.[0] ?? 'unknown',
      confidence: total > 0 ? (top?.[1] ?? 0) / total : 0,
    };
  }

  private async analyzeSentiment(input: NlpInput, words: string[]): Promise<z.infer<typeof SentimentSchema>> {
    // Lexicon-based scoring
    let positiveCount = 0;
    let negativeCount = 0;

    for (const word of words) {
      if (NlpSkill.POSITIVE_WORDS.has(word)) positiveCount++;
      if (NlpSkill.NEGATIVE_WORDS.has(word)) negativeCount++;
    }

    const total = positiveCount + negativeCount;
    const lexiconScore = total > 0 ? (positiveCount - negativeCount) / total : 0;

    // For longer texts or fine-grained analysis, use LLM
    if (words.length > 50 || input.sentimentGranularity === 'fine_grained') {
      try {
        const llmSentiment = await this.llmSentiment(input);
        return llmSentiment;
      } catch {
        // Fall through to lexicon result
      }
    }

    const positive = total > 0 ? positiveCount / Math.max(words.length, 1) : 0;
    const negative = total > 0 ? negativeCount / Math.max(words.length, 1) : 0;

    const label = this.scoreToLabel(lexiconScore, input.sentimentGranularity);
    return {
      label,
      score: lexiconScore,
      confidence: Math.min(total / 10, 1),
      breakdown: { positive, negative, neutral: 1 - positive - negative },
    };
  }

  private async llmSentiment(input: NlpInput): Promise<z.infer<typeof SentimentSchema>> {
    this.trackApiCall();
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] });

    const response = await client.chat.completions.create({
      model: input.model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Analyze sentiment. Respond with JSON: {"label": "positive|negative|neutral|very_positive|very_negative|mixed", "score": -1 to 1, "confidence": 0 to 1, "breakdown": {"positive": 0-1, "negative": 0-1, "neutral": 0-1}}',
        },
        { role: 'user', content: input.text.substring(0, 4000) },
      ],
      max_tokens: 150,
    });

    return JSON.parse(response.choices[0]?.message?.content ?? '{}') as z.infer<typeof SentimentSchema>;
  }

  private async extractEntities(input: NlpInput): Promise<z.infer<typeof EntitySchema>[]> {
    this.trackApiCall();

    try {
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] });

      const response = await client.chat.completions.create({
        model: input.model,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'Extract named entities. Respond with JSON: {"entities": [{"text": "...", "type": "PERSON|ORGANIZATION|LOCATION|DATE|MONEY|PERCENT|PRODUCT|EVENT|OTHER", "score": 0-1, "startIndex": N, "endIndex": N}]}',
          },
          { role: 'user', content: input.text.substring(0, 4000) },
        ],
        max_tokens: 800,
      });

      const parsed = JSON.parse(response.choices[0]?.message?.content ?? '{"entities":[]}') as { entities: z.infer<typeof EntitySchema>[] };
      return parsed.entities ?? [];
    } catch {
      return [];
    }
  }

  private extractKeywords(words: string[], count: number): z.infer<typeof KeywordSchema>[] {
    // Remove stopwords and count frequencies
    const freq = new Map<string, number>();
    const filtered = words.filter((w) => !NlpSkill.STOPWORDS.has(w) && w.length > 2);

    for (const word of filtered) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }

    // Add bigrams
    const bigramFreq = new Map<string, number>();
    for (let i = 0; i < filtered.length - 1; i++) {
      const bigram = `${filtered[i]} ${filtered[i + 1]}`;
      bigramFreq.set(bigram, (bigramFreq.get(bigram) ?? 0) + 1);
    }

    const totalWords = filtered.length || 1;

    const keywords: z.infer<typeof KeywordSchema>[] = [
      ...Array.from(freq.entries())
        .map(([word, frequency]) => ({
          word,
          score: frequency / totalWords,
          frequency,
          isBigram: false,
        })),
      ...Array.from(bigramFreq.entries())
        .filter(([, f]) => f > 1)
        .map(([word, frequency]) => ({
          word,
          score: (frequency / totalWords) * 1.5, // bigram boost
          frequency,
          isBigram: true,
        })),
    ];

    return keywords
      .sort((a, b) => b.score - a.score)
      .slice(0, count);
  }

  private async summarize(input: NlpInput): Promise<string> {
    this.trackApiCall();

    try {
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] });

      const response = await client.chat.completions.create({
        model: input.model,
        messages: [
          {
            role: 'system',
            content: `Summarize the following text in approximately ${input.summaryLength} words. Be concise and capture key points.`,
          },
          { role: 'user', content: input.text },
        ],
        max_tokens: Math.min(input.summaryLength * 2, 500),
      });

      return response.choices[0]?.message?.content ?? '';
    } catch {
      // Fallback: extract first N sentences
      const sentences = this.splitSentences(input.text);
      const targetSentences = Math.ceil(input.summaryLength / 20);
      return sentences.slice(0, targetSentences).join(' ');
    }
  }

  private async classify(input: NlpInput): Promise<z.infer<typeof ClassificationSchema>> {
    this.trackApiCall();

    const labels = input.classificationLabels ?? [
      'business', 'technology', 'health', 'politics', 'sports', 'entertainment', 'science', 'other',
    ];

    try {
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey: process.env['OPENAI_API_KEY'] });

      const response = await client.chat.completions.create({
        model: input.model,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `Classify the text into one of these categories: ${labels.join(', ')}. Respond with JSON: {"label": "chosen_label", "score": 0-1, "allLabels": [{"label": "...", "score": 0-1}]}`,
          },
          { role: 'user', content: input.text.substring(0, 4000) },
        ],
        max_tokens: 200,
      });

      return JSON.parse(response.choices[0]?.message?.content ?? '{}') as z.infer<typeof ClassificationSchema>;
    } catch {
      return { label: 'other', score: 0.5, allLabels: labels.map((l) => ({ label: l, score: 1 / labels.length })) };
    }
  }

  private detectToxicity(words: string[]): NlpOutput['toxicity'] {
    const toxicPatterns = {
      hate_speech: ['hate', 'racist', 'bigot', 'slur'],
      threats: ['kill', 'hurt', 'attack', 'destroy', 'threaten'],
      harassment: ['harass', 'bully', 'stalk', 'abuse'],
      profanity: ['damn', 'hell', 'crap'], // conservative list for production
    };

    const wordSet = new Set(words);
    const categories: Record<string, number> = {};
    let totalMatches = 0;

    for (const [category, patterns] of Object.entries(toxicPatterns)) {
      const matches = patterns.filter((p) => wordSet.has(p)).length;
      categories[category] = matches / patterns.length;
      totalMatches += matches;
    }

    const score = Math.min(totalMatches / Math.max(words.length * 0.01, 1), 1);

    return { isToxic: score > 0.1, score, categories };
  }

  private scoreToLabel(
    score: number,
    granularity: NlpInput['sentimentGranularity'],
  ): z.infer<typeof SentimentSchema>['label'] {
    if (granularity === 'binary') return score >= 0 ? 'positive' : 'negative';
    if (granularity === 'ternary') {
      if (score > 0.2) return 'positive';
      if (score < -0.2) return 'negative';
      return 'neutral';
    }
    // fine_grained
    if (score > 0.6) return 'very_positive';
    if (score > 0.2) return 'positive';
    if (score > -0.2) return 'neutral';
    if (score > -0.6) return 'negative';
    return 'very_negative';
  }
}

export const nlpSkill = new NlpSkill();
