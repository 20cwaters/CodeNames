'use strict';

const WORDS = require('./words');

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function otherTeam(team) {
  return team === 'red' ? 'blue' : 'red';
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function createGame() {
  const startingTeam = Math.random() < 0.5 ? 'red' : 'blue';
  const words = shuffle([...WORDS]).slice(0, 25);
  const types = shuffle([
    ...Array(9).fill(startingTeam),
    ...Array(8).fill(otherTeam(startingTeam)),
    ...Array(7).fill('neutral'),
    'assassin',
  ]);
  return {
    board: words.map((word, i) => ({ word, type: types[i], revealed: false, revealedByTeam: null })),
    startingTeam,
    turn: { team: startingTeam, phase: 'clue', clue: null, guessesLeft: 0, guessesMade: 0 },
    winner: null,
    winReason: null,
    log: [{ team: startingTeam, kind: 'info', text: `${cap(startingTeam)} team goes first with 9 agents to find.` }],
    actionSeq: 0,
  };
}

function remainingFor(game, team) {
  return game.board.filter((c) => c.type === team && !c.revealed).length;
}

function addLog(game, entry) {
  game.log.push(entry);
  if (game.log.length > 200) game.log.shift();
}

function nextTurn(game) {
  game.turn = { team: otherTeam(game.turn.team), phase: 'clue', clue: null, guessesLeft: 0, guessesMade: 0 };
}

function giveClue(game, team, byName, word, count) {
  if (game.winner) return { error: 'The game is over.' };
  const t = game.turn;
  if (t.team !== team || t.phase !== 'clue') return { error: "It isn't your turn to give a clue." };
  const w = String(word || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9'-]{0,19}$/.test(w)) {
    return { error: 'Clues must be a single word — letters only, up to 20 characters.' };
  }
  const n = Number(count);
  if (!Number.isInteger(n) || n < 0 || n > 9) return { error: 'The clue number must be between 0 and 9.' };
  if (game.board.some((c) => !c.revealed && c.word.toUpperCase() === w)) {
    return { error: "Your clue can't be a word that is still on the board." };
  }
  t.clue = { word: w, count: n };
  t.phase = 'guess';
  t.guessesLeft = n === 0 ? 25 : n + 1; // 0 means unlimited guesses
  t.guessesMade = 0;
  game.actionSeq++;
  addLog(game, { team, kind: 'clue', text: `${byName} gives the clue ${w} · ${n === 0 ? '∞' : n}` });
  return {};
}

function makeGuess(game, team, byName, index) {
  if (game.winner) return { error: 'The game is over.' };
  const t = game.turn;
  if (t.team !== team || t.phase !== 'guess') return { error: "It isn't your team's turn to guess." };
  const card = game.board[index];
  if (!card) return { error: 'Invalid card.' };
  if (card.revealed) return { error: 'That card was already revealed.' };

  card.revealed = true;
  card.revealedByTeam = team;
  t.guessesMade++;
  game.actionSeq++;
  const enemy = otherTeam(team);

  if (card.type === 'assassin') {
    game.winner = enemy;
    game.winReason = `${cap(team)} team uncovered the assassin.`;
    addLog(game, { team, kind: 'assassin', text: `${byName} turns over ${card.word} — the ASSASSIN.` });
    addLog(game, { team: enemy, kind: 'win', text: `${cap(enemy)} team wins!` });
    return {};
  }

  if (card.type === team) {
    addLog(game, { team, kind: 'hit', text: `${byName} turns over ${card.word} — a ${team} agent.` });
    if (remainingFor(game, team) === 0) {
      game.winner = team;
      game.winReason = `${cap(team)} team contacted all of their agents.`;
      addLog(game, { team, kind: 'win', text: `${cap(team)} team wins!` });
      return {};
    }
    t.guessesLeft--;
    if (t.guessesLeft <= 0) nextTurn(game);
    return {};
  }

  // Wrong card: bystander or enemy agent — turn ends.
  const label = card.type === 'neutral' ? 'an innocent bystander' : `a ${card.type.toUpperCase()} agent`;
  addLog(game, { team, kind: 'miss', text: `${byName} turns over ${card.word} — ${label}.` });
  if (card.type === enemy && remainingFor(game, enemy) === 0) {
    game.winner = enemy;
    game.winReason = `${cap(enemy)} team's last agent was found for them.`;
    addLog(game, { team: enemy, kind: 'win', text: `${cap(enemy)} team wins!` });
    return {};
  }
  nextTurn(game);
  return {};
}

function endTurn(game, team, byName) {
  if (game.winner) return { error: 'The game is over.' };
  const t = game.turn;
  if (t.team !== team || t.phase !== 'guess') return { error: "It isn't your team's turn." };
  if (t.guessesMade < 1) return { error: 'Your team must make at least one guess first.' };
  game.actionSeq++;
  addLog(game, { team, kind: 'end', text: `${byName} ends the turn.` });
  nextTurn(game);
  return {};
}

module.exports = { createGame, giveClue, makeGuess, endTurn, remainingFor, otherTeam, cap };
