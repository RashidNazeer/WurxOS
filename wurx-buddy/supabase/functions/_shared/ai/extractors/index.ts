// source_type → extractor. The DB loaders live in ../ingest/loaders.ts.
import { aiDocExtractor, appGuideExtractor } from './aiDoc.ts';
import { incentiveExtractor } from './incentive.ts';
import { kbExtractor } from './kb.ts';
import { reportExtractor } from './report.ts';
import { ttsExtractor } from './tts.ts';

export const extractors = {
  report: reportExtractor,
  kb_article: kbExtractor,
  ai_doc: aiDocExtractor,
  app_guide: appGuideExtractor,
  tts_article: ttsExtractor,
  incentive: incentiveExtractor,
} as const;

export type SourceType = keyof typeof extractors;
export const SOURCE_TYPES = Object.keys(extractors) as SourceType[];
