import { useEffect, useMemo, useState } from 'react';

type SudokuUnlockPayload = {
  correctSquares: number;
  requiredSquares: number;
  elapsedSeconds: number;
};

interface SudokuChallengeProps {
  title: string;
  subtitle?: string;
  requiredCorrect?: number;
  unlockLabel?: string;
  onUnlock?: (payload: SudokuUnlockPayload) => Promise<void> | void;
  disabled?: boolean;
  puzzleKey?: string;
}

const HARD_PUZZLE = [
  [8, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 3, 6, 0, 0, 0, 0, 0],
  [0, 7, 0, 0, 9, 0, 2, 0, 0],
  [0, 5, 0, 0, 0, 7, 0, 0, 0],
  [0, 0, 0, 0, 4, 5, 7, 0, 0],
  [0, 0, 0, 1, 0, 0, 0, 3, 0],
  [0, 0, 1, 0, 0, 0, 0, 6, 8],
  [0, 0, 8, 5, 0, 0, 0, 1, 0],
  [0, 9, 0, 0, 0, 0, 4, 0, 0]
] as const;

const HARD_SOLUTION = [
  [8, 1, 2, 7, 5, 3, 6, 4, 9],
  [9, 4, 3, 6, 8, 2, 1, 7, 5],
  [6, 7, 5, 4, 9, 1, 2, 8, 3],
  [1, 5, 4, 2, 3, 7, 8, 9, 6],
  [3, 6, 9, 8, 4, 5, 7, 2, 1],
  [2, 8, 7, 1, 6, 9, 5, 3, 4],
  [5, 2, 1, 9, 7, 4, 3, 6, 8],
  [4, 3, 8, 5, 2, 6, 9, 1, 7],
  [7, 9, 6, 3, 1, 8, 4, 5, 2]
] as const;

const BLANK_CELLS = HARD_PUZZLE.flatMap((row, rowIndex) =>
  row.flatMap((value, colIndex) => (value === 0 ? [{ row: rowIndex, col: colIndex }] : []))
);

function createEmptyEntries() {
  return HARD_PUZZLE.map((row) => row.map((value) => (value === 0 ? '' : String(value))));
}

export default function SudokuChallenge({
  title,
  subtitle,
  requiredCorrect = 12,
  unlockLabel = 'Unlock',
  onUnlock,
  disabled = false,
  puzzleKey
}: SudokuChallengeProps) {
  const [entries, setEntries] = useState<string[][]>(() => createEmptyEntries());
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const requiredSquares = useMemo(
    () => Math.max(1, Math.min(BLANK_CELLS.length, Math.round(requiredCorrect))),
    [requiredCorrect]
  );

  const correctSquares = useMemo(() => {
    return BLANK_CELLS.reduce((count, cell) => {
      const value = entries[cell.row]?.[cell.col];
      if (!value) return count;
      return Number(value) === HARD_SOLUTION[cell.row][cell.col] ? count + 1 : count;
    }, 0);
  }, [entries]);

  const solvedEnough = correctSquares >= requiredSquares;
  const progressPercent = Math.min(100, (correctSquares / requiredSquares) * 100);

  useEffect(() => {
    setEntries(createEmptyEntries());
    setStartedAt(Date.now());
    setUnlockError(null);
    setUnlocking(false);
  }, [puzzleKey]);

  const updateEntry = (rowIndex: number, colIndex: number, rawValue: string) => {
    if (HARD_PUZZLE[rowIndex][colIndex] !== 0 || disabled) return;
    const value = rawValue.replace(/[^1-9]/g, '').slice(-1);
    setEntries((prev) => {
      const next = prev.map((row) => [...row]);
      next[rowIndex][colIndex] = value;
      return next;
    });
  };

  const clearPuzzle = () => {
    setEntries(createEmptyEntries());
    setStartedAt(Date.now());
    setUnlockError(null);
  };

  const handleUnlock = async () => {
    if (!onUnlock || !solvedEnough || unlocking || disabled) return;
    setUnlocking(true);
    setUnlockError(null);
    try {
      await onUnlock({
        correctSquares,
        requiredSquares,
        elapsedSeconds: Math.max(1, Math.round((Date.now() - startedAt) / 1000))
      });
    } catch (error) {
      setUnlockError((error as Error).message);
    } finally {
      setUnlocking(false);
    }
  };

  return (
    <section className="sudoku-challenge">
      <div className="sudoku-header">
        <strong>{title}</strong>
        {subtitle && <p className="subtle">{subtitle}</p>}
      </div>
      <div className="sudoku-progress-row">
        <span>
          Correct squares: {correctSquares}/{requiredSquares}
        </span>
        <span>{progressPercent.toFixed(0)}%</span>
      </div>
      <div className="sudoku-progress-track" aria-hidden>
        <span style={{ width: `${progressPercent}%` }} />
      </div>
      <div className="sudoku-grid" role="group" aria-label="Sudoku puzzle">
        {HARD_PUZZLE.map((row, rowIndex) =>
          row.map((value, colIndex) => {
            const isFixed = value !== 0;
            const currentValue = isFixed ? String(value) : entries[rowIndex][colIndex];
            const hasValue = currentValue.length > 0;
            const isCorrect = !isFixed && hasValue && Number(currentValue) === HARD_SOLUTION[rowIndex][colIndex];
            const isIncorrect = !isFixed && hasValue && !isCorrect;
            const classNames = [
              'sudoku-cell',
              isFixed ? 'is-fixed' : '',
              isCorrect ? 'is-correct' : '',
              isIncorrect ? 'is-incorrect' : ''
            ]
              .filter(Boolean)
              .join(' ');

            return (
              <input
                key={`${rowIndex}-${colIndex}`}
                className={classNames}
                type="text"
                inputMode="numeric"
                pattern="[1-9]"
                maxLength={1}
                value={currentValue}
                disabled={isFixed || disabled || unlocking}
                onChange={(event) => updateEntry(rowIndex, colIndex, event.target.value)}
                style={{
                  borderTopWidth: rowIndex % 3 === 0 ? 2 : 1,
                  borderLeftWidth: colIndex % 3 === 0 ? 2 : 1,
                  borderRightWidth: colIndex === 8 ? 2 : 1,
                  borderBottomWidth: rowIndex === 8 ? 2 : 1
                }}
                aria-label={`Row ${rowIndex + 1} column ${colIndex + 1}`}
              />
            );
          })
        )}
      </div>
      <div className="sudoku-actions">
        <button type="button" className="ghost" onClick={clearPuzzle} disabled={unlocking}>
          Reset puzzle
        </button>
        {onUnlock ? (
          <button type="button" className="primary" onClick={handleUnlock} disabled={!solvedEnough || unlocking || disabled}>
            {unlocking ? 'Unlocking...' : unlockLabel}
          </button>
        ) : (
          <span className="subtle">{solvedEnough ? 'Challenge complete.' : 'Practice mode'}</span>
        )}
      </div>
      {unlockError && <p className="warning subtle">{unlockError}</p>}
    </section>
  );
}
