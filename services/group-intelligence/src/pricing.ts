import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Unit prices used to estimate costs that no upstream reports directly. Every figure is an
 * assumption with an `asOf` date — responses surface it in provenance limitations.
 */
export const PricingSchema = z.object({
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.literal('USD'),
  /** Speech-to-text price per audio minute (Chirp 2 batch). */
  sttUsdPerMinute: z.number().nonnegative(),
  /** Assumed captured minutes per class when durations are not reported upstream. */
  assumedMinutesPerClass: z.number().positive(),
  /** Audio storage: GB per minute of 16 kHz mono PCM and price per GB-month. */
  audioGbPerMinute: z.number().positive(),
  storageUsdPerGbMonth: z.number().nonnegative(),
  /** Months of raw-audio retention charged at capture time (policy default 90 days ≈ 3). */
  audioRetentionMonths: z.number().positive(),
  /** Hardware: unit cost of one capture device and amortisation period. */
  deviceUnitCostUsd: z.number().nonnegative(),
  deviceAmortisationMonths: z.number().int().positive(),
});

export type Pricing = z.infer<typeof PricingSchema>;

export const DEFAULT_PRICING: Pricing = {
  asOf: '2026-11-04',
  currency: 'USD',
  sttUsdPerMinute: 0.016,
  assumedMinutesPerClass: 90,
  audioGbPerMinute: 0.00192,
  storageUsdPerGbMonth: 0.023,
  audioRetentionMonths: 3,
  deviceUnitCostUsd: 450,
  deviceAmortisationMonths: 36,
};

export function loadPricing(path: string | undefined): Pricing {
  if (!path) return DEFAULT_PRICING;
  return PricingSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export const daysInMonth = (date: string): number => {
  const [y, m] = date.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, m ?? 1, 0)).getUTCDate();
};

const cents = (n: number): number => Math.round(n * 1e6) / 1e6;

export function sttCost(p: Pricing, classesTranscribed: number): number {
  return cents(classesTranscribed * p.assumedMinutesPerClass * p.sttUsdPerMinute);
}

export function storageCost(p: Pricing, classesCaptured: number): number {
  const gb = classesCaptured * p.assumedMinutesPerClass * p.audioGbPerMinute;
  return cents(gb * p.storageUsdPerGbMonth * p.audioRetentionMonths);
}

export function hardwareDailyCost(p: Pricing, devices: number, date: string): number {
  return cents((devices * p.deviceUnitCostUsd) / p.deviceAmortisationMonths / daysInMonth(date));
}

export function pricingLimitations(p: Pricing): string[] {
  return [
    `Custos de STT, armazenamento e hardware são estimativas com preços de ${p.asOf} ` +
      `(STT US$ ${p.sttUsdPerMinute}/min, ${p.assumedMinutesPerClass} min por aula, ` +
      `armazenamento US$ ${p.storageUsdPerGbMonth}/GB-mês por ${p.audioRetentionMonths} meses, ` +
      `dispositivo US$ ${p.deviceUnitCostUsd} em ${p.deviceAmortisationMonths} meses).`,
  ];
}
