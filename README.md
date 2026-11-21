# QR Maker v2 – cloud-based QR code generator

Live demo: https://qr-cloud-l07z.onrender.com

## Architecture
Browser → Express REST API (Node.js, Docker, Render) → PostgreSQL (Neon cloud database)

| Layer      | Tech                               |
|------------|------------------------------------|
| Frontend   | HTML, CSS, JavaScript              |
| Backend    | Node.js + Express, JWT login, bcrypt password hashing |
| Database   | PostgreSQL on Neon (managed, cloud) |
| Packaging  | Docker                             |
| CI/CD      | GitHub Actions runs tests; Render deploys when they pass |

## What's new in v2
- SQLite replaced by managed PostgreSQL, so data survives server restarts
- User accounts (register/login), passwords hashed with bcrypt, JWT sessions
- Each user can only see and delete their own QR codes
- Rate limiting on login and registration
- Automated tests and a CI pipeline

## Run locally
```
export DATABASE_URL="your Neon connection string"
export JWT_SECRET="any long random text"
npm install
npm start     # http://localhost:3000
npm test
```

## Known limits / next steps
- Free-tier server sleeps when idle (about 1 minute to wake)
- Add scan analytics chart, caching, load testing and monitoring
