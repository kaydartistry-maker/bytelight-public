// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import { Router } from 'express';
import {
  BATTLESHIP_FLEET,
  BATTLESHIP_SIZE,
  BattleshipError,
  beginBattleshipCompanionResponse,
  fireAtCompanionFleet,
  finishBattleshipCompanionResponse,
  getBattleshipView,
  newBattleshipGame,
  startBattleshipGame,
  type ShipPlacement,
} from '../services/db.js';
import { ownerDisplayName } from '../services/db/owner-name.js';
import type { AgentService } from '../services/agent.js';
import { registry } from '../services/ws.js';

const router = Router();

function sendError(res: import('express').Response, error: unknown): void {
  if (error instanceof BattleshipError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error('[Battleship]', error);
  res.status(500).json({ error: 'The harbor hit rough water' });
}

function dispatchFleetRoomResponse(
  req: import('express').Request,
  res: import('express').Response,
  gameId: string,
  ownerContent: string,
  eventSummary: string,
): void {
  const agentService = req.app.locals.agentService as AgentService | undefined;
  if (!agentService) {
    res.status(503).json({ error: 'The companion lane is not available' });
    return;
  }

  try {
    const queued = beginBattleshipCompanionResponse(gameId, ownerContent, eventSummary);
    registry.broadcast({ type: 'battleship_update', gameId });
    res.status(202).json({ game: queued.view });

    setImmediate(() => {
      void (async () => {
        let error: string | null = null;
        try {
          await agentService.processMessage(
            queued.threadId,
            queued.prompt,
            { name: 'The Fleet Room', type: 'named' },
            { platform: 'api' },
          );
        } catch (caught) {
          console.error('[Battleship] Companion turn failed:', caught);
          error = 'The line from the chart table dropped. Send another rail message to call the companions back.';
        } finally {
          finishBattleshipCompanionResponse(gameId, error);
          registry.broadcast({ type: 'battleship_update', gameId });
        }
      })();
    });
  } catch (error) {
    sendError(res, error);
  }
}

router.get('/', (req, res) => {
  try {
    const id = typeof req.query.id === 'string' ? req.query.id : undefined;
    res.json({
      game: getBattleshipView(id),
      size: BATTLESHIP_SIZE,
      fleet: BATTLESHIP_FLEET,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/new', (_req, res) => {
  try {
    res.status(201).json({ game: newBattleshipGame(), size: BATTLESHIP_SIZE, fleet: BATTLESHIP_FLEET });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/start', (req, res) => {
  try {
    const { gameId, ships } = req.body as { gameId?: string; ships?: ShipPlacement[] };
    if (!gameId || !Array.isArray(ships)) {
      res.status(400).json({ error: 'gameId and ships are required' });
      return;
    }
    res.json({ game: startBattleshipGame(gameId, ships) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/fire', (req, res) => {
  try {
    if (!req.app.locals.agentService) {
      res.status(503).json({ error: 'The companion lane is not available' });
      return;
    }
    const { gameId, coordinate } = req.body as { gameId?: string; coordinate?: string };
    if (!gameId || !coordinate) {
      res.status(400).json({ error: 'gameId and coordinate are required' });
      return;
    }
    const game = fireAtCompanionFleet(gameId, coordinate);
    const shot = game.playerShots[game.playerShots.length - 1];
    const detail = shot.ship ? ` and sent ${shot.ship} to the seafloor lounge` : '';
    dispatchFleetRoomResponse(
      req,
      res,
      gameId,
      `*calls ${shot.coordinate} across the water*`,
      `${ownerDisplayName(true)} fired at ${shot.coordinate}. The sealed companion board answered ${shot.result.toUpperCase()}${detail}.`,
    );
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/chat', (req, res) => {
  try {
    if (!req.app.locals.agentService) {
      res.status(503).json({ error: 'The companion lane is not available' });
      return;
    }
    const { gameId, content } = req.body as { gameId?: string; content?: string };
    if (!gameId || !content) {
      res.status(400).json({ error: 'gameId and content are required' });
      return;
    }
    dispatchFleetRoomResponse(
      req,
      res,
      gameId,
      content,
      `${ownerDisplayName(true)} spoke into the match rail: ${content}`,
    );
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
