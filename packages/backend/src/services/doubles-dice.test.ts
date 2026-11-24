import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createDoublesDiceStore, DICE_REWARDS } from './doubles-dice.js';

test('Doubles & Dice preserves three rounds and rolls two real dice per reward', () => {
  const db=new Database(':memory:'); const game=createDoublesDiceStore(db);
  let state=game.start('Companion A'); assert.equal(state.session?.partner,'Companion A');
  assert.equal(state.version,3);
  for(let round=1;round<=3;round++){
    state=game.begin(`My task ${round}`,`His task ${round}`);
    assert.equal(state.session?.rounds.at(-1)?.status,'working');
    const id=state.session!.rounds.at(-1)!.id;
    state=game.setRoundArtifacts(id,{taskArtifact:{kind:'letter',title:`Letter ${round}`,content:'Finished words',createdAt:1}});
    assert.equal(state.session?.rounds.at(-1)?.taskArtifact?.title,`Letter ${round}`);
    const rolled=game.roll(); const result=rolled.result;
    assert.ok(result.dieOne>=1&&result.dieOne<=6);assert.ok(result.dieTwo>=1&&result.dieTwo<=6);
    assert.equal(result.total,result.dieOne+result.dieTwo);
    assert.equal(result.reward,DICE_REWARDS[result.total]);
    state=rolled;
    state=game.setRoundArtifacts(id,{rewardArtifact:{kind:result.reward,title:`Reward ${round}`,content:'A real reward record',createdAt:2}});
    assert.equal(state.session?.rounds.at(-1)?.rewardArtifact?.kind,result.reward);
  }
  assert.equal(state.session?.status,'completed');
  assert.equal(state.session?.rounds.length,3);
  db.close();
});
