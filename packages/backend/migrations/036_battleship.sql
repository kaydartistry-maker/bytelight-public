CREATE TABLE IF NOT EXISTS battleship_games (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('setup', 'playing', 'complete')),
  turn TEXT NOT NULL CHECK(turn IN ('owner', 'companions')),
  player_fleet_json TEXT NOT NULL DEFAULT '[]',
  companion_fleet_json TEXT NOT NULL,
  player_shots_json TEXT NOT NULL DEFAULT '[]',
  companion_shots_json TEXT NOT NULL DEFAULT '[]',
  companion_pending INTEGER NOT NULL DEFAULT 0,
  companion_error TEXT,
  winner TEXT CHECK(winner IS NULL OR winner IN ('owner', 'companions')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES threads(id)
);

CREATE INDEX IF NOT EXISTS idx_battleship_games_created
  ON battleship_games(created_at DESC);

CREATE TABLE IF NOT EXISTS battleship_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('system', 'shot', 'chat')),
  actor TEXT NOT NULL,
  content TEXT NOT NULL,
  coordinate TEXT,
  result TEXT CHECK(result IS NULL OR result IN ('miss', 'hit', 'sunk')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (game_id) REFERENCES battleship_games(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_battleship_log_game
  ON battleship_log(game_id, id);
