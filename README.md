# Buy-In Board

A live $20 buy-in tracker for home poker games. Anyone can create a table and get a 5-character code. Players join with the code and their name. Only the host who created the table can add buy-ins, rename the table or end the game. Everyone at the table sees the totals update live.

There are no accounts. Each browser gets a random secret key that's saved in that browser, and the server uses it to tell who the host is. If you clear your site data, or open the page in a different browser, you won't be recognized as the host anymore.

## Run it on your computer

```sh
npm install
npm start
```

Open http://localhost:3000. To test from a phone on the same Wi-Fi, use your computer's local IP address instead, for example `http://192.168.1.20:3000`.

## Put it on the web

The server is a single Node process (Node 18 or newer). It saves tables to `data/tables.json`, so whichever host you use needs a disk that's kept between restarts.

Example using [Render](https://render.com):

1. Push this folder to a GitHub repository.
2. In Render, create a new **Web Service** from that repository.
3. Set the build command to `npm install` and the start command to `npm start`.
4. Add a **persistent disk** mounted at `/var/data`, and set the environment variable `DATA_DIR=/var/data`.

Render sets `PORT` for you. Other hosts that run a Node server and support WebSockets (Railway, Fly.io, a VPS) work the same way.

Run only one copy of the server, because each running copy keeps its own list of tables. A table is deleted 30 days after its last change.

## Files

- `server.js`: serves the page, stores the tables and enforces the host-only rules
- `public/index.html`: the page layout and styles
- `public/app.js`: the browser code that talks to the server
