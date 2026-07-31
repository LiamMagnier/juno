/// The two pure inputs the composer aura is driven by: what colour a lab's
/// light is, and how much of it a thinking level earns.
///
/// This is the native half of `asAmbientLight`/`PROVIDER_GLOWS` in
/// `src/lib/provider-colors.ts` and of `reasoningGlow` in
/// `src/lib/model-metrics.ts`. Both are ported as arithmetic rather than as a
/// table of pre-computed results: the web derives its glows from the brand
/// hexes on purpose, so the mark colours stay the single source of truth, and a
/// transcribed `hsl(...)` string here would be a second palette free to drift
/// the first time a lab restyles.
public enum JunoProviderGlow {

    // MARK: - The lab's colour, as light

    /// The brands the bloom can be, as `0xRRGGBB`.
    ///
    /// These are `GLOW_SOURCES`, not `PROVIDER_ACCENTS`. A mark colour is right
    /// for a logo and useless for a glow: three of these labs brand in
    /// near-black, and black does not emit. So the flat ones carry a luminous
    /// stand-in the lab already uses elsewhere in its own product — OpenAI's
    /// green for `#111111`, Kimi's blue-violet for `#111827` — and xAI, which
    /// has no second colour, gets a cool steel that reads as its monochrome
    /// without pretending to be a brand value. Everything else is its real
    /// accent.
    private static let sources: [String: UInt32] = [
        "anthropic": 0xd9_78_59,
        // `#111111` as ink, OpenAI's green as light.
        "openai": 0x10_a3_7f,
        "google": 0x42_85_f4,
        "meta": 0x00_73_ff,
        "zhipu": 0x2f_66_ff,
        // `#111827` as ink, Kimi's blue-violet as light.
        "moonshot": 0x6a_5b_ff,
        "deepseek": 0x4f_7c_ff,
        "mistral": 0xff_8a_00,
        // `#0f0f0f` as ink; a cool steel stands in, see above.
        "xai": 0x8e_a3_c0,
        "seedance": 0x7c_3a_ed,
        "minimax": 0x18_a0_a0,
        "mimo": 0xff_6a_00,
        "qwen": 0x61_5c_ed,
        "longcat": 0xf5_a5_24,
    ]

    /// A brand colour turned into ambient light.
    ///
    /// A logo colour is meant to be seen at small size against a controlled
    /// background, so it is picked for punch — a mark's worth of pure hue.
    /// Spread it across a third of the screen as a wash and that same punch
    /// reads as a warning light. What a bloom wants is a lot of hue and very
    /// little chroma: enough to say "Gemini" or "Claude" without the page
    /// looking tinted by accident.
    ///
    /// So hue is kept exactly, saturation is cut to a bit over half and capped,
    /// and lightness is pulled two thirds of the way to a common mid. That last
    /// part matters more than it looks: fourteen brands sit anywhere from
    /// `#0f0f0f` to `#f5a524`, and without a shared lightness the same effort
    /// setting would read as a whisper for one lab and a floodlight for the
    /// next. Normalising it means the ladder means the same thing whichever
    /// model you are talking to, and the aura's own ramp — which takes lightness
    /// up at the core and down through the rim — does the rest.
    static func asAmbientLight(
        _ source: (h: Double, s: Double, l: Double)
    ) -> (h: Double, s: Double, l: Double) {
        (
            h: source.h,
            s: min(source.s * 0.56, 0.5),
            l: source.l + (0.52 - source.l) * 0.68
        )
    }

    /// The lab's light, or `nil` when the provider is one this client has never
    /// heard of. Pure, so the transform can be tested without a running app.
    public static func brandGlow(providerID: String) -> JunoColorToken? {
        guard let hex = sources[providerID.lowercased()] else { return nil }
        return JunoColorToken(hsl: asAmbientLight(hsl(hex: hex)))
    }

    /// The colour the composer aura should carry for a given model's lab.
    ///
    /// An unknown provider falls back to the account's own accent rather than to
    /// another lab's colour. That is not a native invention: the web's
    /// `--aura-tint: var(--aura-provider, hsl(var(--primary)))` already says a
    /// missing lab colour resolves to the accent, and it is the honest answer —
    /// painting a model Juno has not shipped support for in OpenAI's green
    /// claims something about it that nobody checked.
    ///
    /// `dark` picks which half of the accent pair the fallback uses; it is
    /// ignored for a known provider, whose glow is one value in both schemes
    /// exactly as it is on the web.
    @MainActor
    public static func glow(providerID: String, dark: Bool = false) -> JunoColorToken {
        brandGlow(providerID: providerID)
            ?? JunoColorToken(hsl: JunoAccentSelection.shared.current.hsl(dark: dark))
    }

    // MARK: - Hue, saturation, lightness

    /// Hue 0–360, saturation and lightness 0–1 — a straight port of the web's
    /// `hexToHsl`, kept here because the ambient-light transform is defined in
    /// those three numbers and nothing else in the design system converts *to*
    /// them (``JunoColorToken/init(hsl:)`` only goes the other way).
    static func hsl(hex: UInt32) -> (h: Double, s: Double, l: Double) {
        hsl(
            red: Double((hex >> 16) & 255) / 255,
            green: Double((hex >> 8) & 255) / 255,
            blue: Double(hex & 255) / 255
        )
    }

    static func hsl(
        red: Double,
        green: Double,
        blue: Double
    ) -> (h: Double, s: Double, l: Double) {
        let high = max(red, green, blue)
        let low = min(red, green, blue)
        let lightness = (high + low) / 2
        let delta = high - low
        guard delta > 0 else { return (h: 0, s: 0, l: lightness) }

        let saturation = lightness > 0.5
            ? delta / (2 - high - low)
            : delta / (high + low)
        let sixth: Double
        if high == red {
            sixth = ((green - blue) / delta + (green < blue ? 6 : 0)) / 6
        } else if high == green {
            sixth = ((blue - red) / delta + 2) / 6
        } else {
            sixth = ((red - green) / delta + 4) / 6
        }
        return (h: sixth * 360, s: saturation, l: lightness)
    }

    // MARK: - How hard it is thinking

    /// The six effort tiers, shallowest first.
    ///
    /// The mirror of `REASONING_TIERS`, and the glow below is indexed off it
    /// rather than written out as a table for the reason that file already
    /// gives: a parallel list of these literals drifted once before, and a new
    /// tier silently landing at the bottom of this ramp is exactly the kind of
    /// quiet wrongness that took 26 models to notice.
    ///
    /// Kept as strings rather than as an enum because the two products spell
    /// this differently — Chat's `NativeReasoningEffort` and Code's
    /// `ReasoningEffort` both live above the design system, so a third enum here
    /// would be the parallel list this comment is warning about. Both are
    /// `String`-backed, so both callers pass `effort?.rawValue`.
    public static let reasoningTiers = ["minimal", "low", "medium", "high", "xhigh", "max"]

    /// How much of the composer aura a given effort earns, 0…1 — 0 being the
    /// quietest bloom Juno draws and 1 the full one. Off is 0: the model is
    /// answering straight, and the light says so.
    public static func reasoningGlow(effort: String?) -> Double {
        guard let effort,
              let index = reasoningTiers.firstIndex(of: effort.lowercased())
        else { return 0 }
        return Double(index + 1) / Double(reasoningTiers.count)
    }

    /// What a model with no thinking control at all is worth: the middle of the
    /// ramp, matching the `--aura-think` property's own initial value.
    public static let unaskedThink: Double = 0.5

    /// The value to hand ``JunoComposerAura``, gate included.
    ///
    /// A model with no effort control is not "thinking at zero", it is a
    /// question the slider never asks, so those sit at the middle of the ramp
    /// instead of at the dimmest end — otherwise the page burns lowest for a
    /// model with no slider anywhere to explain why.
    ///
    /// `hasEffortControl` must be the test of whether a control is actually on
    /// screen, mirroring the composer's own gate. The obvious "does this model
    /// reason" is *not* that test, in two ways: eleven shipped models declare
    /// reasoning and expose no tiers, and Auto resolves with the full ladder
    /// while showing no slider at all.
    public static func auraThink(effort: String?, hasEffortControl: Bool) -> Double {
        hasEffortControl ? reasoningGlow(effort: effort) : unaskedThink
    }
}
