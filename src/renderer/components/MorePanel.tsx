import Analytics from './Analytics';
import Friends from './Friends';
import Games from './Games';
import Profile from './Profile';
import Settings from './Settings';
import type { RendererApi, WalletSnapshot } from '@shared/types';

type MoreView = 'analytics' | 'settings' | 'friends' | 'profile' | 'games';

type Props = {
  section: MoreView;
  onSectionChange: (section: MoreView) => void;
  api: RendererApi;
  wallet: WalletSnapshot;
  theme: 'lavender' | 'olive';
  onThemeChange: (next: 'lavender' | 'olive') => void;
};

const MORE_ITEMS: Array<{ id: MoreView; label: string; title: string; summary: string }> = [
  {
    id: 'analytics',
    label: 'Analytics',
    title: 'Analytics',
    summary: 'Review trends, risk windows, and supporting signals without crowding the main workspace.'
  },
  {
    id: 'settings',
    label: 'Settings',
    title: 'Settings',
    summary: 'Tune the system so the app feels strict where it matters and quiet everywhere else.'
  },
  {
    id: 'friends',
    label: 'Friends',
    title: 'Friends',
    summary: 'Keep accountability and shared momentum visible without turning the product into social noise.'
  },
  {
    id: 'profile',
    label: 'Profile',
    title: 'Profile',
    summary: 'Manage the identity, handle, and public-facing signals other people see.'
  },
  {
    id: 'games',
    label: 'Games',
    title: 'Games',
    summary: 'Use rewards and lightweight play as a side channel, not the center of attention.'
  }
];

export default function MorePanel({ section, onSectionChange, api, wallet, theme, onThemeChange }: Props) {
  const activeItem = MORE_ITEMS.find((item) => item.id === section) ?? MORE_ITEMS[0];
  const activeIndex = MORE_ITEMS.findIndex((item) => item.id === activeItem.id) + 1;

  return (
    <section className="panel more-panel">
      <header className="panel-header more-panel-header">
        <div>
          <p className="eyebrow">Secondary surfaces</p>
          <h1>{activeItem.title}</h1>
          <p className="subtitle">{activeItem.summary}</p>
        </div>

        <div className="more-panel-meta">
          <span className="pill ghost">Section {activeIndex} of {MORE_ITEMS.length}</span>
          <span className="pill ghost">{wallet.balance} f-coins</span>
          <span className="pill ghost">Theme {theme}</span>
        </div>
      </header>

      <div className="more-panel-spotlight">
        <div className="more-panel-spotlight-copy">
          <strong>{activeItem.label}</strong>
          <p>{activeItem.summary}</p>
        </div>
      </div>

      <div className="more-panel-nav" role="tablist" aria-label="More sections">
        {MORE_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            className={section === item.id ? 'active' : ''}
            aria-selected={section === item.id}
            onClick={() => onSectionChange(item.id)}
          >
            <span>{item.label}</span>
          </button>
        ))}
      </div>

      {section === 'analytics' && <Analytics api={api} />}
      {section === 'settings' && (
        <Settings
          api={api}
          theme={theme}
          onThemeChange={onThemeChange}
        />
      )}
      {section === 'friends' && <Friends api={api} />}
      {section === 'profile' && <Profile api={api} />}
      {section === 'games' && <Games wallet={wallet} />}
    </section>
  );
}
