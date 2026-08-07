# ShopEase — Backend (CIS498 Capstone, Milestone 2)

A small-business e-commerce platform: customer storefront + merchant admin dashboard, split into
two separate front-end applications behind one shared login, backed by a REST API and a SQLite
database.

## Stack
- **Backend:** Node.js, Express, `node:sqlite` (Node's built-in SQLite module — no native build tools needed), bcryptjs (password hashing), jsonwebtoken (auth)
- **Frontend:** plain HTML/CSS/JS (in `/frontend`), calls the backend via `fetch`
- **Database:** SQLite, file-based (`shopease.db`), auto-created and seeded on first run

## Project structure
```
shopease-backend/
├── server.js                 # Express app + all API routes
├── db.js                     # DB connection, schema, seed data
├── test.js                   # API test script (run against the live server)
├── test-results.log          # saved output of the last full test run
├── API_DOCUMENTATION.md      # every endpoint + sample JSON in/out
├── DATABASE_DESIGN.md        # ER overview, table schema, design decisions
├── TEST_DOCUMENTATION.md     # test case table + results
└── frontend/
    ├── login.html             # shared login, routes by role
    ├── customer-app.html      # storefront + cart + checkout (customer only)
    ├── merchant-admin.html    # KPIs, inventory risk, orders (merchant only)
    └── shared.css
```

## Running it locally

**1. Install dependencies** (only needs Node 22+, no native compilers required):
```bash
npm install
```

**2. Start the backend:**
```bash
node server.js
```
This creates and seeds `shopease.db` automatically on first run, and starts the API at `http://localhost:3000`.

**3. Open the frontend:**
Open `frontend/login.html` directly in a browser (or serve the `frontend/` folder with any static file server). Log in with:
- Customer: `customer1` / `demo123`
- Merchant: `merchant1` / `demo123`

**4. Run the API test suite** (with the server still running, in a second terminal):
```bash
node test.js
```

## Demo accounts
| Username | Password | Role |
|---|---|---|
| customer1 | demo123 | customer |
| merchant1 | demo123 | merchant |

## Smart Advisor — optional real AI mode
The merchant dashboard's Smart Advisor (`GET /api/insights`) tries a real call to Anthropic's Claude API first, and automatically falls back to a deterministic rules engine if no key is configured, the call times out, or the response is malformed. The dashboard shows a badge indicating which one actually ran ("Live AI (Claude)" or "Rules engine").

To enable real AI mode, set an environment variable before starting the server:
```bash
export ANTHROPIC_API_KEY=your-key-here
node server.js
```
Without this variable set, everything still works — the endpoint just uses the rules engine, and the badge reflects that.

## Email verification, password reset — optional real email sending
Registration, resending a verification code, and forgot-password all try to send a real email first, and automatically fall back to **dev mode** (the code is returned directly in the API response and shown in a banner on the login page) if no email service is configured. Nothing breaks either way — this just controls whether you get a real email or a visible on-screen code.

To send real email via Gmail (the simplest option — no third-party service signup required):
1. Enable 2-Step Verification on the Gmail account you want to send from.
2. Create an **App Password**: Google Account → Security → 2-Step Verification → App passwords. Generate one for "Mail."
3. Set these environment variables before starting the server:
```bash
export SMTP_HOST=smtp.gmail.com
export SMTP_PORT=587
export SMTP_USER=youraddress@gmail.com
export SMTP_PASS=<the 16-character App Password, not your normal Gmail password>
export SMTP_FROM=youraddress@gmail.com
node server.js
```
Without these set, registration/reset still work end-to-end — the code just shows up in an orange "dev mode" banner in the UI instead of an inbox.

## Notes
- JWT secret is hardcoded for this demo (`JWT_SECRET` in `server.js`) — in production this would come from an environment variable.
- CORS is open (`app.use(cors())`) to simplify running the frontend as static files during development.
