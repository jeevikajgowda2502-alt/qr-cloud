# QR Maker – cloud-based QR code generator

## Architecture
Browser (HTML/JS) → Express REST API (Node.js) → SQLite database.
Packaged as a Docker container so it runs on any cloud (AWS, Azure, GCP, Render, Railway).

| Layer     | Tech                    | Role                                       |
|-----------|-------------------------|--------------------------------------------|
| Frontend  | HTML/CSS/JS             | Form, live preview, history, downloads     |
| Backend   | Node.js + Express       | REST API, QR rendering (`qrcode`), redirects |
| Database  | SQLite (`better-sqlite3`) | Stores codes, colors, scan counts        |
| Packaging | Docker                  | Same container locally and in the cloud    |

## API
- `POST /api/qr` – create (`content`, `session`, `tracked`, `dark`, `light`)
- `GET /api/qr?session=ID` – history
- `GET /api/qr/:id/image.png|svg` – image (`?download=1` to save)
- `DELETE /api/qr/:id?session=ID`
- `GET /r/:id` – tracked redirect, increments scan count
- `GET /health` – health check

## Run locally
```
npm install
npm start          # http://localhost:3000
```

## Run with Docker
```
docker build -t qr-cloud .
docker run -p 8080:8080 -v qrdata:/data qr-cloud
```

## Deploy to the cloud
Set `BASE_URL` to your public URL (needed so tracked QR codes point to your server).
- **Render / Railway:** connect the GitHub repo, choose Docker, add a persistent disk mounted at `/data`.
  Without a disk the SQLite file resets on every redeploy.
- **AWS:** push the image to ECR and run on App Runner (or EC2 with Docker); mount an EFS/EBS volume at `/data`.
- **Azure:** Azure Container Apps or App Service for Containers with an Azure Files mount at `/data`.
- **GCP:** Cloud Run (use Cloud SQL or a mounted bucket, since Cloud Run's disk is ephemeral).

## Ideas to extend (good for marks)
- Swap SQLite for managed PostgreSQL (RDS / Cloud SQL / Supabase).
- Add user login (JWT) instead of the anonymous browser session.
- Add rate limiting and a CI/CD pipeline (GitHub Actions → deploy).
- Add logo-in-the-center QR codes and bulk generation from CSV.
