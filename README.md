# Bacteria

A two-player bacteria game in the browser. One Rust binary serves the page and runs the games.

- **Play with a friend**: create a game, share the link, it starts when they open it (like Lichess).
- **Play the computer**: easy, medium or hard.
- **Pass and play**: two players on the same screen.

## Rules

The rules and the six 8x8 boards come from [noxio](https://github.com/thalkz/noxio).

- Tap one of your bacteria, then an empty cell:
  - any neighbouring cell, diagonals included: the bacterium **copies** itself;
  - exactly two cells away in a straight line (no diagonals): it **jumps** (over anything) and its old cell empties.
- Where it lands, it **converts** every enemy bacterium around it, diagonals included.
- **30 seconds per move**. Run out and you lose. If one of the first two moves isn't played in time, the game is aborted.
- When the player to move has no legal move, the game ends and every empty cell goes to the other player. The player with the most cells wins.

## Run it

```sh
docker compose up -d --build     # http://localhost:3000
```

Without Docker (needs Rust): `cargo run`. Tests: `cargo test`.
To run the tests through Docker:

```sh
docker run --rm -v "$PWD":/app -w /app rust:1 cargo test
```

`PORT` sets the listening port (default `3000`).

## Deploy on a VPS

On the server:

```sh
git clone <repo> bacteria && cd bacteria
docker compose up -d --build
```

Put a reverse proxy in front for HTTPS. With Caddy, which also forwards WebSockets:

```
bacteria.example.com {
    reverse_proxy localhost:3000
}
```

With nginx, forward the WebSocket upgrade on `/ws/`:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

To build on a Mac for an x86 VPS: `docker buildx build --platform linux/amd64 -t bacteria .`

## How it works

```
src/game.rs    rules: moves, conversions, end of game
src/ai.rs      computer opponent (greedy / 2-ply / timed alpha-beta)
src/maps.rs    the six 8x8 boards from noxio
src/room.rs    rooms, seats, move clock, rematches (all in memory)
src/main.rs    HTTP + WebSocket server (axum)
static/        the page: vanilla JS, no build step, embedded in the binary
```

The server is authoritative. The browser animates your move right away and the server confirms it.
Games live in memory: restarting the server ends them. Idle rooms are dropped after 30 minutes.
Each player gets a token stored in `localStorage`, so reloading the page keeps your seat.
To test online play on one computer, open the invite link in a private window or another browser.
