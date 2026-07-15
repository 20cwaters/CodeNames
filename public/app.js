(() => {
  'use strict';

  const socket = io();

  // Per-tab identity so multiple tabs in one browser are distinct players.
  let playerId = sessionStorage.getItem('cn_pid');
  if (!playerId) {
    playerId = 'p-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    sessionStorage.setItem('cn_pid', playerId);
  }

  const $ = (sel) => document.querySelector(sel);

  const screens = {
    home: $('#screen-home'),
    lobby: $('#screen-lobby'),
    game: $('#screen-game'),
  };

  const nameInput = $('#name-input');
  const codeInput = $('#code-input');
  const boardEl = $('#board');
  const clueAreaEl = $('#clue-area');
  const logEl = $('#log');
  const overlayEl = $('#game-overlay');

  let state = null;
  let boardKey = '';
  let clueAreaKey = '';
  let overlayDismissed = false;

  nameInput.value = localStorage.getItem('cn_name') || '';
  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) codeInput.value = urlRoom.toUpperCase().slice(0, 4);

  // ------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------

  function toast(text, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'error' ? ' error' : '');
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  function requireName() {
    const name = nameInput.value.trim();
    if (!name) {
      toast('Pick a codename first.', 'error');
      nameInput.focus();
      return null;
    }
    localStorage.setItem('cn_name', name);
    return name;
  }

  function me() {
    return state && state.players.find((p) => p.id === state.youId);
  }

  function isHost() {
    return state && state.youId === state.hostId;
  }

  function copyText(text, label) {
    const done = () => toast(label + ' copied.');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => toast(text));
    } else {
      toast(text);
    }
  }

  function esc(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function capText(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ------------------------------------------------------------------
  // socket wiring
  // ------------------------------------------------------------------

  socket.on('connect', () => {
    const savedRoom = sessionStorage.getItem('cn_room');
    if (savedRoom) {
      socket.emit('room:join', {
        playerId,
        name: localStorage.getItem('cn_name') || 'Agent',
        code: savedRoom,
        silent: true,
      });
    }
  });

  socket.on('state', (s) => {
    state = s;
    sessionStorage.setItem('cn_room', s.code);
    render();
  });

  socket.on('toast', ({ text, kind }) => toast(text, kind));

  socket.on('room:gone', () => {
    sessionStorage.removeItem('cn_room');
    state = null;
    render();
  });

  socket.on('kicked', () => {
    sessionStorage.removeItem('cn_room');
    state = null;
    render();
    toast('The host removed you from the room.', 'error');
  });

  // ------------------------------------------------------------------
  // static UI events
  // ------------------------------------------------------------------

  $('#create-btn').addEventListener('click', () => {
    const name = requireName();
    if (name) socket.emit('room:create', { playerId, name });
  });

  $('#join-btn').addEventListener('click', joinFromInput);
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinFromInput(); });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (codeInput.value.trim() ? joinFromInput : () => $('#create-btn').click())();
  });

  function joinFromInput() {
    const name = requireName();
    const code = codeInput.value.trim().toUpperCase();
    if (!name) return;
    if (code.length !== 4) {
      toast('Room codes are 4 letters.', 'error');
      codeInput.focus();
      return;
    }
    socket.emit('room:join', { playerId, name, code });
  }

  function leaveRoom() {
    socket.emit('room:leave');
    sessionStorage.removeItem('cn_room');
    state = null;
    render();
  }

  $('#lobby-leave').addEventListener('click', leaveRoom);
  $('#game-leave').addEventListener('click', leaveRoom);

  $('#copy-code').addEventListener('click', () => copyText(state.code, 'Code'));
  $('#copy-link').addEventListener('click', () =>
    copyText(`${location.origin}${location.pathname}?room=${state.code}`, 'Link'));

  $('#start-btn').addEventListener('click', () => socket.emit('game:start'));
  $('#to-lobby').addEventListener('click', () => socket.emit('game:toLobby'));

  // ------------------------------------------------------------------
  // render
  // ------------------------------------------------------------------

  function render() {
    const which = !state ? 'home' : state.game ? 'game' : 'lobby';
    for (const [name, el] of Object.entries(screens)) {
      el.classList.toggle('hidden', name !== which);
    }
    if (which === 'lobby') renderLobby();
    if (which === 'game') renderGame();
    if (which !== 'game') {
      boardKey = '';
      clueAreaKey = '';
      overlayDismissed = false;
      document.body.classList.remove('tv');
    }
  }

  // ---------------- lobby ----------------

  function renderLobby() {
    $('#lobby-code').textContent = state.code;

    for (const team of ['red', 'blue']) {
      renderTeamPanel(team);
    }

    // shared board devices (tablet / TV mode)
    const my = me();
    const boards = state.players.filter((p) => p.role === 'board');
    const tvList = $('#tv-list');
    tvList.innerHTML = '';
    if (!boards.length) {
      tvList.innerHTML = '<span class="bench-empty">No shared board yet.</span>';
    } else {
      for (const p of boards) tvList.appendChild(playerChip(p));
    }
    const tvActions = $('#tv-actions');
    tvActions.innerHTML = '';
    if (my && my.role === 'board') {
      const stop = actionBtn('Stop using this device as the board', () =>
        socket.emit('player:setTeam', { team: null }));
      stop.classList.add('ghost');
      tvActions.appendChild(stop);
    } else {
      tvActions.appendChild(actionBtn('Use this device as the board', () =>
        socket.emit('player:setTeam', { role: 'board' })));
    }

    // bench (unassigned humans)
    const bench = state.players.filter((p) => !p.team && p.role !== 'board');
    const benchEl = $('#bench-list');
    benchEl.innerHTML = '';
    if (!bench.length) {
      benchEl.innerHTML = '<span class="bench-empty">Everyone has picked a team.</span>';
    } else {
      for (const p of bench) benchEl.appendChild(playerChip(p));
    }

    // start controls
    const problems = startProblems();
    const startBtn = $('#start-btn');
    const hint = $('#start-hint');
    startBtn.classList.toggle('hidden', !isHost());
    startBtn.disabled = problems.length > 0;
    if (problems.length) {
      hint.textContent = problems[0];
    } else {
      hint.textContent = isHost() ? 'Ready when you are.' : 'Waiting for the host to start…';
    }
  }

  function startProblems() {
    const list = [];
    const hasBoard = state.players.some((p) => p.role === 'board' && p.connected);
    for (const team of ['red', 'blue']) {
      const sm = state.players.filter((p) => p.team === team && p.role === 'spymaster');
      const ops = state.players.filter((p) => p.team === team && p.role === 'operative');
      if (sm.length !== 1) list.push(`The ${team} team needs a spymaster.`);
      if (!hasBoard && ops.length < 1) list.push(`The ${team} team needs an operative — or add a shared board.`);
    }
    return list;
  }

  function playerChip(p, opts = {}) {
    const chip = document.createElement('div');
    chip.className = 'chip' + (!p.isBot && !p.connected ? ' offline' : '');
    const you = p.id === state.youId;

    let html = `<span>${esc(p.name)}</span>`;
    if (you) html += '<span class="you">(you)</span>';
    if (p.isBot) html += '<span class="tag">BOT</span>';
    if (p.id === state.hostId) html += '<span class="tag">HOST</span>';
    if (!p.isBot && !p.connected) html += '<span class="offline-note">offline</span>';
    html += '<span class="spacer"></span>';
    chip.innerHTML = html;

    if (isHost() && !state.game) {
      if (p.isBot) {
        const x = document.createElement('button');
        x.className = 'x';
        x.textContent = '×';
        x.title = 'Remove bot';
        x.addEventListener('click', () => socket.emit('bot:remove', { botId: p.id }));
        chip.appendChild(x);
      } else if (!you) {
        const x = document.createElement('button');
        x.className = 'x';
        x.textContent = '×';
        x.title = 'Remove player';
        x.addEventListener('click', () => socket.emit('player:kick', { targetId: p.id }));
        chip.appendChild(x);
      }
    }
    return chip;
  }

  function renderTeamPanel(team) {
    const panel = $('#panel-' + team);
    panel.innerHTML = '';
    const my = me();
    const spymasters = state.players.filter((p) => p.team === team && p.role === 'spymaster');
    const operatives = state.players.filter((p) => p.team === team && p.role === 'operative');

    const head = document.createElement('div');
    head.className = 'team-head';
    head.innerHTML = `<span class="team-name">${capText(team)} Team</span>
      <span class="team-count">${spymasters.length + operatives.length} member${spymasters.length + operatives.length === 1 ? '' : 's'}</span>`;
    panel.appendChild(head);

    const body = document.createElement('div');
    body.className = 'team-body';

    // spymaster slot
    const smBlock = document.createElement('div');
    smBlock.innerHTML = '<div class="slot-label">Spymaster</div>';
    const smList = document.createElement('div');
    smList.className = 'chip-list';
    if (spymasters.length) {
      for (const p of spymasters) smList.appendChild(playerChip(p));
    }
    smBlock.appendChild(smList);
    const smActions = document.createElement('div');
    smActions.className = 'slot-actions';
    if (!spymasters.length) {
      if (!(my && my.team === team && my.role === 'spymaster')) {
        smActions.appendChild(actionBtn('Take the seat', () =>
          socket.emit('player:setTeam', { team, role: 'spymaster' })));
      }
      if (isHost()) {
        smActions.appendChild(actionBtn('+ Add bot', () =>
          socket.emit('bot:add', { team, role: 'spymaster' })));
      }
    }
    smBlock.appendChild(smActions);
    body.appendChild(smBlock);

    // operatives
    const opBlock = document.createElement('div');
    opBlock.innerHTML = '<div class="slot-label">Operatives</div>';
    const opList = document.createElement('div');
    opList.className = 'chip-list';
    for (const p of operatives) opList.appendChild(playerChip(p));
    opBlock.appendChild(opList);
    const opActions = document.createElement('div');
    opActions.className = 'slot-actions';
    if (!(my && my.team === team && my.role === 'operative')) {
      opActions.appendChild(actionBtn('Join as operative', () =>
        socket.emit('player:setTeam', { team, role: 'operative' })));
    }
    if (isHost()) {
      opActions.appendChild(actionBtn('+ Add bot', () =>
        socket.emit('bot:add', { team, role: 'operative' })));
    }
    opBlock.appendChild(opActions);
    body.appendChild(opBlock);

    // leave-team option
    if (my && my.team === team) {
      const leave = actionBtn('Leave team', () =>
        socket.emit('player:setTeam', { team: null }));
      leave.classList.add('ghost');
      const wrap = document.createElement('div');
      wrap.className = 'slot-actions';
      wrap.appendChild(leave);
      body.appendChild(wrap);
    }

    panel.appendChild(body);
  }

  function actionBtn(label, onClick) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  // ---------------- game ----------------

  function canGuess() {
    const my = me();
    const g = state.game;
    if (!my || !g || g.winner || g.turn.phase !== 'guess') return false;
    if (my.role === 'board') return true; // shared screen guesses for the active team
    return my.team === g.turn.team && my.role === 'operative';
  }

  function renderGame() {
    const g = state.game;
    const my = me();
    document.body.classList.toggle('tv', !!(my && my.role === 'board'));

    $('#game-code').textContent = state.code;
    $('#score-red').textContent = g.remaining.red;
    $('#score-blue').textContent = g.remaining.blue;
    $('#to-lobby').classList.toggle('hidden', !isHost());

    renderTurnBanner();
    renderBoard();
    renderClueArea();
    renderRosters();
    renderLog();
    renderOverlay();
  }

  function renderTurnBanner() {
    const g = state.game;
    const banner = $('#turn-banner');
    const my = me();
    banner.className = 'turn-banner ' + (g.winner || g.turn.team);

    if (g.winner) {
      banner.innerHTML = `<span>${capText(g.winner)} team wins</span>`;
      return;
    }
    const t = g.turn;
    if (t.phase === 'clue') {
      const yourJob = my && my.team === t.team && my.role === 'spymaster';
      banner.innerHTML = yourJob
        ? '<span>Your move, spymaster</span><span class="sub">give your team a clue below</span>'
        : `<span>${capText(t.team)} spymaster is thinking…</span>`;
    } else {
      const yours = my && (my.role === 'board' || (my.team === t.team && my.role === 'operative'));
      const left = t.clue.count === 0 ? '∞' : t.guessesLeft;
      banner.innerHTML = yours
        ? `<span>${capText(t.team)} team is guessing</span><span class="sub">tap a card — ${left} guess${left === 1 ? '' : 'es'} left</span>`
        : `<span>${capText(t.team)} team is guessing</span><span class="sub">${left} guess${left === 1 ? '' : 'es'} left</span>`;
    }
  }

  function renderBoard() {
    const g = state.game;
    const key = g.board.map((c) => c.word).join('|');
    if (key !== boardKey) {
      boardKey = key;
      buildBoard(g);
    }
    boardEl.classList.toggle('guessing', canGuess());

    const iconFor = { red: '#i-agent', blue: '#i-agent', neutral: '#i-citizen', assassin: '#i-skull' };
    g.board.forEach((c, i) => {
      const card = boardEl.children[i];
      card.className = 'card' + (c.word.length > 8 ? ' long' : '');
      if (c.revealed) {
        card.classList.add('revealed', 't-' + c.type);
        const use = card.querySelector('use');
        if (use.getAttribute('href') !== iconFor[c.type]) use.setAttribute('href', iconFor[c.type]);
      } else if (c.type) {
        // unrevealed but the key is visible (spymaster, or game over)
        card.classList.add('key-' + c.type);
      }
    });
  }

  function buildBoard(g) {
    boardEl.innerHTML = '';
    g.board.forEach((c, i) => {
      const btn = document.createElement('button');
      btn.className = 'card';
      // stable pseudo-random tilt so cover cards look hand-placed
      btn.style.setProperty('--tilt', ((((i * 53) % 7) - 3) * 0.9).toFixed(1) + 'deg');
      btn.innerHTML = `
        <span class="word-card">
          <span class="word-top"></span>
          <span class="word-band"><span class="word"></span></span>
        </span>
        <span class="cover"><svg class="icon" aria-hidden="true"><use href="#i-citizen"/></svg></span>`;
      btn.querySelector('.word').textContent = c.word;
      btn.addEventListener('click', () => {
        if (canGuess() && !state.game.board[i].revealed) {
          socket.emit('game:guess', { index: i });
        }
      });
      boardEl.appendChild(btn);
    });
  }

  function renderClueArea() {
    const g = state.game;
    const my = me();
    const t = g.turn;
    const sig = [
      g.winner, t.phase, t.team,
      t.clue && t.clue.word, t.guessesLeft, t.guessesMade,
      my && my.team, my && my.role,
    ].join('|');
    if (sig === clueAreaKey) return;
    clueAreaKey = sig;
    clueAreaEl.innerHTML = '';

    if (g.winner) {
      const note = document.createElement('div');
      note.className = 'waiting-note';
      note.textContent = 'Game over — the full key is revealed above.';
      clueAreaEl.appendChild(note);
      return;
    }

    if (t.phase === 'clue') {
      const myJob = my && my.team === t.team && my.role === 'spymaster';
      if (myJob) {
        clueAreaEl.appendChild(buildClueForm());
      } else {
        const note = document.createElement('div');
        note.className = 'waiting-note';
        note.textContent = `Waiting for the ${t.team} spymaster to give a clue…`;
        clueAreaEl.appendChild(note);
      }
      return;
    }

    // guess phase — show the clue
    const wrap = document.createElement('div');
    wrap.className = 'clue-display';
    const chip = document.createElement('div');
    chip.className = 'clue-chip ' + t.team;
    chip.innerHTML = `<span class="clue-word">${esc(t.clue.word)}</span>
      <span class="clue-count">· ${t.clue.count === 0 ? '∞' : t.clue.count}</span>`;
    wrap.appendChild(chip);

    if (my && ((my.team === t.team && my.role === 'operative') || my.role === 'board')) {
      const end = document.createElement('button');
      end.className = 'btn';
      end.textContent = 'End turn';
      end.disabled = t.guessesMade < 1;
      end.title = t.guessesMade < 1 ? 'You must guess at least once' : '';
      end.addEventListener('click', () => socket.emit('game:endTurn'));
      wrap.appendChild(end);
    } else if (my && my.team === t.team && my.role === 'spymaster') {
      const note = document.createElement('span');
      note.className = 'clue-note';
      note.textContent = 'Keep a straight face while they guess.';
      wrap.appendChild(note);
    }
    clueAreaEl.appendChild(wrap);
  }

  function buildClueForm() {
    const form = document.createElement('form');
    form.className = 'clue-form';

    const input = document.createElement('input');
    input.placeholder = 'ONE WORD';
    input.maxLength = 20;
    input.autocomplete = 'off';
    input.spellcheck = false;

    const select = document.createElement('select');
    for (let n = 1; n <= 9; n++) {
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = n;
      select.appendChild(opt);
    }
    const inf = document.createElement('option');
    inf.value = 0;
    inf.textContent = '∞ (0)';
    select.appendChild(inf);

    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.type = 'submit';
    btn.textContent = 'Give clue';

    form.append(input, select, btn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const word = input.value.trim();
      if (!word) return toast('Type a clue word.', 'error');
      if (/\s/.test(word)) return toast('Clues must be a single word.', 'error');
      socket.emit('game:clue', { word, count: Number(select.value) });
    });
    setTimeout(() => input.focus(), 50);
    return form;
  }

  function renderRosters() {
    const my = me();
    const rostersEl = $('#rosters');
    rostersEl.innerHTML = '';

    for (const team of ['red', 'blue']) {
      const div = document.createElement('div');
      div.className = 'roster-team ' + team;
      div.innerHTML = `<div class="roster-head">${capText(team)} team</div>`;
      const members = state.players
        .filter((p) => p.team === team)
        .sort((a, b) => (a.role === 'spymaster' ? -1 : 1) - (b.role === 'spymaster' ? -1 : 1));
      for (const p of members) {
        const row = document.createElement('div');
        row.className = 'roster-row'
          + (!p.isBot && !p.connected ? ' offline' : '')
          + (p.id === state.youId ? ' me' : '');
        row.innerHTML = `<span class="role-mark">${p.role === 'spymaster' ? '◆ SPY' : '· OP'}</span>
          <span>${esc(p.name)}</span>${p.isBot ? '<span class="tag">BOT</span>' : ''}`;
        div.appendChild(row);
      }
      if (!members.length) {
        div.innerHTML += '<div class="roster-row offline"><span>—</span></div>';
      }
      rostersEl.appendChild(div);
    }

    if (state.players.some((p) => p.role === 'board' && p.connected)) {
      const note = document.createElement('div');
      note.className = 'roster-row';
      note.innerHTML = '<span class="role-mark">▣ TV</span><span>Shared board connected</span>';
      rostersEl.appendChild(note);
    }

    // spectators can slot in mid-game as operatives
    if (my && !my.team && my.role !== 'board' && !state.game.winner) {
      const join = document.createElement('div');
      join.className = 'join-mid';
      for (const team of ['red', 'blue']) {
        const b = actionBtn(`Join ${team}`, () =>
          socket.emit('player:setTeam', { team, role: 'operative' }));
        b.classList.add('tiny');
        join.appendChild(b);
      }
      rostersEl.appendChild(join);
    }
  }

  function renderLog() {
    const g = state.game;
    const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    logEl.innerHTML = '';
    for (const entry of g.log) {
      const div = document.createElement('div');
      div.className = 'log-entry ' + (entry.team || '') + ' ' + entry.kind;
      const prefix = entry.team ? `<span class="who">[${entry.team.toUpperCase()}]</span> ` : '';
      div.innerHTML = prefix + esc(entry.text);
      logEl.appendChild(div);
    }
    if (nearBottom || logEl.children.length <= 3) logEl.scrollTop = logEl.scrollHeight;
  }

  function renderOverlay() {
    const g = state.game;
    if (!g.winner) {
      overlayDismissed = false;
      overlayEl.classList.add('hidden');
      return;
    }
    if (overlayDismissed) {
      overlayEl.classList.add('hidden');
      return;
    }
    overlayEl.classList.remove('hidden');
    overlayEl.innerHTML = '';

    const card = document.createElement('div');
    card.className = 'overlay-card';

    const stamp = document.createElement('div');
    stamp.className = 'win-stamp ' + g.winner;
    stamp.textContent = `${g.winner.toUpperCase()} WINS`;
    card.appendChild(stamp);

    const reason = document.createElement('div');
    reason.className = 'win-reason';
    reason.textContent = g.winReason;
    card.appendChild(reason);

    const actions = document.createElement('div');
    actions.className = 'overlay-actions';

    const view = document.createElement('button');
    view.className = 'btn ghost';
    view.textContent = 'View the board';
    view.addEventListener('click', () => {
      overlayDismissed = true;
      overlayEl.classList.add('hidden');
    });
    actions.appendChild(view);

    if (isHost()) {
      const again = document.createElement('button');
      again.className = 'btn primary';
      again.textContent = 'Play again';
      again.addEventListener('click', () => socket.emit('game:rematch'));
      actions.appendChild(again);

      const lobby = document.createElement('button');
      lobby.className = 'btn';
      lobby.textContent = 'Back to lobby';
      lobby.addEventListener('click', () => socket.emit('game:toLobby'));
      actions.appendChild(lobby);
    } else {
      const wait = document.createElement('div');
      wait.className = 'win-reason';
      wait.textContent = 'Waiting for the host to start a rematch…';
      actions.appendChild(wait);
    }

    card.appendChild(actions);
    overlayEl.appendChild(card);
  }

  render();
})();
