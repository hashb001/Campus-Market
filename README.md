# Campus Market

A marketplace where **North South University** students buy, sell and exchange textbooks, hardware and study notes.

Anyone can browse. To post a listing you have to register with your `@northsouth.edu` email and confirm it with a 6-digit code sent to that inbox.

## Features

- **NSU-only accounts.** Registration only accepts `@northsouth.edu` addresses, verified by an emailed code. Codes are hashed, expire after 15 minutes, allow 5 attempts, and can be resent once a minute.
- **Listings.** Post an item to sell (with a price in ৳) or to exchange, with an optional photo. You can edit or remove only your own listings.
- **Browse.** Search, plus filters for Sell/Exchange, category and "My listings".
- **Live updates.** New, edited and removed listings show up for everyone right away (Socket.io).
- **Contact admins.** Anyone can message the admins. Admins (set with `ADMIN_EMAILS`) get an inbox with read/unread and delete, and can remove any listing.
- **Security.** Passwords hashed with bcrypt, sessions stored in MongoDB, rate limits on auth and contact, input checked on the server, user content escaped against XSS, uploads limited to image files.

## Project structure

```
backend/
  server.js      Express API, sessions, Socket.io; also serves the frontend
  models.js      Mongoose models (User, Listing, Image, Contact)
  mailer.js      Sends verification codes via Brevo or SMTP (prints them to the console if neither is set)
  .env.example   Configuration template
frontend/
  index.html, script.js, style.css
```

Images are stored in MongoDB, so they survive redeploys on hosts with temporary disks, such as Render.

## Running locally

Requirements: Node.js 18+ and a MongoDB database (local, or a free MongoDB Atlas cluster).

```bash
cd backend
cp .env.example .env      # then edit MONGO_URI and SESSION_SECRET
npm install
npm run dev
```

Open http://localhost:5000. If SMTP isn't configured, the verification code is printed in the terminal where the server runs.

## Deploying (Render)

1. Create a **Web Service** from this repo:
   - **Root directory:** `backend`
   - **Build command:** `npm install`
   - **Start command:** `npm start`
2. Add these environment variables:
   - `MONGO_URI`
   - `SESSION_SECRET`
   - `NODE_ENV=production`
   - `ADMIN_EMAILS`
   - the `SMTP_*` / `MAIL_FROM` values
3. The site and API are served from the same URL, so no CORS setup is needed.

### Sending email

**On Render's free plan, use Brevo.** Free plans block outgoing SMTP connections, so Gmail SMTP times out there.
1. Create a free account at brevo.com (300 emails/day).
2. Under **Senders**, add and verify the address you want to send from.
3. Under **SMTP & API → API Keys**, create an API key.
4. Set `BREVO_API_KEY` and `MAIL_FROM="Campus Market <that-address>"` on Render.

If `BREVO_API_KEY` is set it's used; otherwise SMTP is used if configured. Any SMTP provider works. With Gmail:
1. Turn on 2-Step Verification.
2. Create an **App Password**.
3. Set:
   - `SMTP_HOST=smtp.gmail.com`
   - `SMTP_PORT=465`
   - `SMTP_USER=<your gmail>`
   - `SMTP_PASS=<app password>`

## API overview

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/api/register` | public | Start sign-up (NSU email only), sends code |
| POST | `/api/verify` | public | Confirm code, logs in |
| POST | `/api/resend-code` | public | Send a new code |
| POST | `/api/login` / `/api/logout` | public | Session login/logout |
| GET | `/api/me` | user | Current user |
| GET | `/api/listings?search=&type=&category=&mine=1` | public | Browse listings |
| POST | `/api/listings` | verified user | Create listing (multipart, optional `image`) |
| PUT / DELETE | `/api/listings/:id` | owner or admin | Edit / remove |
| GET | `/api/images/:id` | public | Listing image |
| POST | `/api/contact` | public | Message the admins |
| GET / PATCH / DELETE | `/api/contact[/:id]` | admin | Admin inbox |
