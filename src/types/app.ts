import type { ClientConversation, ClientQuota } from "@/types/chat";
import type { Provider } from "@/lib/providers";

export interface AppUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

export interface ClientFolder {
  id: string;
  name: string;
}

export interface ClientSettings {
  theme: "light" | "dark" | "system";
  accent: string;
  defaultModel: string;
  customInstructions: string;
  responseLanguage: string;
  memoryEnabled: boolean;
  voiceId: string | null;
  favoriteModels: string[];
}

export interface AppBootstrap {
  user: AppUser;
  settings: ClientSettings;
  quota: ClientQuota;
  conversations: ClientConversation[];
  folders: ClientFolder[];
  features: {
    billing: boolean;
    voiceServer: boolean;
    storage: boolean;
    webSearch: boolean;
    providers: Provider[];
    isOwner: boolean;
  };
}
