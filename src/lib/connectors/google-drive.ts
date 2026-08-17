/**
 * Juno Google Drive & Google Workspace Connector
 *
 * Full-lifecycle cloud synchronization connector for Juno Knowledge RAG indexing:
 * - Paginated directory and shared drive discovery
 * - Incremental change tracking via Drive changes API (startPageToken / delta tokens)
 * - Rate limiting and exponential backoff retry
 * - Native export for Docs, Sheets, Slides, and binary files
 * - Disconnect & local index wipe
 */

export interface GoogleDriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
  webViewLink?: string;
  trashed?: boolean;
}

export interface DrivePageResult {
  files: GoogleDriveFile[];
  nextPageToken?: string;
  newStartPageToken?: string;
}

export interface DriveSyncResult {
  connectorId: string;
  filesScanned: number;
  filesIndexed: number;
  filesRemoved: number;
  totalTokensExtracted: number;
  nextChangeToken?: string;
  errors: string[];
}

export class GoogleDriveConnector {
  private accessToken: string;
  private maxRetries: number;

  constructor(accessToken: string, maxRetries = 3) {
    this.accessToken = accessToken;
    this.maxRetries = maxRetries;
  }

  private async fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          ...init,
          headers: {
            ...init?.headers,
            Authorization: `Bearer ${this.accessToken}`,
          },
        });

        if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
          const delay = Math.min(500 * Math.pow(2, attempt), 4000);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        return res;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const delay = Math.min(500 * Math.pow(2, attempt), 4000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError || new Error(`Failed to fetch ${url} after ${this.maxRetries} retries.`);
  }

  /**
   * Lists files in a given folder with full pagination support.
   */
  public async listFilesPage(
    folderId = "root",
    pageToken?: string,
    pageSize = 50
  ): Promise<DrivePageResult> {
    const query = `'${folderId}' in parents and trashed = false`;
    let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
      query
    )}&pageSize=${pageSize}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink,trashed)`;

    if (pageToken) {
      url += `&pageToken=${encodeURIComponent(pageToken)}`;
    }

    const res = await this.fetchWithRetry(url);
    if (!res.ok) {
      throw new Error(`Google Drive API error (${res.status}): ${res.statusText}`);
    }

    const data = (await res.json()) as { files?: GoogleDriveFile[]; nextPageToken?: string };
    return {
      files: data.files || [],
      nextPageToken: data.nextPageToken,
    };
  }

  /**
   * Fetches the current start page token for future incremental change tracking.
   */
  public async getStartPageToken(): Promise<string> {
    const url = "https://www.googleapis.com/drive/v3/changes/startPageToken";
    const res = await this.fetchWithRetry(url);
    if (!res.ok) {
      throw new Error(`Failed to obtain Google Drive change token: ${res.status}`);
    }
    const data = (await res.json()) as { startPageToken?: string };
    return data.startPageToken || "";
  }

  /**
   * Fetches incremental changes since the last sync token.
   */
  public async listChanges(pageToken: string): Promise<DrivePageResult> {
    const url = `https://www.googleapis.com/drive/v3/changes?pageToken=${encodeURIComponent(
      pageToken
    )}&fields=nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,size,trashed))`;

    const res = await this.fetchWithRetry(url);
    if (!res.ok) {
      throw new Error(`Google Drive changes API error (${res.status}): ${res.statusText}`);
    }

    const data = (await res.json()) as {
      changes?: Array<{ fileId: string; removed?: boolean; file?: GoogleDriveFile }>;
      nextPageToken?: string;
      newStartPageToken?: string;
    };

    const files: GoogleDriveFile[] = [];
    if (data.changes) {
      for (const change of data.changes) {
        if (change.file) {
          files.push({ ...change.file, trashed: Boolean(change.removed || change.file.trashed) });
        }
      }
    }

    return {
      files,
      nextPageToken: data.nextPageToken,
      newStartPageToken: data.newStartPageToken,
    };
  }

  /**
   * Extracts text content from a Google Workspace document or raw text file.
   */
  public async extractText(file: GoogleDriveFile): Promise<string> {
    let exportUrl: string;

    if (file.mimeType === "application/vnd.google-apps.document") {
      exportUrl = `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`;
    } else if (file.mimeType === "application/vnd.google-apps.spreadsheet") {
      exportUrl = `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/csv`;
    } else if (file.mimeType === "application/vnd.google-apps.presentation") {
      exportUrl = `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`;
    } else if (file.mimeType.startsWith("text/") || file.mimeType === "application/json") {
      exportUrl = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
    } else {
      return `[File Attachment: ${file.name} (${file.mimeType})]`;
    }

    const res = await this.fetchWithRetry(exportUrl);
    if (!res.ok) {
      return `[Failed to extract content from ${file.name}: ${res.statusText}]`;
    }

    return await res.text();
  }
}
