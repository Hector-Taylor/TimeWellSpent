import type { CategorisationConfig, MarketRate } from '@shared/types';

// Baseline categorisation buckets used on first run and when settings cannot be read.
export const DEFAULT_CATEGORISATION: CategorisationConfig = {
  productive: ['Code', 'Notes', 'Documentation', 'vscode', 'obsidian', 'notion', 'linear.app'],
  neutral: ['Mail', 'Calendar', 'Slack', 'Figma'],
  frivolity: ['twitter.com', 'youtube.com', 'reddit.com']
};

// Reasonable starting rates for common time sinks.
export const DEFAULT_MARKET_RATES: MarketRate[] = [
  {
    domain: 'twitter.com',
    ratePerMin: 3,
    packs: [
      { minutes: 10, price: 28 },
      { minutes: 30, price: 75 }
    ],
    hourlyModifiers: Array(24).fill(1)
  },
  {
    domain: 'youtube.com',
    ratePerMin: 2.5,
    packs: [
      { minutes: 10, price: 23 },
      { minutes: 30, price: 65 }
    ],
    hourlyModifiers: Array(24).fill(1)
  },
  {
    domain: 'reddit.com',
    ratePerMin: 2,
    packs: [
      { minutes: 10, price: 18 },
      { minutes: 30, price: 50 }
    ],
    hourlyModifiers: Array(24).fill(1)
  }
];

export const DEFAULT_IDLE_THRESHOLD_SECONDS = 15;
