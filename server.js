// server.js — ready for Vercel deployment
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import cors from "cors";
import { google } from "googleapis";
import { parseBuffer } from "music-metadata";
import { Buffer } from "buffer";

dotenv.config();
const app = express();

// ⚠️ Vercel automatically sets PORT=3000 internally
const PORT = process.env.PORT || 3000;

app.use(
  cors({
    origin: [
      "http://localhost:8081",
      "http://localhost:19006",
      "http://localhost:3000",
      "https://your-frontend-domain.vercel.app", // ✅ add your app domain here if needed
    ],
    credentials: true,
  })
);

app.use(express.json());

const oAuth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

if (process.env.REFRESH_TOKEN) {
  oAuth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });
}

async function refreshAccessTokenIfNeeded() {
  const tokenRes = await oAuth2Client.getAccessToken();
  const token = tokenRes?.token;
  if (!token) throw new Error("Could not obtain access token");
  return token;
}

async function extractThumbnailFromDriveFile(fileId, accessToken) {
  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Range: "bytes=0-200000",
        },
      }
    );

    if (!res.ok) {
      console.warn("Drive media request failed for thumbnail:", res.status);
      return null;
    }

    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    const metadata = await parseBuffer(buffer, "audio/mpeg");
    const picture = metadata.common?.picture?.[0];
    if (picture?.data) {
      const base64 = Buffer.from(picture.data).toString("base64");
      const mime = picture.format || "image/jpeg";
      return `data:${mime};base64,${base64}`;
    }
  } catch (err) {
    console.warn(`⚠️ Thumbnail extraction failed for ${fileId}: ${err.message}`);
  }
  return null;
}

app.get("/api/music", async (req, res) => {
  const folderId = req.query.folderId || "1fE94d9OkuR7IzfpjRGe6aRxg2duIgSTQ";
  try {
    const accessToken = await refreshAccessTokenIfNeeded();
    const q = `'${folderId}' in parents and mimeType contains 'audio/'`;
    const fields = "files(id,name,mimeType)";

    const apiUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
      q
    )}&fields=${encodeURIComponent(fields)}&supportsAllDrives=true&includeItemsFromAllDrives=true`;

    const driveRes = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const text = await driveRes.text();
    if (!driveRes.ok) {
      console.error("Google Drive responded with error:", text);
      return res.status(driveRes.status).send(text);
    }

    const data = JSON.parse(text);
    const files = data.files || [];

    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : `http://localhost:${PORT}`;

    const songsWithThumbs = await Promise.all(
      files.map(async (file) => {
        const thumb = await extractThumbnailFromDriveFile(file.id, accessToken);
        return {
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          thumbnail: thumb,
          url: `${baseUrl}/proxy?fileId=${file.id}`,
        };
      })
    );

    res.json({ files: songsWithThumbs });
  } catch (err) {
    console.error("/api/music error:", err);
    res.status(500).json({ error: "Failed to fetch songs", details: String(err) });
  }
});

app.get("/proxy", async (req, res) => {
  try {
    const { fileId } = req.query;
    if (!fileId) return res.status(400).json({ error: "Missing fileId" });

    const accessToken = await refreshAccessTokenIfNeeded();
    const targetUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

    const proxied = await fetch(targetUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    res.status(proxied.status);
    proxied.headers.forEach((value, name) => {
      if (
        ["content-type", "content-length", "accept-ranges", "content-range"].includes(
          name.toLowerCase()
        )
      ) {
        res.setHeader(name, value);
      }
    });

    if (proxied.body && typeof proxied.body.pipe === "function") {
      proxied.body.pipe(res);
    } else {
      const text = await proxied.text();
      res.send(text);
    }
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ error: "Proxy failed", details: String(err) });
  }
});

app.get("/thumbnail/:fileId", async (req, res) => {
  try {
    const accessToken = await refreshAccessTokenIfNeeded();
    const thumb = await extractThumbnailFromDriveFile(req.params.fileId, accessToken);
    if (!thumb) return res.status(404).send("No thumbnail found");

    const base64Data = thumb.split(",")[1];
    const mime = thumb.match(/^data:(.*?);/)[1];
    const imgBuffer = Buffer.from(base64Data, "base64");
    res.set("Content-Type", mime);
    res.send(imgBuffer);
  } catch (err) {
    console.error("Thumbnail route error:", err);
    res.status(500).send("Failed to load thumbnail");
  }
});

// ✅ Only listen locally, export for Vercel
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
}
export default app;
