import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import mongoose from "mongoose";
import pkg from "pg";

const { Client } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

/* ===============================
   MongoDB (WRITE - website data)
================================ */
await mongoose.connect(process.env.MONGO_URL);

const User = mongoose.model(
  "User",
  new mongoose.Schema({
    discordId: { type: String, unique: true },
    username: String,
    avatar: String,
    lastLogin: Date
  })
);

/* ==========================================
   PostgreSQL / CockroachDB (READ ONLY)
========================================== */
const pg = new Client({
  connectionString: process.env.COCKROACH_URL,
  ssl: { rejectUnauthorized: false }
});
await pg.connect();

/* ===============================
   Discord OAuth
================================ */
app.get("/auth/discord", (req, res) => {
  const url =
    `https://discord.com/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.DISCORD_REDIRECT)}` +
    `&response_type=code&scope=identify guilds`;

  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  const code = req.query.code;

  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.DISCORD_REDIRECT
    })
  });

  const token = await tokenRes.json();

  const user = await (await fetch(
    "https://discord.com/api/users/@me",
    { headers: { Authorization: `Bearer ${token.access_token}` } }
  )).json();

  await User.findOneAndUpdate(
    { discordId: user.id },
    {
      username: user.username,
      avatar: user.avatar,
      lastLogin: new Date()
    },
    { upsert: true }
  );

  res.send("Discord login successful. Backend is working.");
});

/* ===============================
   Escrow Stats API (READ ONLY)
================================ */
app.get("/api/stats/:guildId", async (req, res) => {
  const guildId = req.params.guildId;

  const total = await pg.query(
    "SELECT COUNT(*) FROM escrows WHERE guild_id=$1",
    [guildId]
  );

  const balance = await pg.query(
    "SELECT COALESCE(SUM(amount),0) FROM escrows WHERE guild_id=$1 AND status='paid'",
    [guildId]
  );

  const chart = await pg.query(
    `SELECT DATE(created_at) AS day, SUM(amount) AS total
     FROM escrows
     WHERE guild_id=$1 AND status='paid'
     GROUP BY day
     ORDER BY day DESC
     LIMIT 7`,
    [guildId]
  );

  res.json({
    total: total.rows[0].count,
    balance: balance.rows[0].coalesce,
    chart: chart.rows.reverse()
  });
});

/* ===============================
   Start server
================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Backend running on port", PORT);
});
