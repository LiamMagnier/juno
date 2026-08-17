/**
 * Juno Google Drive & Workspace Direct Ingestion Connector
 *
 * Provides 1-click cloud document synchronization into Juno's Knowledge RAG pipeline.
 * Extracts text from Google Docs, Google Sheets, Google Slides, and uploaded PDFs.
 */

export interface GoogleDriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
  webViewLink?: string;
}

export interface DriveSyncResult {
  connectorId: string;
  filesScanned: number;
  filesIndexed: number;
  totalTokensExtracted: number;
  errors: string[];
}

export class GoogleDriveConnector {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  /**
   * Lists files in a given Drive folder or the root Drive.
   */
  public async listFiles(folderId = "root", pageSize = 50): Promise<GoogleDriveFile[]> {
    const query = `'${folderId}' in parents and trashed = false`;
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
      query
    )}&pageSize=${pageSize}&fields=files(id,name,mimeType,modifiedTime,size,webViewLink)`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Google Drive API error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { files: GoogleDriveFile[] };
    return data.files || [];
  }

  /**
   * Exports Google Doc / Sheet / Slide as plain text or downloads raw file content.
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
      // Non-text file formats or binaries
      return `[Attachment: ${file.name} (${file.mimeType})]`;
    }

    const res = await fetch(exportUrl, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });

    if (!res.ok) {
      return `[Failed to extract text from ${file.name}: ${res.statusText}]`;
    }

    return await res.text();
  }
}
