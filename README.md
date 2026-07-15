# Codenames

A real-time multiplayer Codenames web app: create a room, share the 4-letter code, pick teams and roles, and play a full game. Includes practice bots so you can test (or play) solo.

## Run it

```
npm install
npm start
```

Then open http://localhost:3000. Anyone on your network can join at `http://<your-LAN-IP>:3000` with the room code.

## How it works

- **server/index.js** — Express + Socket.IO server: rooms, players, reconnection, host powers, and the bot engine. The key card never leaves the server except to spymasters, so operatives can't peek via devtools.
- **server/game.js** — pure game rules: board generation (9/8/7/1 split), clue validation, guessing, turn flow, win conditions.
- **server/words.js** — the board vocabulary.
- **public/** — vanilla JS single-page client with a vintage-dossier look.

## Rules implemented

- Starting team is random and gets 9 agents; the other team gets 8.
- Spymasters give a one-word clue plus a number (0 = unlimited guesses).
- Clues can't be a word still visible on the board.
- Operatives get clue-number + 1 guesses; a wrong guess ends the turn; the assassin ends the game.
- A team also wins if the opposing team reveals that team's last agent for them.
- Teams must make at least one guess per turn before ending it.

## Tablet / TV mode (shared board)

For groups sitting around one table: open the site on a tablet or TV, join the room, and pick **"Use this device as the board"** in the lobby. That device gets a full-screen board with no sidebars; anyone at the table taps it to guess for whichever team's turn it is, and can end the turn from it. Spymasters join from their own phones (they still see the key privately). When a shared board is connected, teams don't need separate operative players, and bot operatives stay quiet.

## Bots

The host can add bot spymasters and bot operatives from the lobby. Bots exist for testing and solo play:

- Bot spymasters give a random (non-board) clue word with a plausible count.
- Bot operatives peek at the key so games progress: they guess correctly ~72% of the time, rarely hit the assassin, and usually skip the bonus guess.
- Bot operatives only act when no connected human operative is on their team, so a human teammate always keeps control.
