import Foundation
import JunoStorage
import Testing
@testable import JunoChatKit

/// Settings › Models › Auto and Settings › Voice: the choices mirrored from
/// `models.tsx` and `src/lib/voices.ts`, and the settings fields behind them.
@Suite struct NativeSettingsChoicesTests {
    // MARK: Voice catalogue

    @Test func eachProviderListsItsOwnVoices() {
        let openai = NativeVoiceCatalog.voices(for: NativeTTSProvider.openai)
        let google = NativeVoiceCatalog.voices(for: NativeTTSProvider.google)
        #expect(openai.count == 13)
        #expect(openai.first == NativeSettingsChoice(id: "alloy", label: "Alloy", description: "Neutral and crisp"))
        #expect(openai.last?.id == "cedar")
        #expect(google.count == 30)
        #expect(google.prefix(4).map(\.id) == ["Zephyr", "Puck", "Charon", "Kore"])
        #expect(google.first { $0.id == "Kore" }?.description == "Firm and assured")
        #expect(google.last?.id == "Sulafat")
        #expect(NativeVoiceCatalog.voices(for: NativeTTSProvider.elevenlabs).isEmpty)
        #expect(NativeVoiceCatalog.voices(for: nil as NativeTTSProvider?).isEmpty)
        // No id is shared between the two providers.
        #expect(Set(openai.map(\.id)).isDisjoint(with: google.map(\.id)))
    }

    @Test func eachProviderHasTheWebsDefault() {
        #expect(NativeVoiceCatalog.defaultVoice(for: NativeTTSProvider.openai) == "alloy")
        #expect(NativeVoiceCatalog.defaultVoice(for: NativeTTSProvider.google) == "Kore")
        #expect(NativeVoiceCatalog.defaultVoice(for: NativeTTSProvider.elevenlabs) == nil)
    }

    @Test func aSavedVoiceFromTheOtherProviderShowsThisProvidersDefault() {
        let google = NativeTTSProviderStatus.provider(.google)
        #expect(NativeVoiceCatalog.selectedVoice(saved: "Puck", for: google)?.id == "Puck")
        #expect(NativeVoiceCatalog.selectedVoice(saved: "nova", for: google)?.id == "Kore")
        #expect(NativeVoiceCatalog.selectedVoice(saved: nil, for: google)?.id == "Kore")
        let openai = NativeTTSProviderStatus.provider(.openai)
        #expect(NativeVoiceCatalog.selectedVoice(saved: "Kore", for: openai)?.id == "alloy")
        #expect(NativeVoiceCatalog.selectedVoice(saved: "sage", for: openai)?.id == "sage")
        #expect(NativeVoiceCatalog.selectedVoice(saved: "sage", for: .provider(.elevenlabs)) == nil)
        #expect(NativeVoiceCatalog.selectedVoice(saved: "sage", for: .unavailable) == nil)
        // An older server that never says keeps OpenAI's list.
        #expect(NativeVoiceCatalog.selectedVoice(saved: "sage", for: .unknown)?.id == "sage")
    }

    @Test func vettingMirrorsVetVoiceForProvider() {
        #expect(NativeVoiceCatalog.vetVoice("Kore", for: .google) == "Kore")
        #expect(NativeVoiceCatalog.vetVoice("alloy", for: .google) == nil)
        #expect(NativeVoiceCatalog.vetVoice("alloy", for: .openai) == "alloy")
        #expect(NativeVoiceCatalog.vetVoice("Kore", for: .openai) == nil)
        #expect(NativeVoiceCatalog.vetVoice("21m00Tcm4TlvDq8ikWAM", for: .elevenlabs) == "21m00Tcm4TlvDq8ikWAM")
        #expect(NativeVoiceCatalog.vetVoice("alloy", for: .elevenlabs) == nil)
        #expect(NativeVoiceCatalog.vetVoice(nil, for: .openai) == nil)
        #expect(NativeVoiceCatalog.vetVoice("", for: .elevenlabs) == nil)
    }

    @Test func theServersProviderValueIsRead() {
        #expect(NativeTTSProviderStatus(serverValue: "google") == .provider(.google))
        #expect(NativeTTSProviderStatus(serverValue: "openai") == .provider(.openai))
        #expect(NativeTTSProviderStatus(serverValue: nil) == .unavailable)
    }

    // MARK: Auto choices

    @Test func autoChoicesMirrorTheWeb() {
        #expect(NativeAutoPreference.values == ["balanced", "quality", "economy"])
        #expect(NativeAutoPreference.options.map(\.label) == ["Balanced", "Best answer", "Lowest cost"])
        #expect(NativeAutoPreference.resolved(nil) == "balanced")
        #expect(NativeAutoPreference.resolved("nonsense") == "balanced")
        #expect(NativeAutoPreference.option(for: "economy").label == "Lowest cost")
        #expect(NativeAutoDataBoundary.values == ["verified_no_training", "exclude_prc", "eu_us_only"])
        #expect(NativeAutoDataBoundary.resolved(nil) == "verified_no_training")
        #expect(NativeAutoDataBoundary.option(for: "eu_us_only").label == "EU and US labs only")
    }

    // MARK: Settings fields

    @Test func autoFieldsGoDirectToPatch() throws {
        let patch = NativeSettingsPatch(autoPreference: "quality", autoDataBoundary: "exclude_prc")
        #expect(patch.syncedFieldNames.isEmpty, "the strict sync schema refuses them")
        #expect(patch.directFieldNames == ["autoPreference", "autoDataBoundary"])
        let body = try #require(try patch.directBody())
        #expect(String(data: body, encoding: .utf8)
            == #"{"autoDataBoundary":"exclude_prc","autoPreference":"quality"}"#)
    }

    @Test func autoFieldsApplyToARecordAndRefuseUnknownValues() throws {
        var settings = Self.settings()
        #expect(settings.autoPreference == nil)
        try NativeMemorySettingsStore<InMemoryTransactionalStore>.applyDirectFields(
            ["autoPreference": "economy", "autoDataBoundary": "eu_us_only"],
            to: &settings
        )
        #expect(settings.autoPreference == "economy")
        #expect(settings.autoDataBoundary == "eu_us_only")
        #expect(throws: NativeMemorySettingsError.self) {
            try NativeMemorySettingsStore<InMemoryTransactionalStore>.applyDirectFields(
                ["autoPreference": "fastest"],
                to: &settings
            )
        }
    }

    @Test func theSettingsRouteBodyCarriesAutoAndTheSpeechProvider() throws {
        let body = Data("""
        {"settings":{"customInstructions":"","memoryEnabled":true,"autoPreference":"quality",
         "autoDataBoundary":"exclude_prc","monthlySpendCapEur":null},"ttsProvider":"google"}
        """.utf8)
        let fetched = try NativeServerSettingsClient.decode(body)
        #expect(fetched.autoPreference == "quality")
        #expect(fetched.autoDataBoundary == "exclude_prc")
        #expect(fetched.ttsProvider == .provider(.google))
        #expect(fetched.overlay["autoPreference"] as? String == "quality")
        #expect(fetched.overlay["autoDataBoundary"] as? String == "exclude_prc")
    }

    @Test func aNullProviderIsNoServerSpeechAndAMissingOneIsUnknown() throws {
        let none = try NativeServerSettingsClient.decode(Data(#"{"settings":{},"ttsProvider":null}"#.utf8))
        #expect(none.ttsProvider == .unavailable)
        let older = try NativeServerSettingsClient.decode(Data(#"{"settings":{"autoPreference":"turbo"}}"#.utf8))
        #expect(older.ttsProvider == .unknown)
        #expect(older.overlay["autoPreference"] == nil, "an unknown value is left out, not applied")
    }

    static func settings() -> NativeAccountSettings {
        NativeAccountSettings(
            id: "settings-1", theme: .system, accent: "coral", defaultModel: "auto",
            customInstructions: "", responseLanguage: "auto", interfaceLocale: "auto",
            personality: "default", memoryEnabled: true, voiceID: nil, favoriteModels: [],
            emailBudgetAlerts: true, emailWeeklyDigest: false,
            updatedAt: Date(timeIntervalSince1970: 1_790_000_000), revision: 1
        )
    }
}
