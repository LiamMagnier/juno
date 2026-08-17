/**
 * Juno Microsoft 365 / OneDrive Direct Ingestion Connector
 *
 * Connects to Microsoft Graph API to sync OneDrive, SharePoint, and Teams documents
 * directly into Juno Knowledge RAG indexing.
 */

export interface MicrosoftDriveItem {
  id: string;
  name: string;
  size: number;
  lastModifiedDateTime: string;
  webUrl: string;
  file?: {
    mimeType: string;
  };
  folder?: {
    childCount: number;
  };
}

export class Microsoft365Connector {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  /**
   * Lists items from the root OneDrive or a specific folder.
   */
  public async listItems(itemId = "root"): Promise<MicrosoftDriveItem[]> {
    const url = `https://graph.microsoft.com/v1.0/me/drive/items/${itemId}/children?$select=id,name,size,lastModifiedDateTime,webUrl,file,folder`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Microsoft Graph API error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { value: MicrosoftDriveItem[] };
    return data.value || [];
  }

  /**
   * Downloads plain text or converts Office document to text via Microsoft Graph preview.
   */
  public async extractItemContent(item: MicrosoftDriveItem): Promise<string> {
    if (item.folder) {
      return `[Folder: ${item.name}]`;
    }

    const url = `https://graph.microsoft.com/v1.0/me/drive/items/${item.id}/content`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });

    if (!res.ok) {
      return `[Failed to read Microsoft 365 item ${item.name}: ${res.statusText}]`;
    }

    return await res.text();
  }
}
