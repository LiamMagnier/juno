declare module "@novnc/novnc" {
  export interface RFBOptions {
    shared?: boolean;
    credentials?: {
      username?: string;
      password?: string;
      target?: string;
    };
    repeaterID?: string;
    wsProtocols?: string | string[];
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RFBOptions);
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    dragViewport: boolean;
    showDotCursor: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    focus(): void;
    blur(): void;
    disconnect(): void;
    sendCredentials(credentials: { username?: string; password?: string; target?: string }): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    sendCtrlAltDel(): void;
    clipboardPasteFrom(text: string): void;
  }
}
