# yuzu-smash

ELO ranking system for the Smash YUZU meetup Discord server. Players authenticate via Discord OAuth2, challenge each other, report match results, and earn RCoins through Ko-fi purchases.

## Stack

- Node.js / Express
- Nunjucks (HTML templates)
- Supabase (Postgres via REST API)
- Socket.IO (real-time updates)
- Discord OAuth2
- Ko-fi webhooks

## Project structure

```
yuzu-smash/
├── server.js
├── package.json
├── render.yaml
└── templates/
    ├── index.html
    ├── dashboard.html
    ├── match.html
    ├── ranking.html
    ├── player_profile.html
    ├── shop.html
    ├── wallet.html
    ├── redeem.html
    ├── admin_reports.html
    ├── admin_shop.html
    ├── banned.html
    └── not_member.html
```

## Environment variables

All required. The server will not start if any of the mandatory ones are missing.

| Variable | Required | Description |
|---|---|---|
| SECRET_KEY | yes | Express session secret |
| KOFI_VERIFICATION_TOKEN | yes | Ko-fi webhook verification token |
| DISCORD_CLIENT_SECRET | yes | Discord OAuth2 app secret |
| SUPABASE_URL | yes | Supabase project URL |
| SUPABASE_KEY | yes | Supabase service role key |
| REDIRECT_URI | yes | Discord OAuth2 redirect URI |
| ADMIN_DISCORD_ID | no | Discord ID of the admin account |
| PORT | no | Server port (default: 10000) |

## Running locally

```bash
npm install
```

Create a `.env` file with the variables listed above, then:

```bash
node server.js
```

The server will be available at http://localhost:10000.

## Deploying on Render

1. Push the project to a GitHub repository.
2. Create a new Web Service on Render, connect the repository.
3. Render will use `render.yaml` automatically.
4. Add all environment variables in the Render dashboard under Environment.
5. Set the Discord OAuth2 redirect URI in the Discord Developer Portal to match REDIRECT_URI.

## Discord OAuth2 setup

1. Go to https://discord.com/developers/applications and open your app.
2. Under OAuth2, add your redirect URI (e.g. https://yuzu-smash.onrender.com/callback).
3. Copy the Client Secret into the DISCORD_CLIENT_SECRET environment variable.

## Ko-fi webhook setup

1. In your Ko-fi settings, go to the API section.
2. Set the webhook URL to https://your-domain/webhook/kofi.
3. Copy the verification token into the KOFI_VERIFICATION_TOKEN environment variable.

## Supabase tables

The following tables are expected:

- players
- matches
- challenges
- kofi_transactions
- banners
- lfm_posts
- whatsup_posts

## Notes

- Discord access tokens are never stored. They are used once at login to fetch user data and then discarded.
- The Ko-fi redeem flow is claim-once: a transaction ID can only be used by one account.
- Dead matches (accepted but no result after 2h, or reported but unconfirmed after 30min) are resolved automatically every 5 minutes.
