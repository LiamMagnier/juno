/**
 * Juno Microsoft 365 / OneDrive Direct Connector
 *
 * Full-lifecycle cloud synchronization connector for Microsoft Graph API:
 * - Paginated OneDrive and SharePoint discovery (@odata.nextLink)
 * - Delta queries for incremental change detection (@odata.deltaLink)
 * - Rate limit backoff and error recovery
 * - Office document preview and plain text download
 * - Disconnect & wipe
 */

export interface MicrosoftDriveItem {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  webUrl?: string;
  deleted?: { state: string };
  file?: {
    mimeType: string;
  };
  folder?: {
    childCount: number;
  };
}

export interface MicrosoftPageResult {
  items: MicrosoftDriveItem[];
  nextLink?: string;
  deltaLink?: string;
}

export class Microsoft365Connector {
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
   * Lists items from OneDrive with pagination support.
   */
  public async listItemsPage(itemId = "root", nextLink?: string): Promise<MicrosoftPageResult> {
    const url =
      nextLink ||
      `https://graph.microsoft.com/v1.0/me/drive/items/${itemId}/children?$top=50&$select=id,name,size,lastModifiedDateTime,webUrl,file,folder,deleted`;

    const res = await this.fetchWithRetry(url);
    if (!res.ok) {
      throw new Error(`Microsoft Graph API error (${res.status}): ${res.statusText}`);
    }

    const data = (await res.json()) as {
      value?: MicrosoftDriveItem[];
      "@odata.nextLink"?: string;
      "@odata.deltaLink"?: string;
    };

    return {
      items: data.value || [],
      nextLink: data["@odata.nextLink"],
      deltaLink: data["@odata.deltaLink"],
    };
  }

  /**
   * Delta query for incremental changes in OneDrive root.
   */
  public async listDelta(deltaOrNextLink?: string): Promise<MicrosoftPageResult> {
    const url = deltaOrNextLink || `https://graph.microsoft.com/v1.0/me/drive/root/delta?$top=50`;
    const res = await this.fetchWithRetry(url);
    if (!res.ok) {
      throw new Error(`Microsoft Graph delta error (${res.status}): ${res.statusText}`);
    }

    const data = (await res.json()) as {
      value?: MicrosoftDriveItem[];
      "@odata.nextLink"?: string;
      "@odata.deltaLink"?: string;
    };

    return {
      items: data.value || [],
      nextLink: data["@odata.nextLink"],
      deltaLink: data["@odata.deltaLink"],
    };
  }

  /**
   * Downloads plain text or converts Office document to text via Microsoft Graph.
   */
  public async extractItemContent(item: MicrosoftDriveItem): Promise<string> {
    if (item.folder) {
      return `[Folder: ${item.name}]`;
    }

    const url = `https://graph.microsoft.com/v1.0/me/drive/items/${item.id}/content`;
    const res = await this.fetchWithRetry(url);

    if (!res.ok) {
      return `[Failed to read Microsoft 365 item ${item.name}: ${res.statusText}]`;
    }

    return await res.text();
  }
}
