import type { WalletSnapshot } from '@shared/types';
import SudokuChallenge from './SudokuChallenge';

interface GamesProps {
  wallet: WalletSnapshot;
}

const NYT_GAMES = [
  {
    name: 'The Crossword',
    hint: 'Full daily crossword.',
    url: 'https://www.nytimes.com/crosswords/game/daily'
  },
  {
    name: 'The Mini',
    hint: 'Quick 5-minute crossword.',
    url: 'https://www.nytimes.com/crosswords/game/mini'
  },
  {
    name: 'Connections',
    hint: 'Find the four hidden groups.',
    url: 'https://www.nytimes.com/games/connections'
  },
  {
    name: 'Wordle',
    hint: 'One word, six tries.',
    url: 'https://www.nytimes.com/games/wordle/index.html'
  },
  {
    name: 'Spelling Bee',
    hint: 'Build words from seven letters.',
    url: 'https://www.nytimes.com/puzzles/spelling-bee'
  },
  {
    name: 'Strands',
    hint: 'Find the themed word web.',
    url: 'https://www.nytimes.com/games/strands'
  }
];

export default function Games({ wallet }: GamesProps) {
  return (
    <section className="games-view panel">
      <header className="games-hero">
        <div>
          <h2>Games</h2>
          <p className="subtle">
            Intentional time burners: quick fun, finite sessions, less doom-scroll.
          </p>
        </div>
        <div className="games-wallet-pill">
          <span>Wallet</span>
          <strong>{wallet.balance} f-coins</strong>
        </div>
      </header>

      <section className="games-links-section">
        <div className="section-header-row">
          <div>
            <h3>NYT quick launch</h3>
            <p className="subtle">If you want to burn a little time, do it on purpose.</p>
          </div>
          <a href="https://www.nytimes.com/crosswords" target="_blank" rel="noopener noreferrer" className="ghost button-link">
            Open NYT games hub
          </a>
        </div>
        <div className="games-links-grid">
          {NYT_GAMES.map((game) => (
            <a key={game.name} className="nyt-link-card" href={game.url} target="_blank" rel="noopener noreferrer">
              <div className="nyt-link-title">{game.name}</div>
              <p className="subtle">{game.hint}</p>
              <span className="chip">Open</span>
            </a>
          ))}
        </div>
      </section>

      <section className="games-sudoku-section">
        <div className="section-header-row">
          <div>
            <h3>Paywall Sudoku drill</h3>
            <p className="subtle">Practice the same challenge used in the paywall free-pass flow.</p>
          </div>
        </div>
        <SudokuChallenge
          title="Hard Sudoku practice"
          subtitle="Solve any 9 blank squares correctly."
          requiredCorrect={9}
        />
      </section>
    </section>
  );
}
