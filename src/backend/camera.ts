import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Database as BetterSqlite3Database, Statement } from 'better-sqlite3';
import type { Database } from './storage';
import { getAppDataPath } from '@shared/platform';
import type { CameraPhoto } from '@shared/types';

type CameraPhotoRow = {
  id: string;
  captured_at: string;
  file_path: string;
  file_url: string;
  subject: string | null;
  domain: string | null;
};

const DATA_URL_RE = /^data:(image\/png|image\/jpeg|image\/webp);base64,(.*)$/;

function inferExtension(mime: string) {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    default:
      return 'png';
  }
}

export class CameraService {
  private db: BetterSqlite3Database;
  private insertStmt: Statement;
  private listStmt: Statement;
  private getStmt: Statement;
  private deleteStmt: Statement;
  private baseDir: string;

  constructor(database: Database) {
    this.db = database.connection;
    this.insertStmt = this.db.prepare(
      'INSERT INTO camera_photos (id, captured_at, file_path, file_url, subject, domain) VALUES (?, ?, ?, ?, ?, ?)'
    );
    this.listStmt = this.db.prepare(
      'SELECT id, captured_at, file_path, file_url, subject, domain FROM camera_photos ORDER BY captured_at DESC LIMIT ?'
    );
    this.getStmt = this.db.prepare(
      'SELECT id, captured_at, file_path, file_url, subject, domain FROM camera_photos WHERE id = ?'
    );
    this.deleteStmt = this.db.prepare('DELETE FROM camera_photos WHERE id = ?');
    this.baseDir = path.join(getAppDataPath(), 'TimeWellSpent', 'camera');
  }

  async listPhotos(limit = 200): Promise<CameraPhoto[]> {
    const rows = this.listStmt.all(Math.max(1, Math.min(1000, Math.round(limit)))) as CameraPhotoRow[];
    return rows.map((row) => ({
      id: row.id,
      capturedAt: row.captured_at,
      filePath: row.file_path,
      fileUrl: row.file_url,
      subject: row.subject,
      domain: row.domain ?? null
    }));
  }

  async getPhoto(id: string): Promise<CameraPhoto | null> {
    const row = this.getStmt.get(id) as CameraPhotoRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      capturedAt: row.captured_at,
      filePath: row.file_path,
      fileUrl: row.file_url,
      subject: row.subject,
      domain: row.domain ?? null
    };
  }

  async storePhoto(payload: { dataUrl: string; subject?: string | null; domain?: string | null }): Promise<CameraPhoto> {
    const dataUrl = payload.dataUrl;
    const match = dataUrl.match(DATA_URL_RE);
    if (!match) {
      throw new Error('Invalid image payload');
    }
    const mime = match[1];
    const base64 = match[2];
    const ext = inferExtension(mime);
    const id = randomUUID();
    const capturedAt = new Date().toISOString();
    const dayKey = capturedAt.slice(0, 10);
    const dir = path.join(this.baseDir, dayKey);
    await fs.mkdir(dir, { recursive: true });
    const safeTimestamp = capturedAt.replace(/[:.]/g, '-');
    const filePath = path.join(dir, `${safeTimestamp}-${id}.${ext}`);
    const buffer = Buffer.from(base64, 'base64');
    await fs.writeFile(filePath, buffer);
    const fileUrl = pathToFileURL(filePath).toString();
    const subject = payload.subject?.trim() || null;
    const domain = payload.domain?.trim() || null;
    this.insertStmt.run(id, capturedAt, filePath, fileUrl, subject, domain);
    return { id, capturedAt, filePath, fileUrl, subject, domain };
  }

  async deletePhoto(id: string): Promise<void> {
    const existing = await this.getPhoto(id);
    if (existing?.filePath) {
      await fs.unlink(existing.filePath).catch(() => { });
    }
    this.deleteStmt.run(id);
  }
}
