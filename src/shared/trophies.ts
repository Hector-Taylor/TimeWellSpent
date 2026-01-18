import type { TrophyDefinition } from './types';

export const TROPHY_CATEGORY_LABELS: Record<TrophyDefinition['category'], string> = {
  attention: 'Attention Control',
  recovery: 'Recovery & Resilience',
  streaks: 'Anti-Frivolity Streaks',
  economy: 'Economy & Discipline',
  library: 'Library & Intentionality',
  time: 'Time-of-Day',
  stability: 'Stability & Dynamics',
  fun: 'Fun Flavor',
  social: 'Social & Friends',
  secret: 'Secret'
};

export const TROPHY_DEFINITIONS: TrophyDefinition[] = [
  // Attention Control
  {
    id: 'first_light',
    name: 'First Light',
    description: 'Log your very first productive minute.',
    emoji: '🌅',
    category: 'attention',
    rarity: 'common'
  },
  {
    id: 'kept_the_thread',
    name: 'Kept the Thread',
    description: 'Stay productive for 30 minutes without switching context.',
    emoji: '🧵',
    category: 'attention',
    rarity: 'common'
  },
  {
    id: 'deep_pocket',
    name: 'Deep Pocket',
    description: 'Hit 60 minutes in a single productive run.',
    emoji: '🪙',
    category: 'attention',
    rarity: 'uncommon'
  },
  {
    id: 'monk_hour',
    name: 'Monk Hour',
    description: 'Hit 90 minutes in a single productive run.',
    emoji: '🧘',
    category: 'attention',
    rarity: 'rare'
  },
  {
    id: 'cathedral',
    name: 'Cathedral',
    description: 'Log 3 hours of productive time in a 24h window.',
    emoji: '🏛️',
    category: 'attention',
    rarity: 'rare'
  },
  {
    id: 'stonecutter',
    name: 'Stonecutter',
    description: '5 consecutive days with 2 hours of productive time.',
    emoji: '⛏️',
    category: 'attention',
    rarity: 'epic'
  },
  {
    id: 'quiet_hands',
    name: 'Quiet Hands',
    description: 'Keep idle time under 10% in a 24h window.',
    emoji: '🤲',
    category: 'attention',
    rarity: 'uncommon'
  },
  {
    id: 'low_turbulence',
    name: 'Low Turbulence',
    description: 'Keep context switches under 3/hour for a full day.',
    emoji: '🛫',
    category: 'attention',
    rarity: 'uncommon'
  },
  {
    id: 'flow_engineer',
    name: 'Flow Engineer',
    description: 'Set a new personal best productive run.',
    emoji: '🛠️',
    category: 'attention',
    rarity: 'rare'
  },
  {
    id: 'second_brain',
    name: 'Second Brain',
    description: 'Complete 10 replace items instead of frivolity.',
    emoji: '🧠',
    category: 'attention',
    rarity: 'rare'
  },

  // Recovery & Resilience
  {
    id: 'bounce_back',
    name: 'Bounce Back',
    description: 'Return to productive within 10 minutes after frivolity.',
    emoji: '🏀',
    category: 'recovery',
    rarity: 'common'
  },
  {
    id: 'elastic_mind',
    name: 'Elastic Mind',
    description: 'Improve your median recovery time vs last week.',
    emoji: '🪢',
    category: 'recovery',
    rarity: 'rare'
  },
  {
    id: 'one_slip_no_slide',
    name: 'One Slip, No Slide',
    description: 'Only one frivolity session in a 24h window.',
    emoji: '🧊',
    category: 'recovery',
    rarity: 'uncommon'
  },
  {
    id: 'damage_control',
    name: 'Damage Control',
    description: 'Keep frivolity under 15 minutes in 24h.',
    emoji: '🧯',
    category: 'recovery',
    rarity: 'uncommon'
  },
  {
    id: 'phoenix',
    name: 'Phoenix',
    description: 'Your best productive run begins after frivolity.',
    emoji: '🔥',
    category: 'recovery',
    rarity: 'rare'
  },
  {
    id: 'cold_start',
    name: 'Cold Start',
    description: 'Start your day productive within 15 minutes.',
    emoji: '🧊',
    category: 'recovery',
    rarity: 'common'
  },
  {
    id: 'soft_landing',
    name: 'Soft Landing',
    description: 'End the day with a recovery ritual after drift.',
    emoji: '🌙',
    category: 'recovery',
    rarity: 'rare'
  },

  // Anti-Frivolity Streaks
  {
    id: 'clean_24',
    name: 'Clean 24',
    description: '24 hours without frivolity.',
    emoji: '🧼',
    category: 'streaks',
    rarity: 'common'
  },
  {
    id: 'two_day_glass',
    name: 'Two-Day Glass',
    description: '48 hours without frivolity.',
    emoji: '🪟',
    category: 'streaks',
    rarity: 'uncommon'
  },
  {
    id: 'three_day_gold',
    name: 'Three-Day Gold',
    description: '72 hours without frivolity.',
    emoji: '🥇',
    category: 'streaks',
    rarity: 'rare'
  },
  {
    id: 'week_of_steel',
    name: 'Week of Steel',
    description: '7 days without frivolity.',
    emoji: '🛡️',
    category: 'streaks',
    rarity: 'epic'
  },
  {
    id: 'weekend_shield',
    name: 'Weekend Shield',
    description: 'No frivolity on Saturday and Sunday.',
    emoji: '🗓️',
    category: 'streaks',
    rarity: 'rare'
  },
  {
    id: 'temptation_tamer',
    name: 'Temptation Tamer',
    description: 'Decline frivolity when it shows up.',
    emoji: '🐍',
    category: 'streaks',
    rarity: 'uncommon'
  },
  {
    id: 'gate_held',
    name: 'The Gate Held',
    description: 'Reject 10 paywall prompts.',
    emoji: '🚪',
    category: 'streaks',
    rarity: 'rare'
  },

  // Economy & Discipline
  {
    id: 'no_spend_day',
    name: 'No Spend Day',
    description: 'Go 24 hours with zero frivolity spending.',
    emoji: '💸',
    category: 'economy',
    rarity: 'common'
  },
  {
    id: 'under_budget',
    name: 'Under Budget',
    description: 'Stay under your daily frivolity budget for 7 days.',
    emoji: '📉',
    category: 'economy',
    rarity: 'rare'
  },
  {
    id: 'high_yield',
    name: 'High Yield',
    description: 'Grow your balance 3 days in a row.',
    emoji: '📈',
    category: 'economy',
    rarity: 'uncommon'
  },
  {
    id: 'investor',
    name: 'Investor',
    description: 'Hit a new all-time-high balance.',
    emoji: '🏦',
    category: 'economy',
    rarity: 'rare'
  },
  {
    id: 'escrow_master',
    name: 'Escrow Master',
    description: 'Complete 5 escrow contracts.',
    emoji: '🧾',
    category: 'economy',
    rarity: 'rare'
  },
  {
    id: 'iron_contract',
    name: 'Iron Contract',
    description: 'Complete a hard-stakes escrow.',
    emoji: '⚙️',
    category: 'economy',
    rarity: 'epic'
  },
  {
    id: 'debt_free',
    name: 'Debt-Free',
    description: 'Stay positive after clearing a penalty.',
    emoji: '🧿',
    category: 'economy',
    rarity: 'uncommon'
  },

  // Library & Intentionality
  {
    id: 'curator',
    name: 'Curator',
    description: 'Add 25 replace items to your library.',
    emoji: '🗂️',
    category: 'library',
    rarity: 'common'
  },
  {
    id: 'librarian',
    name: 'Librarian',
    description: 'Mark 20 library items as done.',
    emoji: '📚',
    category: 'library',
    rarity: 'uncommon'
  },
  {
    id: 'taste_upgrade',
    name: 'Taste Upgrade',
    description: 'Use the replace pool more this week than last.',
    emoji: '🍵',
    category: 'library',
    rarity: 'rare'
  },
  {
    id: 'clean_desk',
    name: 'Clean Desk',
    description: 'Keep 10+ replace items ready.',
    emoji: '🧹',
    category: 'library',
    rarity: 'common'
  },
  {
    id: 'gentle_redirect',
    name: 'Gentle Redirect',
    description: 'Choose replace items 10 times.',
    emoji: '🧭',
    category: 'library',
    rarity: 'uncommon'
  },
  {
    id: 'completionist',
    name: 'Completionist',
    description: 'Finish 10 reading items.',
    emoji: '✅',
    category: 'library',
    rarity: 'rare'
  },

  // Time-of-Day
  {
    id: 'morning_anchor',
    name: 'Morning Anchor',
    description: '30 productive minutes before 10am.',
    emoji: '🌄',
    category: 'time',
    rarity: 'common'
  },
  {
    id: 'noon_navigator',
    name: 'Noon Navigator',
    description: 'Avoid frivolity during your riskiest hour.',
    emoji: '🧭',
    category: 'time',
    rarity: 'rare'
  },
  {
    id: 'afternoon_fortress',
    name: 'Afternoon Fortress',
    description: '2–5pm is 60% productive or more.',
    emoji: '🏰',
    category: 'time',
    rarity: 'uncommon'
  },
  {
    id: 'night_watch',
    name: 'Night Watch',
    description: 'No frivolity after 9pm for 7 days.',
    emoji: '🕯️',
    category: 'time',
    rarity: 'rare'
  },
  {
    id: 'prime_time',
    name: 'Prime Time',
    description: 'Hit your best hour-of-day productivity again.',
    emoji: '⏱️',
    category: 'time',
    rarity: 'uncommon'
  },

  // Stability & Dynamics
  {
    id: 'stable_orbit',
    name: 'Stable Orbit',
    description: 'Hourly productivity variance drops vs last week.',
    emoji: '🪐',
    category: 'stability',
    rarity: 'rare'
  },
  {
    id: 'attractor_shift',
    name: 'Attractor Shift',
    description: 'Dominant state shifts from neutral to productive.',
    emoji: '🧲',
    category: 'stability',
    rarity: 'rare'
  },
  {
    id: 'signal_clarity',
    name: 'Signal Clarity',
    description: 'Flow stability stays high for 24h.',
    emoji: '📡',
    category: 'stability',
    rarity: 'uncommon'
  },
  {
    id: 'low_drift',
    name: 'Low Drift',
    description: 'Neutral time under 25% with solid activity.',
    emoji: '🛰️',
    category: 'stability',
    rarity: 'uncommon'
  },
  {
    id: 'anti_chaos',
    name: 'Anti-Chaos',
    description: 'Low idle + low context switches in 24h.',
    emoji: '🧯',
    category: 'stability',
    rarity: 'rare'
  },

  // Fun Flavor
  {
    id: 'shield',
    name: 'The Shield',
    description: 'Hold the line after a paywall prompt.',
    emoji: '🛡️',
    category: 'fun',
    rarity: 'common'
  },
  {
    id: 'lantern',
    name: 'The Lantern',
    description: 'Peek, then walk away.',
    emoji: '🏮',
    category: 'fun',
    rarity: 'rare'
  },
  {
    id: 'compass',
    name: 'The Compass',
    description: 'Correct course 3 times in a day.',
    emoji: '🧭',
    category: 'fun',
    rarity: 'uncommon'
  },
  {
    id: 'hourglass',
    name: 'The Hourglass',
    description: 'Log activity every day for 14 days.',
    emoji: '⏳',
    category: 'fun',
    rarity: 'rare'
  },
  {
    id: 'touch_grass',
    name: 'Touch Grass',
    description: 'Keep total screen time under 3 hours in a day.',
    emoji: '🌿',
    category: 'fun',
    rarity: 'uncommon'
  },
  {
    id: 'alchemist',
    name: 'The Alchemist',
    description: 'Flip a rough day into a strong tomorrow.',
    emoji: '⚗️',
    category: 'fun',
    rarity: 'rare'
  },
  {
    id: 'archivist',
    name: 'The Archivist',
    description: 'Add notes or purpose to 20 saved items.',
    emoji: '🗄️',
    category: 'fun',
    rarity: 'uncommon'
  },

  // Social & Friends
  {
    id: 'first_rival',
    name: 'First Rival',
    description: 'Add your first friend.',
    emoji: '🤝',
    category: 'social',
    rarity: 'common'
  },
  {
    id: 'good_sport',
    name: 'Good Sport',
    description: 'Complete a head-to-head week challenge.',
    emoji: '🏅',
    category: 'social',
    rarity: 'rare'
  },
  {
    id: 'comeback_kid',
    name: 'Comeback Kid',
    description: 'Lose a day, win the next.',
    emoji: '🎯',
    category: 'social',
    rarity: 'rare'
  },
  {
    id: 'unbeaten',
    name: 'Unbeaten',
    description: 'Win 5 daily comparisons in a row.',
    emoji: '🥊',
    category: 'social',
    rarity: 'epic'
  },
  {
    id: 'patron',
    name: 'Patron',
    description: 'Send 10 focus boosts to friends.',
    emoji: '🎁',
    category: 'social',
    rarity: 'uncommon'
  },
  {
    id: 'the_standard',
    name: 'The Standard',
    description: 'A friend views your profile often.',
    emoji: '🏁',
    category: 'social',
    rarity: 'rare'
  },

  // Secret
  {
    id: 'narrow_escape',
    name: 'The Narrow Escape',
    description: 'Proceed anyway, but exit within 60 seconds.',
    emoji: '🏃',
    category: 'secret',
    rarity: 'secret',
    secret: true
  },
  {
    id: 'librarians_revenge',
    name: "The Librarian's Revenge",
    description: 'Open 3 reading items within 10 minutes of a paywall.',
    emoji: '📖',
    category: 'secret',
    rarity: 'secret',
    secret: true
  },
  {
    id: 'zero_hour',
    name: 'Zero Hour',
    description: 'Set your lowest idle ratio ever.',
    emoji: '🕳️',
    category: 'secret',
    rarity: 'secret',
    secret: true
  },
  {
    id: 'glass_cannon',
    name: 'Glass Cannon',
    description: 'Huge focus run with chaotic switching.',
    emoji: '🧨',
    category: 'secret',
    rarity: 'secret',
    secret: true
  },
  {
    id: 'surgical_strike',
    name: 'Surgical Strike',
    description: 'One focused session completes the day’s plan.',
    emoji: '🩺',
    category: 'secret',
    rarity: 'secret',
    secret: true
  }
];
