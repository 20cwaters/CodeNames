'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const { createGame, giveClue, makeGuess, endTurn, remainingFor, cap } = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;

/** rooms: code -> room
 * room = {
 *   code, hostId, players: Map<playerId, player>, game, botCounter, botTimer, lastActive
 * }
 * player = { id, name, team, role, isBot, connected, socketId }
 */
const rooms = new Map();

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const BOT_NAMES = ['Sable', 'Vesper', 'Onyx', 'Juniper', 'Marlow', 'Quill', 'Harrier', 'Nettle', 'Wren', 'Cobalt', 'Larkspur', 'Tamsin'];
const BOT_CLUES = [
  'CIPHER', 'ZENITH', 'MOSAIC', 'TEMPO', 'SAFFRON', 'MERIDIAN', 'TUNDRA', 'EMBER', 'QUARTZ', 'BALLAD',
  'HARVEST', 'ORCHID', 'PISTON', 'SONNET', 'GLIMMER', 'FABLE', 'LAGOON', 'BREEZE', 'RELIC', 'VOYAGER',
  'CINDER', 'PARLOR', 'MIRAGE', 'GROTTO', 'BANQUET', 'SCARLET', 'HERALD', 'RAPIDS', 'BEACON', 'TWINE',
];

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(raw) {
  const name = String(raw || '').replace(/[^\S ]/g, '').trim().slice(0, 18);
  return name || 'Agent';
}

function fail(socket, text) {
  socket.emit('toast', { kind: 'error', text });
}

function getRoom(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}

function getPlayer(room, socket) {
  return room ? room.players.get(socket.data.playerId) : null;
}

function teamMembers(room, team, role) {
  return [...room.players.values()].filter((p) => p.team === team && (!role || p.role === role));
}

function statePayload(room, viewer) {
  const g = room.game;
  const isSpymaster = viewer && viewer.role === 'spymaster';
  const revealAll = g && !!g.winner;
  return {
    code: room.code,
    hostId: room.hostId,
    youId: viewer ? viewer.id : null,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, team: p.team, role: p.role, isBot: p.isBot, connected: p.connected,
    })),
    game: g
      ? {
          startingTeam: g.startingTeam,
          turn: g.turn,
          winner: g.winner,
          winReason: g.winReason,
          remaining: { red: remainingFor(g, 'red'), blue: remainingFor(g, 'blue') },
          log: g.log,
          board: g.board.map((c) => ({
            word: c.word,
            revealed: c.revealed,
            type: c.revealed || isSpymaster || revealAll ? c.type : null,
          })),
        }
      : null,
  };
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const p of room.players.values()) {
    if (!p.isBot && p.connected && p.socketId) {
      io.to(p.socketId).emit('state', statePayload(room, p));
    }
  }
}

function transferHost(room) {
  const current = room.players.get(room.hostId);
  if (current && current.connected && !current.isBot) return;
  const next = [...room.players.values()].find((p) => !p.isBot && p.connected);
  if (next) room.hostId = next.id;
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

function scheduleBots(room) {
  if (room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
  }
  const g = room.game;
  if (!g || g.winner) return;
  const seq = g.actionSeq;
  const team = g.turn.team;

  if (g.turn.phase === 'clue') {
    const sm = teamMembers(room, team, 'spymaster')[0];
    if (sm && sm.isBot) {
      room.botTimer = setTimeout(() => botClue(room, seq), 1500 + Math.random() * 1500);
    }
  } else {
    const ops = teamMembers(room, team, 'operative');
    const boardConnected = [...room.players.values()].some((p) => p.role === 'board' && p.connected);
    const humanAtTable = boardConnected || ops.some((p) => !p.isBot && p.connected);
    if (!humanAtTable && ops.some((p) => p.isBot)) {
      room.botTimer = setTimeout(() => botGuess(room, seq), 1300 + Math.random() * 1300);
    }
  }
}

function botStale(room, seq) {
  const g = room.game;
  return !g || g.winner || g.actionSeq !== seq;
}

function botClue(room, seq) {
  if (botStale(room, seq) || room.game.turn.phase !== 'clue') return;
  const g = room.game;
  const team = g.turn.team;
  const sm = teamMembers(room, team, 'spymaster')[0];
  if (!sm || !sm.isBot) return;
  const onBoard = new Set(g.board.filter((c) => !c.revealed).map((c) => c.word));
  const options = BOT_CLUES.filter((w) => !onBoard.has(w));
  const word = options[Math.floor(Math.random() * options.length)] || 'SIGNAL';
  const count = Math.max(1, Math.min(remainingFor(g, team), 1 + Math.floor(Math.random() * 3)));
  giveClue(g, team, sm.name, word, count);
  broadcast(room);
  scheduleBots(room);
}

function botGuess(room, seq) {
  if (botStale(room, seq) || room.game.turn.phase !== 'guess') return;
  const g = room.game;
  const team = g.turn.team;
  const bot = teamMembers(room, team, 'operative').find((p) => p.isBot);
  if (!bot) return;

  // Bots rarely take the bonus guess, and occasionally bank their remaining ones.
  const onBonusGuess = g.turn.clue.count > 0 && g.turn.guessesLeft === 1;
  if (g.turn.guessesMade >= 1 && (onBonusGuess ? Math.random() < 0.75 : Math.random() < 0.1)) {
    endTurn(g, team, bot.name);
    broadcast(room);
    scheduleBots(room);
    return;
  }

  // Practice bots peek at the key so games actually progress: ~72% correct,
  // otherwise a miss that is only rarely the assassin.
  const unrevealed = g.board.map((c, i) => ({ c, i })).filter((x) => !x.c.revealed);
  const own = unrevealed.filter((x) => x.c.type === team);
  const misses = unrevealed.filter((x) => x.c.type !== team && x.c.type !== 'assassin');
  const assassin = unrevealed.find((x) => x.c.type === 'assassin');

  let pick;
  if (own.length && Math.random() < 0.72) {
    pick = own[Math.floor(Math.random() * own.length)];
  } else if (assassin && Math.random() < 0.06) {
    pick = assassin;
  } else if (misses.length) {
    pick = misses[Math.floor(Math.random() * misses.length)];
  } else {
    pick = own[0] || assassin;
  }
  if (!pick) return;

  makeGuess(g, team, bot.name, pick.i);
  broadcast(room);
  scheduleBots(room);
}

// ---------------------------------------------------------------------------
// Socket handlers
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  socket.on('room:create', ({ playerId, name } = {}) => {
    if (!playerId) return;
    const code = makeCode();
    const player = {
      id: playerId, name: cleanName(name), team: null, role: null,
      isBot: false, connected: true, socketId: socket.id,
    };
    const room = {
      code, hostId: playerId, players: new Map([[playerId, player]]),
      game: null, botCounter: 0, botTimer: null, lastActive: Date.now(),
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = playerId;
    broadcast(room);
  });

  socket.on('room:join', ({ playerId, name, code, silent } = {}) => {
    if (!playerId) return;
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) {
      if (silent) socket.emit('room:gone');
      else fail(socket, 'No room with that code. Check it and try again.');
      return;
    }
    let player = room.players.get(playerId);
    if (player) {
      // Reconnecting (refresh, dropped connection)
      player.connected = true;
      player.socketId = socket.id;
      if (!silent) player.name = cleanName(name);
    } else {
      player = {
        id: playerId, name: cleanName(name), team: null, role: null,
        isBot: false, connected: true, socketId: socket.id,
      };
      room.players.set(playerId, player);
    }
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = playerId;
    transferHost(room);
    broadcast(room);
    scheduleBots(room);
  });

  socket.on('player:setTeam', ({ team, role } = {}) => {
    const room = getRoom(socket);
    const player = getPlayer(room, socket);
    if (!room || !player) return;

    if (role === 'board') {
      // Shared tablet/TV screen: teamless, sees no key, guesses for whichever team is up.
      if (room.game && !room.game.winner && player.team) {
        return fail(socket, "You can't become the shared board while on a team mid-game.");
      }
      player.team = null;
      player.role = 'board';
      broadcast(room);
      scheduleBots(room);
      return;
    }

    if (team === null) {
      if (room.game && !room.game.winner && player.team) {
        return fail(socket, "You can't leave your team mid-game.");
      }
      player.team = null;
      player.role = null;
      broadcast(room);
      scheduleBots(room);
      return;
    }
    if (!['red', 'blue'].includes(team) || !['spymaster', 'operative'].includes(role)) {
      return fail(socket, 'That team change was not recognized — the server may need a restart.');
    }

    if (room.game && !room.game.winner) {
      // Mid-game: only unassigned players may slot in, and only as operatives.
      if (player.team) return fail(socket, "You can't switch teams mid-game.");
      if (role !== 'operative') return fail(socket, 'You can only join as an operative mid-game.');
    }
    if (role === 'spymaster') {
      const existing = teamMembers(room, team, 'spymaster').find((p) => p.id !== player.id);
      if (existing) return fail(socket, `${existing.name} is already the ${team} spymaster.`);
    }
    player.team = team;
    player.role = role;
    broadcast(room);
    scheduleBots(room);
  });

  socket.on('bot:add', ({ team, role } = {}) => {
    const room = getRoom(socket);
    const player = getPlayer(room, socket);
    if (!room || !player) return;
    if (player.id !== room.hostId) return fail(socket, 'Only the host can add bots.');
    if (room.game) return fail(socket, 'Bots can only be added in the lobby.');
    if (!['red', 'blue'].includes(team) || !['spymaster', 'operative'].includes(role)) return;
    if (role === 'spymaster' && teamMembers(room, team, 'spymaster').length) {
      return fail(socket, 'That team already has a spymaster.');
    }
    const used = new Set([...room.players.values()].map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `Unit ${++room.botCounter + 100}`;
    const id = `bot-${++room.botCounter}-${Date.now()}`;
    room.players.set(id, { id, name, team, role, isBot: true, connected: true, socketId: null });
    broadcast(room);
  });

  socket.on('bot:remove', ({ botId } = {}) => {
    const room = getRoom(socket);
    const player = getPlayer(room, socket);
    if (!room || !player) return;
    if (player.id !== room.hostId) return fail(socket, 'Only the host can remove bots.');
    if (room.game) return fail(socket, 'Bots can only be removed in the lobby.');
    const bot = room.players.get(botId);
    if (bot && bot.isBot) {
      room.players.delete(botId);
      broadcast(room);
    }
  });

  socket.on('player:kick', ({ targetId } = {}) => {
    const room = getRoom(socket);
    const player = getPlayer(room, socket);
    if (!room || !player) return;
    if (player.id !== room.hostId) return fail(socket, 'Only the host can remove players.');
    if (room.game) return fail(socket, 'Players can only be removed in the lobby.');
    const target = room.players.get(targetId);
    if (!target || target.isBot || target.id === room.hostId) return;
    room.players.delete(targetId);
    if (target.socketId) io.to(target.socketId).emit('kicked');
    broadcast(room);
  });

  socket.on('game:start', () => {
    const room = getRoom(socket);
    const player = getPlayer(room, socket);
    if (!room || !player) return;
    if (player.id !== room.hostId) return fail(socket, 'Only the host can start the game.');
    if (room.game && !room.game.winner) return;
    const hasBoard = [...room.players.values()].some((p) => p.role === 'board' && p.connected);
    for (const team of ['red', 'blue']) {
      if (teamMembers(room, team, 'spymaster').length !== 1) {
        return fail(socket, `The ${team} team needs a spymaster.`);
      }
      if (!hasBoard && teamMembers(room, team, 'operative').length < 1) {
        return fail(socket, `The ${team} team needs at least one operative — or add a shared board.`);
      }
    }
    room.game = createGame();
    broadcast(room);
    scheduleBots(room);
  });

  socket.on('game:clue', ({ word, count } = {}) => {
    const room = getRoom(socket);
    const player = getPlayer(room, socket);
    if (!room || !player || !room.game) return;
    if (player.role !== 'spymaster') return fail(socket, 'Only the spymaster gives clues.');
    const result = giveClue(room.game, player.team, player.name, word, count);
    if (result.error) return fail(socket, result.error);
    broadcast(room);
    scheduleBots(room);
  });

  socket.on('game:guess', ({ index } = {}) => {
    const room = getRoom(socket);
    const player = getPlayer(room, socket);
    if (!room || !player || !room.game) return;
    const isBoard = player.role === 'board';
    if (!isBoard && player.role !== 'operative') return fail(socket, 'Only operatives can guess.');
    const team = isBoard ? room.game.turn.team : player.team;
    const byName = isBoard ? `${cap(team)} team` : player.name;
    const result = makeGuess(room.game, team, byName, Number(index));
    if (result.error) return fail(socket, result.error);
    broadcast(room);
    scheduleBots(room);
  });

  socket.on('game:endTurn', () => {
    const room = getRoom(socket);
    const player = getPlayer(room, socket);
    if (!room || !player || !room.game) return;
    const isBoard = player.role === 'board';
    if (!isBoard && player.role !== 'operative') return fail(socket, 'Only operatives can end the turn.');
    const team = isBoard ? room.game.turn.team : player.team;
    const byName = isBoard ? `${cap(team)} team` : player.name;
    const result = endTurn(room.game, team, byName);
    if (result.error) return fail(socket, result.error);
    broadcast(room);
    scheduleBots(room);
  });

  socket.on('game:rematch', () => {
    const room = getRoom(socket);
    const player = getPlayer(room, socket);
    if (!room || !player) return;
    if (player.id !== room.hostId) return fail(socket, 'Only the host can start a rematch.');
    if (!room.game || !room.game.winner) return;
    room.game = createGame();
    broadcast(room);
    scheduleBots(room);
  });

  socket.on('game:toLobby', () => {
    const room = getRoom(socket);
    const player = getPlayer(room, socket);
    if (!room || !player) return;
    if (player.id !== room.hostId) return fail(socket, 'Only the host can end the game.');
    if (!room.game) return;
    if (room.botTimer) clearTimeout(room.botTimer);
    room.botTimer = null;
    room.game = null;
    broadcast(room);
  });

  socket.on('room:leave', () => {
    const room = getRoom(socket);
    const player = getPlayer(room, socket);
    socket.data.roomCode = null;
    if (!room || !player) return;
    socket.leave(room.code);
    if (room.game && !room.game.winner) {
      player.connected = false;
      player.socketId = null;
    } else {
      room.players.delete(player.id);
    }
    transferHost(room);
    broadcast(room);
    scheduleBots(room);
  });

  socket.on('disconnect', () => {
    const room = getRoom(socket);
    const player = getPlayer(room, socket);
    if (!room || !player) return;
    player.connected = false;
    player.socketId = null;
    transferHost(room);
    broadcast(room);
    scheduleBots(room);
  });
});

// Sweep rooms that have had no connected humans for 15 minutes.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const humansOnline = [...room.players.values()].some((p) => !p.isBot && p.connected);
    if (!humansOnline && now - room.lastActive > 15 * 60 * 1000) {
      if (room.botTimer) clearTimeout(room.botTimer);
      rooms.delete(code);
    }
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`Codenames is running → http://localhost:${PORT}`);
});
