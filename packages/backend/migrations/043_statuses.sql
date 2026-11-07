-- 043: statuses — what everyone in the house is up to, for the phone's Status
-- widget and lock-screen card. Shape from Myosia's presence row (status,
-- activity, mood), kept as one row per person:
--   who       'owner', or a companion's slug
--   presence  the owner's dot: here | busy | away | asleep (companions: NULL)
--   line      what they're up to, a short phrase
--   mood      a companion's mood word, which picks their color (owner: NULL)
--   clears_at when the owner's status runs out, ISO (NULL = it stays)
CREATE TABLE IF NOT EXISTS statuses (
  who TEXT PRIMARY KEY,
  presence TEXT,
  line TEXT,
  mood TEXT,
  clears_at TEXT,
  updated_at TEXT NOT NULL
);
