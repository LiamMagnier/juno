import Foundation

/// One choice in a settings menu: the stored value, its label, and the
/// sentence the row shows under it once it is chosen.
public struct NativeSettingsChoice: Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let label: String
    public let description: String

    public init(id: String, label: String, description: String) {
        self.id = id
        self.label = label
        self.description = description
    }
}

// MARK: - Auto (Settings › Models)

/// What Auto weighs when it picks the model — `AUTO_PREFERENCE_OPTIONS` in
/// `src/components/settings/sections/models.tsx`, values from
/// `AUTO_PREFERENCES` in `src/lib/router/decide.ts`.
public enum NativeAutoPreference {
    /// `DEFAULT_AUTO_PREFERENCE`.
    public static let defaultValue = "balanced"

    public static let options: [NativeSettingsChoice] = [
        .init(
            id: "balanced",
            label: "Balanced",
            description: "Auto weighs the price of each answer against the chance it has to be asked again."
        ),
        .init(
            id: "quality",
            label: "Best answer",
            description: "Auto pays more for a better chance of getting it right the first time."
        ),
        .init(
            id: "economy",
            label: "Lowest cost",
            description: "Auto prefers cheaper models and accepts that some answers may need a retry."
        ),
    ]

    public static var values: [String] { options.map(\.id) }

    /// The stored value, or the default when none is stored or it is unknown
    /// (the web's `settings.autoPreference ?? DEFAULT_AUTO_PREFERENCE`).
    public static func resolved(_ stored: String?) -> String {
        guard let stored, values.contains(stored) else { return defaultValue }
        return stored
    }

    public static func option(for stored: String?) -> NativeSettingsChoice {
        let value = resolved(stored)
        return options.first { $0.id == value } ?? options[0]
    }
}

/// Which labs Auto may choose — `AUTO_BOUNDARY_OPTIONS` in `models.tsx`,
/// values from `AUTO_DATA_BOUNDARIES` in `src/lib/router/data-policy.ts`.
public enum NativeAutoDataBoundary {
    /// `DEFAULT_AUTO_DATA_BOUNDARY`.
    public static let defaultValue = "verified_no_training"

    public static let options: [NativeSettingsChoice] = [
        .init(
            id: "verified_no_training",
            label: "Any lab that doesn’t train on it",
            description: "Auto only uses labs whose published terms say they don’t train on what you send. Labs whose terms haven’t been checked are left out."
        ),
        .init(
            id: "exclude_prc",
            label: "Leave out China-based labs",
            description: "The same, and Auto never chooses a lab headquartered in China. You can still pick one yourself."
        ),
        .init(
            id: "eu_us_only",
            label: "EU and US labs only",
            description: "The same, and Auto only chooses labs based in the EU or the US."
        ),
    ]

    public static var values: [String] { options.map(\.id) }

    public static func resolved(_ stored: String?) -> String {
        guard let stored, values.contains(stored) else { return defaultValue }
        return stored
    }

    public static func option(for stored: String?) -> NativeSettingsChoice {
        let value = resolved(stored)
        return options.first { $0.id == value } ?? options[0]
    }
}

// MARK: - Voices (Settings › Voice)

/// The server text-to-speech engines (`TtsProvider` in `src/lib/voices.ts`).
public enum NativeTTSProvider: String, Equatable, Sendable, CaseIterable {
    case google
    case openai
    case elevenlabs
}

/// What the server said about its speech provider (`ttsProvider` beside the
/// settings in `GET /api/settings`).
public enum NativeTTSProviderStatus: Equatable, Sendable {
    /// Not answered yet, or a server that predates the field.
    case unknown
    /// The server answered `null`: no server speech is set up.
    case unavailable
    case provider(NativeTTSProvider)

    /// From the raw `ttsProvider` value; an unrecognised name is treated as a
    /// provider whose voices this build does not list.
    public init(serverValue: String?) {
        guard let serverValue else {
            self = .unavailable
            return
        }
        self = NativeTTSProvider(rawValue: serverValue).map(Self.provider) ?? .provider(.elevenlabs)
    }
}

/// `src/lib/voices.ts`, verbatim: OpenAI's voices, Gemini's, and the per
/// provider helpers the settings picker and the TTS route use.
public enum NativeVoiceCatalog {
    public static let openAIVoices: [NativeSettingsChoice] = [
        .init(id: "alloy", label: "Alloy", description: "Neutral and crisp"),
        .init(id: "echo", label: "Echo", description: "Even and measured"),
        .init(id: "fable", label: "Fable", description: "Bright and expressive"),
        .init(id: "onyx", label: "Onyx", description: "Low and steady"),
        .init(id: "nova", label: "Nova", description: "Rounded and friendly"),
        .init(id: "shimmer", label: "Shimmer", description: "Light and airy"),
        .init(id: "coral", label: "Coral", description: "Warm and lively"),
        .init(id: "verse", label: "Verse", description: "Animated and varied"),
        .init(id: "ballad", label: "Ballad", description: "Soft and unhurried"),
        .init(id: "ash", label: "Ash", description: "Firm and direct"),
        .init(id: "sage", label: "Sage", description: "Calm and level"),
        .init(id: "marin", label: "Marin", description: "Relaxed and conversational"),
        .init(id: "cedar", label: "Cedar", description: "Smooth and easy-going"),
    ]

    /// `DEFAULT_VOICE`.
    public static let defaultOpenAIVoice = "alloy"

    public static let geminiVoices: [NativeSettingsChoice] = [
        .init(id: "Zephyr", label: "Zephyr", description: "Bright and clear"),
        .init(id: "Puck", label: "Puck", description: "Upbeat and lively"),
        .init(id: "Charon", label: "Charon", description: "Informative and level"),
        .init(id: "Kore", label: "Kore", description: "Firm and assured"),
        .init(id: "Fenrir", label: "Fenrir", description: "Excitable and quick"),
        .init(id: "Leda", label: "Leda", description: "Light and fresh"),
        .init(id: "Orus", label: "Orus", description: "Firm and grounded"),
        .init(id: "Aoede", label: "Aoede", description: "Breezy and open"),
        .init(id: "Callirrhoe", label: "Callirrhoe", description: "Easy-going and relaxed"),
        .init(id: "Autonoe", label: "Autonoe", description: "Bright and articulate"),
        .init(id: "Enceladus", label: "Enceladus", description: "Breathy and soft"),
        .init(id: "Iapetus", label: "Iapetus", description: "Clear and direct"),
        .init(id: "Umbriel", label: "Umbriel", description: "Easy-going and warm"),
        .init(id: "Algieba", label: "Algieba", description: "Smooth and mellow"),
        .init(id: "Despina", label: "Despina", description: "Smooth and flowing"),
        .init(id: "Erinome", label: "Erinome", description: "Clear and precise"),
        .init(id: "Algenib", label: "Algenib", description: "Gravelly and textured"),
        .init(id: "Rasalgethi", label: "Rasalgethi", description: "Informative and steady"),
        .init(id: "Laomedeia", label: "Laomedeia", description: "Upbeat and bright"),
        .init(id: "Achernar", label: "Achernar", description: "Soft and gentle"),
        .init(id: "Alnilam", label: "Alnilam", description: "Firm and even"),
        .init(id: "Schedar", label: "Schedar", description: "Even and balanced"),
        .init(id: "Gacrux", label: "Gacrux", description: "Rich and seasoned"),
        .init(id: "Pulcherrima", label: "Pulcherrima", description: "Forward and confident"),
        .init(id: "Achird", label: "Achird", description: "Friendly and open"),
        .init(id: "Zubenelgenubi", label: "Zubenelgenubi", description: "Casual and loose"),
        .init(id: "Vindemiatrix", label: "Vindemiatrix", description: "Gentle and calm"),
        .init(id: "Sadachbia", label: "Sadachbia", description: "Lively and animated"),
        .init(id: "Sadaltager", label: "Sadaltager", description: "Knowledgeable and measured"),
        .init(id: "Sulafat", label: "Sulafat", description: "Warm and full"),
    ]

    /// `DEFAULT_GEMINI_VOICE`.
    public static let defaultGeminiVoice = "Kore"

    public static func isOpenAIVoice(_ id: String?) -> Bool {
        guard let id else { return false }
        return openAIVoices.contains { $0.id == id }
    }

    public static func isGeminiVoice(_ id: String?) -> Bool {
        guard let id else { return false }
        return geminiVoices.contains { $0.id == id }
    }

    /// `voicesFor`: empty for ElevenLabs, whose ids are account-specific.
    public static func voices(for provider: NativeTTSProvider?) -> [NativeSettingsChoice] {
        switch provider {
        case .google: geminiVoices
        case .openai: openAIVoices
        case .elevenlabs, nil: []
        }
    }

    /// `defaultVoiceFor`.
    public static func defaultVoice(for provider: NativeTTSProvider?) -> String? {
        switch provider {
        case .google: defaultGeminiVoice
        case .openai: defaultOpenAIVoice
        case .elevenlabs, nil: nil
        }
    }

    /// `vetVoiceForProvider`: the saved voice narrowed to what `provider` can
    /// use; nil means "the provider's own default".
    public static func vetVoice(_ voiceID: String?, for provider: NativeTTSProvider) -> String? {
        guard let voiceID, !voiceID.isEmpty else { return nil }
        switch provider {
        case .google: return isGeminiVoice(voiceID) ? voiceID : nil
        case .openai: return isOpenAIVoice(voiceID) ? voiceID : nil
        case .elevenlabs: return isOpenAIVoice(voiceID) || isGeminiVoice(voiceID) ? nil : voiceID
        }
    }

    /// The voices the picker offers for what the server said. A server that
    /// has not said (older, or not loaded yet) keeps OpenAI's list, which is
    /// what every native build listed before the provider was known.
    public static func voices(for status: NativeTTSProviderStatus) -> [NativeSettingsChoice] {
        switch status {
        case .unknown: openAIVoices
        case .unavailable: []
        case .provider(let provider): voices(for: provider)
        }
    }

    public static func defaultVoice(for status: NativeTTSProviderStatus) -> String? {
        switch status {
        case .unknown: defaultOpenAIVoice
        case .unavailable: nil
        case .provider(let provider): defaultVoice(for: provider)
        }
    }

    /// The voice the picker shows as chosen, as `sections/voice.tsx` picks it:
    /// the saved voice when this provider lists it, else the provider's
    /// default, else its first voice. A saved voice from the other provider is
    /// never sent to this one, so the default is what will actually be heard.
    public static func selectedVoice(
        saved voiceID: String?,
        for status: NativeTTSProviderStatus
    ) -> NativeSettingsChoice? {
        let voices = voices(for: status)
        let fallback = defaultVoice(for: status)
        return voices.first { $0.id == voiceID }
            ?? voices.first { $0.id == fallback }
            ?? voices.first
    }

    /// The row's sentence when there is no picker (the web's wording, with
    /// "browser" read as this device's own voice).
    public static func unavailableDescription(for status: NativeTTSProviderStatus) -> String {
        switch status {
        case .unavailable: "Answers are read in this device’s built-in voice on this server."
        default: "This server’s speech provider uses its own voice."
        }
    }
}
