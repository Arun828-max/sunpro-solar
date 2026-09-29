# SunPro Solar

A responsive solar installation, cleaning and maintenance booking website with customer accounts and a protected admin dashboard.

## Local VS Code setup

1. Open this **single `solarproj` folder** in VS Code.
2. Open Terminal.
3. Run:

```bash
npm install
npm start
```

Before starting the server, create a local `.env` file with `ADMIN_PASSWORD` and `SESSION_SECRET` set to long, unique random values. Keep `.env` private; it is ignored by Git.

4. Open `http://localhost:3000`.

### Admin

- Username: `admin` (or the value of `ADMIN_USERNAME`)
- Password: the value of `ADMIN_PASSWORD`
- Login: `http://localhost:3000/admin/login`

### Customer

- Signup: `http://localhost:3000/customer/signup`
- Login: `http://localhost:3000/customer/login`

## Database migration fix

The previous version attempted to add `bookingId` as a `UNIQUE` column with `ALTER TABLE`. SQLite rejects that operation. This version adds the column without `UNIQUE`, repairs missing/duplicate legacy IDs, and then creates a unique index. Database initialization also completes before the server handles requests.

## Render deployment

The project includes `render.yaml`.

For a manual Render Web Service use:

- Build command: `npm ci --omit=dev`
- Start command: `npm start`
- Health check path: `/health`

Set these environment variables in Render:

```text
NODE_ENV=production
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<a-long-random-password>
SESSION_SECRET=<a-long-random-secret>
```

Add SMTP, Twilio and Razorpay variables only if those services are being used.

### Important database note

The application currently uses SQLite. On Render, a normal ephemeral filesystem can lose SQLite data after a redeploy/restart. For a real production system with permanent customer and booking data, use a persistent Render disk or migrate the database to PostgreSQL before going live.

## Security note

Change `ADMIN_PASSWORD` before a public launch. Never commit `.env` or API keys to GitHub.
