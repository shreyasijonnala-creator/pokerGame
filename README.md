# Buy-In Board

A live $20 buy-in tracker for home poker games. Anyone can create a table and get a 5-character code. Players join with the code and their name, or the host can add them by name. Only the host who created the table can add buy-ins, rename the table or end the game. Everyone at the table sees the totals update live.

There are no accounts. Each browser gets a random secret key that's saved in that browser, and the server uses it to tell who the host is. If you clear your site data, or open the page in a different browser, you won't be recognized as the host anymore.

## Run it on your computer

```sh
npm install
npm start
```

Open http://localhost:3000. To test from a phone on the same Wi-Fi, use your computer's local IP address instead, for example `http://192.168.1.20:3000`.

## Put it on the web

The server is a single Node process (Node 18 or newer). Where it keeps tables:

- **With `DATABASE_URL` set**, tables are stored in that Postgres database. Use this on any host that wipes its disk on restart or redeploy, which includes Render's free plan.
- **Without it**, tables go in `data/tables.json` (or in `DATA_DIR` if you set it). That's fine on your own computer, but on a free host every table is lost whenever the server restarts.

### Render (free plan) with a free Neon database

1. Create a free database at [neon.tech](https://neon.tech). Copy its **connection string**, which looks like `postgresql://user:password@ep-something.neon.tech/neondb?sslmode=require`.
2. In Render, create a new **Web Service** from this GitHub repository.
3. Set the build command to `npm install` and the start command to `npm start`.
4. Under **Environment**, add `DATABASE_URL` and paste the connection string as its value.
5. Deploy. The log should say `tables saved to Postgres`.

The app creates its own database table the first time it runs. Render sets `PORT` for you.

Free Render servers go to sleep after about 15 minutes without visitors. The first visit afterwards takes up to a minute to wake the server, but tables aren't lost because they're in the database.

Other hosts that run a Node server and support WebSockets (Railway, Fly.io, a VPS) work the same way. Any Postgres database works, including Render's or Supabase's.

Run only one copy of the server, because each running copy keeps its own list of tables. A table is deleted 30 days after its last change.

## Files

- `server.js`: serves the page, stores the tables and enforces the host-only rules
- `public/index.html`: the page layout and styles
- `public/app.js`: the browser code that talks to the server
