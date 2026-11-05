import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSugoroku, seeded } from './helpers.mjs';

const S = loadSugoroku();

function newGame(names = ['あ', 'い', 'う'], size = 16, difficulty = 'normal', seed = 1) {
  return S.createGame({ size, difficulty, names, rng: seeded(seed) });
}

/** テスト用: 指定プレイヤーを指定位置に置いた状態を返す。 */
function at(state, positions) {
  const s = structuredClone(state);
  positions.forEach((p, i) => { s.players[i].pos = p; });
  return s;
}

test('createGame: 全員が START(0) にいて、最初の手番は0、phase は play', () => {
  const g = newGame();
  assert.equal(g.size, 16);
  assert.equal(g.difficulty, 'normal');
  assert.equal(g.board.length, 16);
  assert.equal(g.players.length, 3);
  for (const p of g.players) {
    assert.equal(p.pos, 0);
    assert.equal(p.rank, null);
  }
  assert.equal(g.turn, 0);
  assert.equal(g.phase, 'play');
  assert.equal(g.nextRank, 1);
  assert.equal(g.lastMove, null);
});

test('createGame: 名前は trim し、空なら「プレイヤーN」、色は人ごとに違う', () => {
  const g = newGame(['  太郎 ', '', '   ']);
  assert.deepEqual(g.players.map((p) => p.name), ['太郎', 'プレイヤー2', 'プレイヤー3']);
  assert.equal(new Set(g.players.map((p) => p.color)).size, 3);
});

test('createGame: 人数は2〜8人、マス数・難易度は定義済みのもののみ', () => {
  assert.throws(() => newGame(['a']));
  assert.throws(() => newGame(['1', '2', '3', '4', '5', '6', '7', '8', '9']));
  assert.throws(() => newGame(['a', 'b'], 20));
  assert.throws(() => newGame(['a', 'b'], 16, 'ultra'));
  assert.doesNotThrow(() => newGame(['a', 'b']));
  assert.doesNotThrow(() => newGame(['1', '2', '3', '4', '5', '6', '7', '8']));
});

test('applyRoll: 通常の移動は出目ぶん進み、通過マスが path に入る', () => {
  const g = newGame();
  const next = S.applyRoll(g, 4);
  assert.equal(next.players[0].pos, 4);
  assert.deepEqual(next.lastMove, {
    player: 0, roll: 4, from: 0, to: 4, path: [1, 2, 3, 4], bounced: false, finished: false,
  });
  assert.equal(next.turn, 0, '指令カードを見せるまで手番は進めない');
  assert.equal(g.players[0].pos, 0, '元の状態を変更しない');
  assert.equal(g.lastMove, null);
});

test('applyRoll: 2人目の手番ならその人が動く', () => {
  const g = { ...newGame(), turn: 1 };
  const next = S.applyRoll(g, 2);
  assert.equal(next.players[0].pos, 0);
  assert.equal(next.players[1].pos, 2);
  assert.equal(next.lastMove.player, 1);
});

test('applyRoll: ぴったりゴールで順位が付く', () => {
  const g = at(newGame(), [12, 0, 0]); // goal = 15
  const next = S.applyRoll(g, 3);
  assert.equal(next.players[0].pos, 15);
  assert.equal(next.players[0].rank, 1);
  assert.equal(next.nextRank, 2);
  assert.equal(next.lastMove.finished, true);
  assert.equal(next.lastMove.bounced, false);
});

test('applyRoll: ゴールを超えたら超えた分だけ折り返して戻る', () => {
  const g = at(newGame(), [13, 0, 0]); // 13 + 5 = 18 → 15 - 3 = 12
  const next = S.applyRoll(g, 5);
  assert.equal(next.players[0].pos, 12);
  assert.equal(next.players[0].rank, null);
  assert.deepEqual(next.lastMove.path, [14, 15, 14, 13, 12]);
  assert.equal(next.lastMove.bounced, true);
  assert.equal(next.lastMove.finished, false);
});

test('applyRoll: 1だけ超えたらゴールの1つ手前に戻る', () => {
  const g = at(newGame(), [14, 0, 0]);
  const next = S.applyRoll(g, 2);
  assert.equal(next.players[0].pos, 14);
  assert.deepEqual(next.lastMove.path, [15, 14]);
  assert.equal(next.lastMove.bounced, true);
});

test('applyRoll: 2人目以降のゴールは次の順位になる', () => {
  let g = at(newGame(), [15, 10, 0]);
  g.players[0].rank = 1;
  g.nextRank = 2;
  g.turn = 1;
  g = S.applyRoll(g, 5);
  assert.equal(g.players[1].rank, 2);
  assert.equal(g.nextRank, 3);
});

test('applyRoll: 出目は1〜6、ゴール済みの人や終了後は振れない', () => {
  const g = newGame();
  assert.throws(() => S.applyRoll(g, 0));
  assert.throws(() => S.applyRoll(g, 7));
  const done = at(newGame(), [15, 0, 0]);
  done.players[0].rank = 1;
  assert.throws(() => S.applyRoll(done, 1));
  assert.throws(() => S.applyRoll({ ...newGame(), phase: 'result' }, 1));
});

test('endTurn: 次の人へ進み、最後の人の次は最初に戻る', () => {
  let g = newGame();
  g = S.endTurn(S.applyRoll(g, 1));
  assert.equal(g.turn, 1);
  assert.equal(g.lastMove, null);
  g = S.endTurn(S.applyRoll(g, 1));
  assert.equal(g.turn, 2);
  g = S.endTurn(S.applyRoll(g, 1));
  assert.equal(g.turn, 0);
});

test('endTurn: ゴール済みの人は飛ばす', () => {
  let g = at(newGame(), [0, 15, 0]);
  g.players[1].rank = 1;
  g.nextRank = 2;
  g = S.endTurn(S.applyRoll(g, 1));
  assert.equal(g.turn, 2);
});

test('endTurn: 残り1人でもその人が振り続け、全員ゴールで result になる', () => {
  let g = at(newGame(), [15, 15, 10]);
  g.players[0].rank = 1;
  g.players[1].rank = 2;
  g.nextRank = 3;
  g.turn = 2;
  g = S.endTurn(S.applyRoll(g, 2)); // 12
  assert.equal(g.phase, 'play');
  assert.equal(g.turn, 2);
  g = S.endTurn(S.applyRoll(g, 3)); // 15 = goal
  assert.equal(g.phase, 'result');
  assert.equal(g.players[2].rank, 3);
});

test('finishEarly: 未ゴールの人は位置の遠い順(同位置は手番順)で残りの順位に入る', () => {
  let g = at(newGame(['a', 'b', 'c', 'd'], 16), [15, 3, 9, 9]);
  g.players[0].rank = 1;
  g.nextRank = 2;
  g = S.finishEarly(g);
  assert.equal(g.phase, 'result');
  assert.deepEqual(g.players.map((p) => p.rank), [1, 4, 2, 3]);
});

test('ranking: 順位順にプレイヤーを返す', () => {
  let g = at(newGame(['a', 'b', 'c'], 16), [15, 15, 15]);
  g.players[0].rank = 3;
  g.players[1].rank = 1;
  g.players[2].rank = 2;
  assert.deepEqual(S.ranking(g).map((p) => p.name), ['b', 'c', 'a']);
});

test('状態は JSON で保存・復元しても同じように動く', () => {
  const g = at(newGame(), [13, 0, 0]);
  const restored = JSON.parse(JSON.stringify(g));
  assert.deepEqual(S.applyRoll(restored, 5), S.applyRoll(g, 5));
});

test('CHARACTERS: 12体あり、id と名前が一意', () => {
  assert.equal(S.CHARACTERS.length, 12);
  assert.equal(new Set(S.CHARACTERS.map((c) => c.id)).size, 12);
  assert.equal(new Set(S.CHARACTERS.map((c) => c.name)).size, 12);
  for (const c of S.CHARACTERS) assert.ok(c.id && c.name);
});

test('createGame: キャラ未指定なら先頭から順に重複なく割り当てる', () => {
  const g = newGame(['a', 'b', 'c']);
  assert.deepEqual(g.players.map((p) => p.char), S.CHARACTERS.slice(0, 3).map((c) => c.id));
});

test('createGame: 指定したキャラが各プレイヤーに入る', () => {
  const g = S.createGame({ size: 16, difficulty: 'normal', names: ['a', 'b'], chars: ['kappa', 'akaoni'], rng: seeded(1) });
  assert.deepEqual(g.players.map((p) => p.char), ['kappa', 'akaoni']);
});

test('createGame: キャラの重複・不明な id・人数不一致は例外', () => {
  const base = { size: 16, difficulty: 'normal', names: ['a', 'b'], rng: seeded(1) };
  assert.throws(() => S.createGame({ ...base, chars: ['kappa', 'kappa'] }));
  assert.throws(() => S.createGame({ ...base, chars: ['kappa', 'dragon'] }));
  assert.throws(() => S.createGame({ ...base, chars: ['kappa'] }));
});
