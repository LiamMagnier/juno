import type { DocumentQuoteLocation, QuoteRegion } from "@/lib/quote-context";

/** What the viewer hands the chat when the person asks about part of a file. */
export type DocumentAsk =
  | {
      kind: "text";
      /** `explain` sends at once with a stock request; `ask` fills the composer. */
      intent: "ask" | "explain";
      text: string;
      location?: DocumentQuoteLocation;
    }
  | {
      kind: "area";
      intent: "ask";
      /** Whatever the page's text layer held inside the rectangle — often nothing. */
      text: string;
      location?: DocumentQuoteLocation;
      region: QuoteRegion;
      /** The crop, as a PNG, sized for a model to read. */
      image: Blob;
    };

/** A rectangle the person drew, as the view reports it up to the shell. */
export interface AreaSelection {
  location?: DocumentQuoteLocation;
  region: QuoteRegion;
  text: string;
  /** Where on screen the rectangle is, for placing its toolbar. */
  anchor: { top: number; bottom: number; left: number; width: number };
  crop: () => Promise<Blob | null>;
}

/** Find state a view reports: how many matches, which one is current. */
export interface FindStatus {
  count: number;
  /** 0-based; -1 when there are none. */
  active: number;
  /** Still counting — pages whose text has not been read yet. */
  pending: boolean;
}

/** A request to step through matches. The nonce makes "next" twice two steps. */
export interface FindCommand {
  query: string;
  index: number;
  nonce: number;
}

export type Tool = "text" | "area";
