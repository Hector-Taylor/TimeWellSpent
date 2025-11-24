import { useEffect, useState, type FormEvent } from 'react';
import type { CategorisationConfig, RendererApi } from '@shared/types';

interface SettingsProps {
  api: RendererApi;
  categorisation: CategorisationConfig | null;
  onCategorisation(value: CategorisationConfig): void;
}

export default function Settings({ api, categorisation, onCategorisation }: SettingsProps) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Keep raw text state for inputs to allow newlines while editing
  const [productiveText, setProductiveText] = useState('');
  const [neutralText, setNeutralText] = useState('');
  const [frivolityText, setFrivolityText] = useState('');

  useEffect(() => {
    if (categorisation) {
      setProductiveText(categorisation.productive.join('\n'));
      setNeutralText(categorisation.neutral.join('\n'));
      setFrivolityText(categorisation.frivolity.join('\n'));
    }
  }, [categorisation]);

  if (!categorisation) {
    return (
      <section className="panel">
        <div className="panel-header">
          <h1>Settings</h1>
        </div>
        <p className="subtle">Loading configuration…</p>
      </section>
    );
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);

    const parse = (text: string) => text.split('\n').map(t => t.trim()).filter(Boolean);

    const newConfig: CategorisationConfig = {
      productive: parse(productiveText),
      neutral: parse(neutralText),
      frivolity: parse(frivolityText)
    };

    await api.settings.updateCategorisation(newConfig);
    onCategorisation(newConfig);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <h1>Settings</h1>
          <p className="subtle">Manage categorisation and macOS permissions.</p>
        </div>
      </header>

      <form className="settings-grid" onSubmit={save}>
        <label>
          Productive identifiers
          <textarea value={productiveText} onChange={(e) => setProductiveText(e.target.value)} />
        </label>
        <label>
          Neutral identifiers
          <textarea value={neutralText} onChange={(e) => setNeutralText(e.target.value)} />
        </label>
        <label>
          Frivolity identifiers (domains or app names)
          <textarea value={frivolityText} onChange={(e) => setFrivolityText(e.target.value)} />
          <p className="subtle">Add entries such as “zotero” or “instagram.com” — matches run against both app titles and URLs.</p>
        </label>
        <button className="primary" type="submit" disabled={saving}>
          {saving ? 'Saving…' : saved ? 'Saved!' : 'Save changes'}
        </button>
      </form>

      <section className="card">
        <h2>Accessibility permissions</h2>
        <ol className="instructions">
          <li>Open System Settings → Privacy &amp; Security → Accessibility.</li>
          <li>Click the lock to make changes and authenticate.</li>
          <li>Find “TimeWellSpent” in the list and toggle it on.</li>
          <li>Repeat under “Automation” to allow browser control.</li>
        </ol>
        <p className="subtle">You can paste <code>x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility</code> into Spotlight to jump there quickly.</p>
      </section>
    </section>
  );
}
